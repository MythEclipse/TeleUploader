# This project does NOT deploy with Docker.
#
# Production is a pnpm build shipped to the VPS as a plain systemd service:
#
#     ExecStart=/usr/local/bin/bws-exec teleuploader /opt/teleuploader/bin/teleuploader
#       -> cd /var/lib/teleuploader
#       -> exec /usr/bin/node /opt/teleuploader/dist/index.js
#
# The path is `./deploy.sh` (invoked as `--no-build` from deploy.yml), not this
# file. There is no container, no registry and no compose stack anywhere in the
# production path — `docker-compose.yml` next door is retained for reference only.
#
# WHY THIS FILE EXISTS AT ALL
#
# It is a faithful Node/pnpm translation of a Dockerfile that described a Bun
# runtime this project no longer has (`oven/bun` images, `bun install`,
# `bun run build`, `CMD ["bun", …]`). It was kept solely so the container build is
# a working fallback if systemd is ever abandoned — and a stale image tag that
# fails at `docker build` time is not a fallback, it is a trap.
#
# WHAT CHANGED, AND WHY EACH PIECE IS REQUIRED
#
#   base image   oven/bun:*            -> node:24-alpine (the unit runs /usr/bin/node)
#   install      bun install           -> corepack enable && pnpm install --frozen-lockfile
#   build        bun run build         -> pnpm --filter filedrop run build
#   start        bun dist/index.js     -> node dist/index.js
#
# `--frozen-lockfile` is not optional here: CI installs with it too, so a
# Dockerfile that resolved ranges loosely could produce a bundle built from
# different dependency versions than the one that ships.
#
# `pnpm deploy` is NOT used. The bundle is self-contained (esbuild, `--bundle`),
# so shipping `dist/` alone is sufficient, and `pnpm deploy` would drag a
# resolved dependency tree in behind it for no runtime benefit.
#
# IF YOU RE-ACTIVATE THIS
#
# Three things the real deploy does that a bare container does not, and which are
# the reason a container was never the production path:
#
#   1. Migrations. `dist/migrate.js` + `apps/api/drizzle/` are applied before the
#      service restarts. This image ships the drizzle folder but never runs the
#      migrator, so a container started against a pre-P3a schema would
#      crash-loop on `buckets.organization_id`.
#   2. Seeding. `dist/seed.js` adopts S3_ACCESS_KEY/S3_SECRET_KEY into the
#      bootstrap organization. Skip it and /health answers 200 while every S3
#      client gets 403 — the S3 surface has no environment fallback.
#   3. WEB_DIST_PATH. The dashboard is only served when this points at a
#      directory containing index.html. Unset, `resolveSpaRoot()` returns null and
#      every SPA route 404s while the deploy still reports success.
#
# Run those three from wherever the environment lives (systemd uses
# bws-exec; a container would need an env_file or secrets mount) before treating
# a container as equivalent to the systemd unit.

FROM node:24-alpine AS builder

WORKDIR /usr/src/app

# corepack ships with Node 24 and provides the pnpm version pinned in the
# root package.json (packageManager: pnpm@10.33.2), so the container builds with
# the same package manager as CI and deploy.sh.
RUN corepack enable

# Dependency manifests first: this layer is cached until a lockfile actually
# changes, so source edits do not re-resolve the dependency tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# `--frozen-lockfile` matches CI exactly. Without it a drifted lockfile would be
# resolved silently here and never again.
RUN pnpm install --frozen-lockfile

# Source.
COPY apps ./apps
COPY scripts ./scripts

# esbuild emits dist/index.js, dist/migrate.js and dist/seed.js.
RUN pnpm --filter filedrop run build
RUN pnpm --filter @teleuploader/web run build

# ─── Runner ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /usr/src/app
ENV NODE_ENV=production

# The SPA is built here rather than in the builder only so `dist/web` sits beside
# `dist/index.js` — the layout deploy.sh installs and the one the systemd wrapper
# expects when WEB_DIST_PATH points at it.
COPY --from=builder /usr/src/app/apps/api/dist ./dist
COPY --from=builder /usr/src/app/apps/web/dist ./dist/web

# `drizzle/` is DATA, not code: esbuild bundles only the JS, so migrate.js cannot
# find its journal unless the folder sits beside it. This is the same reason
# deploy.sh ships it, and all of resolveMigrationsFolder()'s candidates miss
# without it.
COPY --from=builder /usr/src/app/apps/api/drizzle ./drizzle

# No `bun` anywhere: the bundle targets node22+ and the unit runs /usr/bin/node.
EXPOSE 4000

# No HEALTHCHECK here on purpose. The systemd unit has no healthcheck either —
# deploy.sh probes /health from the OUTSIDE, on the port the running PID is
# actually listening on, because the port is injected at run time and hardcoding
# it in an image is exactly the assumption that broke once already (4189 -> 4000).

CMD ["node", "dist/index.js"]