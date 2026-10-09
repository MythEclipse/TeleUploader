#!/bin/bash
# ─── TeleUploader Deploy Script ──────────────────────────────────────────────
# Builds the pnpm/Node app and ships it to the VPS as a plain systemd deploy.
#
# There is no Nix on orangevps anymore (`ls /nix` → No such file or directory),
# so the old store-based deploy chain (`nix build` → push store path → activate
# profile) could never work — every run died on the push with
# `error: cannot connect`. The unit itself was
# already migrated by hand:
#
#     ExecStart=/usr/local/bin/bws-exec teleuploader /opt/teleuploader/bin/teleuploader
#       → cd /var/lib/teleuploader
#       → exec /usr/bin/node /opt/teleuploader/dist/index.js
#
# So a deploy is only: build dist, ship it, install it under
# /opt/teleuploader/dist, apply pending database migrations, `systemctl restart
# teleuploader`, then prove that /health answers on the port the service's own PID is
# listening on.
#
# ROLLBACK SEMANTICS — there are two windows, and the boundary matters.
#
#   BEFORE migrations:  a failure reverts the whole bundle to the previous release.
#                      Safe, because the database was never touched, so the old binary
#                      provably still matches the old schema.
#
#   AFTER  migrations:  a failure HARD STOPS. The bundle is NOT reverted.
#
# Migrations are not reversible. 0002 sets buckets.organization_id NOT NULL with no
# default and drops the global buckets_name_key, so a pre-P3a binary's
# `INSERT INTO buckets (id, name)` fails outright (reproduced against a real
# database). Reverting the binary onto a migrated schema would not restore service —
# it would replace a loud deploy failure with a service that cannot serve a request.
# A `pg_dump`-based schema rollback was considered and rejected: it would silently
# discard data the moment a future migration turns destructive. The deploy stops and
# a human decides instead.
#
# Migrations (P5). The drizzle migrations folder is data, not code, so it is shipped
# alongside the bundle; `dist/migrate.js` is then run AFTER the install and BEFORE the
# restart. That ordering is load-bearing and is asserted in
# apps/api/test/deploy-config.test.ts. Before P5 nothing applied migrations at all —
# not at boot (removed in P2a) and not during deploy (never existed) — so a build
# carrying 0001-0003 would have left production on the pre-P3a schema.
# `pnpm run verify:migrations` (scripts/verify-migrations.ts) reproduces the whole
# path against a scratch database and is wired into CI as its own job against a real
# PostgreSQL service.
#
# The SPA (P4). `apps/web/dist/` ships the same way drizzle/ does: as a NAMED
# SUBDIRECTORY (`$STAGE/web` → `$DIST_DIR/web`), installed whole and rolled back whole.
# It is BUILT by CI, not here — this script is invoked as `./deploy.sh --no-build` from
# deploy.yml, so the `if $DO_BUILD` block below never runs on the only path that reaches
# production. Both the --check list and the remote preflight name the sentinel FILE
# `apps/web/dist/index.html`, never the directory, because `[ -e dir ]` is true for an
# empty directory and a failed vite build leaves exactly that.
#
# Prerequisites:
#   - SSH access to the VPS
#   - pnpm + Node on this machine (for the build step)
#
# Usage:
#   ./deploy.sh                          # build + deploy
#   ./deploy.sh --no-build               # ship the existing dist/
#   ./deploy.sh --help                   # show this message
#   ./deploy.sh --check                  # dry-run: show vars and exit
#
# Required env in CI (Gitea Actions secrets / GitHub Actions secrets):
#   VPS_HOST              — VPS IP/hostname
#   VPS_USER              — SSH user
#   VPS_SSH_KEY           — path to SSH private key file
#
# Local defaults:
#   VPS_HOST              — 45.127.35.244
#   VPS_USER              — root
#   VPS_SSH_KEY           — ~/.ssh/id_ed25519
#
# Optional:
#   DEPLOY_DIR            — app dir on VPS (default: /opt/teleuploader)
#   UNIT                  — systemd unit to restart (default: teleuploader)
#   HEALTH_PATH           — HTTP path to probe (default: /health)
#   MIGRATION_APP         — Bitwarden Secrets app supplying the migration's env
#                            (default: teleuploader, same as the unit's ExecStart)
#   NODE_BIN              — node binary used for the migration (default: /usr/bin/node)
# ──────────────────────────────────────────────────────────────────────────────

set -eu

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="teleuploader"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/${APP_NAME}}"
UNIT="${UNIT:-${APP_NAME}}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
# Bitwarden Secrets app whose entries supply DATABASE_URL/BOT_TOKENS/... to the
# migration run. Must match the `teleuploader` app in the unit's ExecStart, since
# migrate.js imports env.ts and refuses to start without those variables.
MIGRATION_APP="${MIGRATION_APP:-${APP_NAME}}"
# Node binary, matching the unit's `exec /usr/bin/node .../index.js`.
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# ── Parse args ────────────────────────────────────────────────────────────────
DO_BUILD=true
DO_CHECK=false

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,/^$/ s/^# //p' "$0"
      exit 0
      ;;
    --no-build)    DO_BUILD=false ;;
    --check)       DO_CHECK=true ;;
  esac
done

# ── Default credentials ───────────────────────────────────────────────────────
# Local defaults for this project. CI-provided environment variables take precedence.
: "${VPS_HOST:=45.127.35.244}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:=${HOME}/.ssh/id_ed25519}"

# ── Check mode ────────────────────────────────────────────────────────────────
if $DO_CHECK; then
  echo "=== Config ==="
  echo "App name:     $APP_NAME"
  echo "Deploy dir:   $DEPLOY_DIR"
  echo "Unit:         $UNIT"
  echo "Health path:  $HEALTH_PATH"
  echo ""
  echo "=== Credentials ==="
  echo "VPS_HOST:     ${VPS_HOST:-<not set>}"
  echo "VPS_USER:     ${VPS_USER:-<not set>}"
  echo "VPS_SSH_KEY:  ${VPS_SSH_KEY:+<set (${#VPS_SSH_KEY} chars)>}"
  echo ""
  echo "=== Files to deploy ==="
  # schema.sql was listed here but never shipped and has not run at boot since P2a
  # (the boot-time auto-migration was removed in the same commit that introduced
  # drizzle), so the entry asserted a deployment step that did not exist. The
  # migrations now travel as apps/api/drizzle/, which migrate.js actually reads.
  #
  # The SPA entry names apps/web/dist/index.html, a SENTINEL FILE — never the bare
  # `apps/web/dist` directory. `[ -e dir ]` is true for an EMPTY directory, so a
  # failed or never-run `vite build` would report green here and scp would ship an
  # empty folder, which serves a white screen at `/` with a 200 HTML response.
  # Same convention as apps/api/drizzle/meta/_journal.json.
  #
  # Every path here is repo-root-relative and fully qualified. P1 moved the API
  # build output to apps/api/dist while this script still read the root dist/, and
  # the root leftover was shipped in total silence; `apps/web/dist` must never be
  # shortened to `dist`.
  for f in package.json pnpm-lock.yaml apps/api/dist/index.js apps/api/dist/migrate.js apps/api/dist/seed.js apps/api/drizzle/meta/_journal.json apps/web/dist/index.html; do
    [ -e "$f" ] && echo "  ✓ $f" || echo "  ✗ $f (missing)"
  done
  echo ""
  echo "=== Migration ==="
  echo "Migrations app: $MIGRATION_APP (bws-exec supplies DATABASE_URL et al)"
  echo "Runs: after install, before systemctl restart"
  echo "Rollback: automatic BEFORE migrations; HARD STOP after (migrations are not"
  echo "         reversible — a pre-P3a binary cannot read the P3a schema)"
  exit 0
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "→ $*"; }
ok()   { echo "✓ $*"; }
die()  { echo "✗ $*"; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────
: "${VPS_HOST:?VPS_HOST resolved to empty}"
: "${VPS_USER:?VPS_USER resolved to empty}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY resolved to empty}"
[ -f "$VPS_SSH_KEY" ] || die "SSH key not found at $VPS_SSH_KEY"

SSH_DEST="${VPS_USER}@${VPS_HOST}"
SSH_OPTS="-i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

vps()  { ssh $SSH_OPTS "$SSH_DEST" "$@"; }

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$REPO_ROOT"
STAGE_REMOTE="/tmp/${APP_NAME}-deploy"
DIST_REMOTE="${DEPLOY_DIR}/dist"

# ── 1. Test SSH connection ────────────────────────────────────────────────────
log "Testing SSH connection to ${VPS_USER}@${VPS_HOST}..."
vps "echo connected" > /dev/null 2>&1 || die "SSH connection failed"
ok "SSH connection established"

# ── 2. Build ──────────────────────────────────────────────────────────────────
if $DO_BUILD; then
  command -v pnpm > /dev/null 2>&1 || die "pnpm not found (this project builds with pnpm)"

  log "Installing dependencies..."
  pnpm install --frozen-lockfile 2>&1 | tail -2

  log "Linting..."
  pnpm run lint 2>&1 | tail -5 || die "Lint failed"

  log "Building dist..."
  pnpm run build 2>&1 | tail -5 || die "Build failed"

  [ -f apps/api/dist/index.js ] || die "apps/api/dist/index.js not found after build"
  [ -f apps/api/dist/migrate.js ] || die "apps/api/dist/migrate.js not found after build"
  [ -f apps/api/dist/seed.js ] || die "apps/api/dist/seed.js not found after build — the S3 credential is adopted by the seeder, and there is no environment fallback"
  # The SPA is built by CI (`pnpm --filter @teleuploader/web run build` in deploy.yml),
  # not here: this script is invoked as `./deploy.sh --no-build` from CI, so the
  # `if $DO_BUILD` block never executes on the only path that reaches production.
  # Assert the sentinel FILE anyway, so a deploy run locally with a full build still
  # refuses to ship a half-built SPA.
  [ -f apps/web/dist/index.html ] || die "apps/web/dist/index.html not found — build the SPA first (pnpm --filter @teleuploader/web run build)"
  ok "Build complete (index.js: $(wc -c < apps/api/dist/index.js | numfmt --to=iec) — migrate.js: $(wc -c < apps/api/dist/migrate.js | numfmt --to=iec) — seed.js: $(wc -c < apps/api/dist/seed.js | numfmt --to=iec))"
else
  log "Skipping build (--no-build)"
  [ -f apps/api/dist/index.js ] || die "apps/api/dist/index.js missing — run without --no-build first"

  # The SPA is not built by this branch either. Assert the sentinel FILE, not the
  # directory: `[ -d apps/web/dist ]` is true for an empty folder, which is exactly
  # what a failed `vite build` leaves behind, and shipping it serves a white screen
  # at `/` behind a 200 HTML response.
  [ -f apps/web/dist/index.html ] || die "apps/web/dist/index.html missing — build the SPA first (pnpm --filter @teleuploader/web run build)"

  # --no-build ships whatever is on disk, so refuse to ship a stale bundle.
  # P1 moved the build output to apps/api/dist while this script still read the
  # repo-root dist/, leaving two directories: the root one was a pre-move leftover,
  # gitignored, and a deploy would have shipped it in total silence.
  #
  # apps/web/src is in the `find` list too: without it the API bundle's freshness
  # said nothing about the SPA's, so a stale SPA shipped silently on every CI deploy
  # while the JS bundle was correctly guarded.
  NEWEST_SRC=$(find apps/api/src apps/api/drizzle apps/web/src -type f -newer apps/api/dist/index.js 2>/dev/null | head -1)
  if [ -n "$NEWEST_SRC" ]; then
    die "apps/api/dist/index.js is older than $NEWEST_SRC — refusing to ship a stale build. Re-run without --no-build."
  fi
  ok "Bundle is newer than every source file"
fi

# ── 3. Stage on the VPS ───────────────────────────────────────────────────────
log "Staging build at ${STAGE_REMOTE}..."
vps "rm -rf '${STAGE_REMOTE}' && mkdir -p '${STAGE_REMOTE}'"

log "Shipping dist to VPS..."
scp $SSH_OPTS apps/api/dist/index.js apps/api/dist/migrate.js apps/api/dist/seed.js "${SSH_DEST}:${STAGE_REMOTE}/" > /dev/null || die "scp failed"

# The drizzle migrations folder is DATA, not code: esbuild bundles only the JS, so
# `node dist/migrate.js` cannot find it unless the folder is shipped next to the
# bundle. All six candidates in resolveMigrationsFolder() (migrate.ts:33-47) miss in
# the deployed layout unless drizzle/ sits beside migrate.js — verified: running the
# real dist/migrate.js from a directory containing only itself exits 1 with
# "drizzle migrations folder not found". Ship it, and ship it as a directory so the
# remote install/rollback loops below can treat it as one atomic unit.
scp -r $SSH_OPTS apps/api/drizzle "${SSH_DEST}:${STAGE_REMOTE}/" > /dev/null || die "scp of drizzle/ failed"

# The SPA build is shipped as a NAMED SUBDIRECTORY `$STAGE/web`, never flattened into
# `$STAGE` root. The install loop below globs `"$STAGE"/*.js`; dumping Vite's hashed
# chunks (index-<hash>.js) into the stage root would sweep them into $DIST_DIR's top
# level, where the per-file install would place them, and where restore() — which
# copies files that exist in $PREV and never prunes — would leave them behind
# permanently. Measured on a real restore() run: dist/index.js was correctly OLD
# while dist/index-a1b2c3.js was still the NEW release's asset.
#
# The explicit destination `${STAGE_REMOTE}/web` (rather than letting scp infer the
# name) removes the other root-dist/ vs apps/api/dist/ confusion class entirely:
# the source is the literal path `apps/web/dist` and the destination is the literal
# path `$STAGE/web`.
scp -r $SSH_OPTS apps/web/dist "${SSH_DEST}:${STAGE_REMOTE}/web" > /dev/null || die "scp of SPA dist/ failed"
ok "Build + drizzle/ migrations + SPA dist/ shipped"

# dist/seed.js is NOT optional. The S3 surface resolves credentials through
# makeSecretResolver() (s3-router.ts:101-112), which reads s3_credentials and has
# NO environment fallback — verified: `grep s3AccessKey src/presentation/s3/auth.ts`
# returns only a comment. seed.ts is what adopts the existing S3_ACCESS_KEY /
# S3_SECRET_KEY pair into the bootstrap organization, so without it every S3 client
# (aws-cli, rclone, the Docker registry push path) gets 403 on the first signed
# request. Shipping migrate.js without seed.js would leave the S3 API dark while
# the dashboard looked perfectly healthy.

# ── 4. Install + restart + verify (runs on the VPS) ───────────────────────────
# Fed through stdin so the whole remote transaction — atomic install, restart,
# health probe, rollback — happens in one session with no quoting traps.
log "Installing under ${DIST_REMOTE} and restarting ${UNIT}..."
if ! vps bash -s -- "${STAGE_REMOTE}" "${DIST_REMOTE}" "${UNIT}" "${HEALTH_PATH}" "${MIGRATION_APP}" "${NODE_BIN}" <<'REMOTE'
set -Eeuo pipefail
STAGE="$1"; DIST_DIR="$2"; UNIT="$3"; HEALTH_PATH="$4"; MIGRATION_APP="$5"; NODE_BIN="$6"

say()  { echo "[deploy] $*"; }
boom() { echo "[deploy] ERROR: $*" >&2; exit 1; }

[ -f "$STAGE/index.js" ] || boom "staged index.js not found in $STAGE"
[ -f "$STAGE/migrate.js" ] || boom "staged migrate.js not found in $STAGE"
# Fail loudly HERE rather than half-way through the install: the migrator cannot find
# its journal without meta/_journal.json, and otherwise this is discovered only after
# the new bundle is already on disk.
[ -f "$STAGE/drizzle/meta/_journal.json" ] || boom "staged drizzle/meta/_journal.json not found in $STAGE — migrations would be a no-op"
# Same sentinel-file rule as the local --check: an empty staged web/ would serve a
# white screen at `/` with a 200 HTML response, so fail HERE rather than after the
# new bundle is already on disk.
[ -f "$STAGE/web/index.html" ] || boom "staged web/index.html not found in $STAGE — the SPA would ship as an empty directory"
command -v systemctl > /dev/null 2>&1 || boom "systemctl not found"
command -v curl > /dev/null 2>&1 || boom "curl not found"
# The migration runs under bws-exec because migrate.js imports env.ts, which throws
# without DATABASE_URL/BOT_TOKENS/STORAGE_CHANNEL_ID/BASE_URL/PORT — and systemd
# injects those at run time, not into this SSH shell.
command -v bws-exec > /dev/null 2>&1 || boom "bws-exec not found — cannot supply the migration's environment"

# Prefer sudo: on this box the deploy user can write /opt/<app> (so a plain
# write test would pick the no-privilege branch) but restarting a unit, reading
# its journal, or seeing another user's process in `ss` needs root. The CI user
# has NOPASSWD sudo; if it ever loses that, fall back to running as-is so the
# error surfaces from systemd itself instead of silently doing nothing.
as_root() {
  if command -v sudo > /dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    "$@"
  fi
}

PREV="${DIST_DIR}.previous"
if [ -d "$DIST_DIR" ]; then
  rm -rf "$PREV"
  as_root cp -a "$DIST_DIR" "$PREV"
  say "backed up current dist to $PREV"
fi

RESTORE=0
# Set the moment migrations are ATTEMPTED — before the call, not after it. A migration
# that fails halfway has still changed the schema, so "it did not succeed" is not a
# reason to believe the old binary can still run.
MIGRATED=0
restore() {
  [ -d "$PREV" ] || return 0
  say "restoring previous dist"
  local f base
  for f in "$PREV"/*.js; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    as_root cp -a "$f" "$DIST_DIR/$base.new" && as_root mv -f "$DIST_DIR/$base.new" "$DIST_DIR/$base"
  done
  # The migrations folder must roll back with the binary, and the revert must be
  # UNCONDITIONAL. Guarding it on `[ -d "$PREV/drizzle" ]` was wrong on the very first
  # deploy that ships drizzle/: release N-1 has no such folder, so the branch was
  # skipped and nothing removed $DIST_DIR/drizzle — the OLD bundle was restored while
  # keeping the NEW migrations folder. That is the exact schema/binary skew this
  # deploy is supposed to prevent, introduced by the rollback itself.
  #
  # Both branches now run: restore the previous folder when there was one, otherwise
  # REMOVE the new one. The removal is the case that matters — it is what makes the
  # first P5 deploy leave the previous release exactly as it was.
  if [ -d "$PREV/drizzle" ]; then
    as_root rm -rf "$DIST_DIR/drizzle"
    as_root cp -a "$PREV/drizzle" "$DIST_DIR/drizzle.restore"
    as_root mv -f "$DIST_DIR/drizzle.restore" "$DIST_DIR/drizzle"
    say "restored previous drizzle/ migrations"
  else
    # The previous release shipped no migrations folder. Leaving the new one behind
    # would pair an old migrate.js with a journal of migrations it never shipped.
    as_root rm -rf "$DIST_DIR/drizzle"
    say "removed drizzle/ (previous release shipped no migrations folder)"
  fi

  # The SPA directory must roll back with the binary, and the revert must be
  # UNCONDITIONAL — the identical trap that already bit drizzle/ above, and the
  # first P4 deploy is exactly the case that fires it: release N-1 shipped no web/,
  # so guarding on `[ -d "$PREV/web" ]` would skip the branch and leave the NEW SPA
  # serving next to the OLD binary.
  #
  # BOTH branches run. Restore the previous folder when there was one; otherwise
  # REMOVE the new one. The removal branch is what makes the first P4 deploy leave
  # the previous release exactly as it was.
  if [ -d "$PREV/web" ]; then
    as_root rm -rf "$DIST_DIR/web"
    as_root cp -a "$PREV/web" "$DIST_DIR/web.restore"
    as_root mv -f "$DIST_DIR/web.restore" "$DIST_DIR/web"
    say "restored previous web/ SPA"
  else
    as_root rm -rf "$DIST_DIR/web"
    say "removed web/ (previous release shipped no SPA directory)"
  fi
  as_root systemctl restart "$UNIT" || true
}

report() {
  echo "=== systemctl status $UNIT ==="
  as_root systemctl status "$UNIT" --no-pager 2>&1 | head -20 || true
  echo "=== journalctl -u $UNIT (last 60) ==="
  as_root journalctl -u "$UNIT" -n 60 --no-pager 2>&1 | tail -60 || true
}

on_error() {
  local rc="$1" line="$2"
  echo "[deploy] ERROR: step failed at line $line (exit $rc)" >&2
  if [ "$RESTORE" = "1" ]; then
    if [ "$MIGRATED" = "1" ]; then
      # Past the point of no return. Rolling the binary back here would revert it
      # onto a schema it cannot read, so we deliberately leave the NEW bundle and
      # the possibly-migrated database in place and hand the decision to a human.
      # See the "POINT OF NO RETURN" block above for the reproduction.
      echo "" >&2
      echo "[deploy] ============================================================" >&2
      echo "[deploy] HARD STOP: migrations were attempted and the deploy then" >&2
      echo "[deploy] failed at line $line. The schema may already be migrated." >&2
      echo "[deploy]" >&2
      echo "[deploy] NOT rolling the binary back: these migrations are not" >&2
      echo "[deploy] reversible, so the previous binary cannot read the current" >&2
      echo "[deploy] schema (e.g. buckets.organization_id is NOT NULL with no" >&2
      echo "[deploy] default). The new bundle is left installed." >&2
      echo "[deploy]" >&2
      echo "[deploy] Decide explicitly, from the logs below:" >&2
      echo "[deploy]   1. If the new binary is healthy enough to serve, fix forward." >&2
      echo "[deploy]   2. If not, re-run this deploy once the fault is understood." >&2
      echo "[deploy]   3. To go back, you need a verified pre-migration dump —" >&2
      echo "[deploy]      this script does not take one, deliberately." >&2
      echo "[deploy] ============================================================" >&2
      echo "" >&2
    else
      restore
    fi
  fi
  report
  exit "$rc"
}
trap 'on_error $? $LINENO' ERR

# Per-file rename on the same filesystem: the running process keeps its old
# inode until the restart, so nothing half-written is ever executed.
#
# `*.js` AND the drizzle/ folder are installed. The migrations folder used to be
# dropped here: the loop globbed only *.js, so a staged drizzle/ was skipped on
# install AND not reverted by restore(), leaving the new binary paired with the
# previous release's migrations — a silent schema/binary skew. Both loops below
# handle it.
RESTORE=1
for f in "$STAGE"/*.js; do
  base="$(basename "$f")"
  as_root cp -a "$f" "$DIST_DIR/$base.new"
  as_root mv -f "$DIST_DIR/$base.new" "$DIST_DIR/$base"
  say "installed $base"
done

# The migrations folder is swapped in as a whole directory for the same reason the
# JS files are renamed per-file: a half-copied journal would make the migrator read
# a truncated _journal.json. `mv` on a directory is atomic within a filesystem.
if [ -d "$STAGE/drizzle" ]; then
  as_root rm -rf "$DIST_DIR/drizzle.old"
  if [ -d "$DIST_DIR/drizzle" ]; then
    as_root mv -f "$DIST_DIR/drizzle" "$DIST_DIR/drizzle.old"
  fi
  as_root cp -a "$STAGE/drizzle" "$DIST_DIR/drizzle.new"
  as_root mv -f "$DIST_DIR/drizzle.new" "$DIST_DIR/drizzle"
  as_root rm -rf "$DIST_DIR/drizzle.old"
  say "installed drizzle/ migrations"
fi

# The SPA is swapped in as a whole directory, for the same reason drizzle/ is: a
# half-copied asset tree would serve a mixture of two releases' hashed chunks.
# `mv` on a directory is atomic within a filesystem, same as the JS per-file
# renames above. Installed BEFORE the migration and BEFORE the restart, so the unit
# never restarts into a state where it would serve a half-installed SPA.
if [ -d "$STAGE/web" ]; then
  as_root rm -rf "$DIST_DIR/web.old"
  if [ -d "$DIST_DIR/web" ]; then
    as_root mv -f "$DIST_DIR/web" "$DIST_DIR/web.old"
  fi
  as_root cp -a "$STAGE/web" "$DIST_DIR/web.new"
  as_root mv -f "$DIST_DIR/web.new" "$DIST_DIR/web"
  as_root rm -rf "$DIST_DIR/web.old"
  say "installed web/ SPA"

  # TELL THE RUNNING PROCESS WHERE THE SPA IS.
  #
  # Installing the SPA is necessary but not sufficient: `spa-controller` reads
  # `WEB_DIST_PATH`, and `resolveSpaRoot()` returns null when it is unset — every
  # SPA route then falls through to the pre-P4 404 while the deploy still reports
  # success. `grep -rn WEB_DIST_PATH` across deploy.sh, .github/ and
  # docker-compose.yml returned NOTHING, so a deploy could ship apps/web/dist,
  # install it here, restart, and serve 404 at `/` with every shipping assertion
  # still green.
  #
  # Exported AFTER the install above and BEFORE the restart, so the unit never
  # starts pointed at a directory that is not there yet. `$DIST_DIR` is exactly
  # where the `mv` above put it.
  export WEB_DIST_PATH="$DIST_DIR/web"
  say "WEB_DIST_PATH=$WEB_DIST_PATH"
else
  # Rollback removed web/ because the previous release shipped none. The unit must
  # not keep pointing at a directory that is no longer there — resolveSpaRoot()
  # would warn on every boot and serve the API without the dashboard.
  export WEB_DIST_PATH=""
  say "no web/ in this release — WEB_DIST_PATH unset (backend-only)"
fi

# ── Apply migrations (P5) ───────────────────────────────────────────────────
# ORDERING IS LOAD-BEARING. Migrations must run:
#   AFTER  the new bundle + its drizzle/ folder are installed — the migrator
#          resolves the journal relative to dist/migrate.js, so the folder must
#          already be in place or it exits 1.
#   BEFORE systemctl restart — the P3b binary selects on columns introduced by
#          0001-0003 (buckets.organization_id, organizations, members,
#          s3_credentials). A restart without them crash-loops the unit.
#
# THIS IS THE POINT OF NO RETURN (P5 fix for the schema/binary skew).
#
# Until this line, a failure rolls the whole bundle back to the previous release and
# the database was never touched — that is a genuinely safe rollback, because the old
# binary provably matches the old schema.
#
# From here on the database may have changed, and these migrations are NOT
# reversible. 0002 alone ends with:
#     ALTER TABLE buckets ALTER COLUMN organization_id SET NOT NULL;
#     ALTER TABLE buckets DROP CONSTRAINT buckets_name_key;
# A pre-P3a binary inserts `INSERT INTO buckets (id, name) VALUES (...)`, which now
# fails with "null value in column organization_id violates not-null constraint"
# (reproduced against a real database), and the dropped global unique index is a
# multi-tenancy invariant that restoring the old schema would silently undo.
#
# So restoring the previous binary here is not a recovery — it produces a service
# that cannot serve a single request, while looking like a successful rollback. We
# deliberately do NOT do it: the deploy HARD STOPS and leaves the new binary in place
# for a human to decide. That is the honest failure mode, because the alternative
# silently converts a loud deploy failure into a silent data-model regression.
#
# A `pg_dump` before migrating was considered and rejected: today's migrations happen
# to be non-destructive, but that is a property of the files as written, not a
# guarantee for the next person to add a DROP COLUMN. Restoring a dump would then
# discard real user data during a routine deploy failure, which is strictly worse
# than the loud stop this script now takes.
#
# `node`, never `bun`/Docker: the unit runs `/usr/bin/node dist/index.js`, and
# drizzle-kit migrate is unusable in prod (PgBouncer transaction pooling drops the
# session-scoped advisory lock mid-migration — see migrate.ts:105-108).
#
# The env is NOT in this shell: systemd injects it at run time via bws-exec
# (ExecStart=/usr/local/bin/bws-exec teleuploader ...), so a bare `node
# migrate.js` over SSH dies in env.ts before it reaches the database — verified.
# Wrapping the invocation in the same bws-exec the unit uses is what makes the
# secret available, and it keeps the deploy path and the runtime path identical.
say "applying database migrations"
MIGRATED=1
as_root bws-exec "$MIGRATION_APP" -- "$NODE_BIN" "$DIST_DIR/migrate.js"

# Seed IMMEDIATELY after migrate, still before the restart, still under the same
# bws-exec env. Order matters: 0002 backfills existing buckets from the bootstrap
# organization, and seed.ts is what adopts the S3 credential into it. Running it
# later — or never — leaves a deploy that migrates cleanly and then serves 403 to
# every S3 client. Idempotent by construction (lookup-then-insert), so running it on
# every deploy is safe and is what keeps a newly rotated credential in the table.
say "seeding bootstrap organization and S3 credential"
as_root bws-exec "$MIGRATION_APP" -- "$NODE_BIN" "$DIST_DIR/seed.js"

say "restarting $UNIT"
as_root systemctl restart "$UNIT"

active=0
for _ in $(seq 1 30); do
  if as_root systemctl is-active --quiet "$UNIT"; then active=1; break; fi
  sleep 1
done
[ "$active" = "1" ] || boom "$UNIT never became active"

# The port is injected at run time by bws-exec, so read it off the running PID
# instead of hardcoding it (it has already moved once: 4189 → 4000). `ss -p`
# only shows processes the caller may inspect, hence as_root.
pid="$(as_root systemctl show -p MainPID --value "$UNIT")"
port="$(as_root ss -ltnpH 2>/dev/null | grep -F "pid=$pid," | head -1 | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true)"

if [ -n "$port" ]; then
  url="http://127.0.0.1:${port}${HEALTH_PATH}"
  say "health-check $url"
  body="$(curl -fsS -m 5 --retry 15 --retry-delay 2 --retry-connrefused --retry-all-errors "$url")"
  say "health: $body"

  # ── site root probe — the dashboard half of the deploy ─────────────────────
  # /health proves the API is alive. It says NOTHING about the dashboard: a unit
  # that migrated, seeded, restarted, served /health perfectly and answered 404 at
  # `/` was reported as a SUCCESSFUL deploy — which is exactly the P4 shipping
  # failure this probe exists to catch.
  #
  # Only run when a SPA was actually installed. On a backend-only release
  # WEB_DIST_PATH is empty and 404 at `/` is the CORRECT pre-P4 answer, so
  # demanding 200 there would fail every backend-only deploy.
  if [ -n "$WEB_DIST_PATH" ]; then
    root_url="http://127.0.0.1:${port}/"
    say "site root probe $root_url"

    # PROVE THE UNIT CAN SEE IT, not just this shell.
    #
    # The export above lives in deploy.sh's own process. If the unit resolves its
    # environment some other way — an EnvironmentFile, or a wrapper like bws-exec
    # that builds the child env from a secret store — then `systemctl restart`
    # starts a process that has never seen this variable, and every SPA route
    # 404s while this script keeps reporting success. That is not hypothetical: it
    # is exactly how the dashboard was broken on the production box, where the
    # unit runs `bws-exec teleuploader …` and the only teleuploader_* keys in the
    # store had no web_dist_path.
    #
    # A probe that curls the port cannot tell the difference, because the failure
    # and the success look identical from the network. Reading the unit's actual
    # environment CAN. So read it first, and fail with the fix named.
    say "checking the unit's environment carries WEB_DIST_PATH"
    unit_env_dump=/proc/"${pid}"/environ
    if [ ! -r "$unit_env_dump" ]; then
      say "NOTE: cannot read $unit_env_dump (permissions) — relying on the HTTP probe alone"
    elif tr '\0' '\n' < "$unit_env_dump" | grep -qx "WEB_DIST_PATH=${WEB_DIST_PATH}"; then
      say "unit environment carries WEB_DIST_PATH (matches this release)"
    else
      say "unit environment does NOT carry WEB_DIST_PATH=${WEB_DIST_PATH}"
      boom "the running unit has no WEB_DIST_PATH=${WEB_DIST_PATH}, so the dashboard would 404 at / after a SUCCESSFUL deploy. This script's export does not reach a unit that builds its own environment. Add the variable where the unit reads it — for a bws-exec unit that means a secret named after the app prefix (e.g. teleuploader_web_dist_path; bws-env only emits keys prefixed with the app name) — then restart and re-run."
    fi

    # -w writes the status and content-type AFTER the body, so both are captured
    # in one request. Status alone is not enough: the S3 catch-all answers 200 for
    # some paths, and what proves the DASHBOARD answered is the HTML content-type.
    root_meta="$(curl -fsS -m 5 --retry 15 --retry-delay 2 --retry-connrefused --retry-all-errors \
      -o /tmp/${APP_NAME}-root-probe.body -w '%{http_code} %{content_type}' "$root_url")" \
      || boom "site root probe failed: $root_url did not answer 200"
    case "$root_meta" in
      200*text/html*) say "site root: $root_meta" ;;
      *) boom "site root probe got '$root_meta', expected 200 with text/html — the SPA is installed but WEB_DIST_PATH is not reaching the unit" ;;
    esac
    rm -f /tmp/${APP_NAME}-root-probe.body
  else
    say "site root probe skipped — no web/ in this release (backend-only)"
  fi
else
  # systemd already says active, but name the miss loudly instead of passing silently.
  say "WARNING: no listening socket found for pid $pid — $HEALTH_PATH not probed"
fi

# Rollback stays armed across the install, the migration AND the restart, and is
# disarmed only now that the health probe has passed. Leaving it armed past this
# point would mean a later failure (or the exit trap) reverts a deploy that in fact
# succeeded.
RESTORE=0

say "deploy of $UNIT complete (active: $(as_root systemctl is-active "$UNIT"))"
rm -rf "$STAGE"
REMOTE
then
  die "remote deploy failed (see log above)"
fi

# ── Cleanup temp SSH key ──────────────────────────────────────────────────────
if [[ "${VPS_SSH_KEY:-}" == /tmp/* ]]; then
  rm -f "$VPS_SSH_KEY"
fi

echo ""
echo "✓ Deploy complete — ${APP_NAME} is running on ${VPS_HOST} (unit: ${UNIT})"
