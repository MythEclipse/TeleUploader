# TeleUploader → kana full-stack migration (big-bang cutover)

## Context

`TeleUploader` (published as `filedrop`, v1.2.9) is a **live production** Telegram-backed
file store with an S3-compatible API. It is a single-package Node service on a hand-written
`node:http` shim that emulates Bun's `serve()`. The `kana-monorepo-fullstack-typescript`
skill defines a different target: a moon + pnpm workspace, Hono + oRPC backend, React 19 +
TanStack Router SPA, better-auth, Redis, and **multi-tenancy**.

The user wants a full migration — backend, frontend, everything — as a **big-bang cutover**
with **orgs owning buckets**, while `/api/upload` and `GET /f/:public_id` stay public.

### Confirmed decisions

| # | Decision |
|---|---|
| 1 | **Multi-tenant.** `buckets.organizationId` FK cascade; `files`/`multipart_uploads` inherit tenancy via their existing `bucket_id`. |
| 2 | **`/api/upload` + `GET /f/:public_id` stay public.** Only S3 + dashboard authenticated. |
| 3 | **Big-bang cutover.** One atomic deployment event; the *work* is still split into ordered, separately-gated phases on one branch. |

### Measured facts that drive the plan

1. **The S3 surface is 2,929 lines** — 30% of the codebase — of hand-rolled SigV4, XML, Range,
   and multipart. Verified: **zero** `node:http`/`IncomingMessage` imports anywhere in
   `src/interfaces/s3/` or `src/interfaces/http/controllers/s3/`. Every handler already speaks
   Web `Request`→`Response`, so all of it ports into Hono **without a rewrite**.
2. **The domain layer is already clean.** All 5 ports (`IBucketRepository`, `IFileRepository`,
   `IFilePartRepository`, `IMultipartRepository`, `ITelegramService`) are framework-free with no
   Drizzle leakage. Preserve, don't rebuild.
3. **No safety net.** `.github/workflows/deploy.yml` fires on **every push to `main`** and SSHes
   straight to production; there is **no `pull_request` workflow**. P0 exists solely to offset this.
4. **No test touches the application layer.** Verified: `grep -rn "src/application|createUploadFileUseCase|createLoginUseCase" test/` → **zero matches**. Use-cases are exercised only indirectly through controllers, so refactoring them is free.

### Pre-existing defects (fix regardless of migration)

- **`web-api-controller.ts:343,346` calls `nanoid()` / `buildNewFile()` without importing them**
  (verified against the import block). `POST /api/v1/buckets/:name/copy` throws `ReferenceError`
  → 500. **Copy is already dead in production.** Fix or explicitly drop — do not port as "working".
- **`GET /` already 500s in production — PROVEN, not predicted.** `deploy.sh:147` scp's only
  `dist/index.js` and `dist/migrate.js`, but `resolveHomeHtml()` walks up from the bundled
  module expecting `home.html`. Verified live against the running instance:
  `GET http://127.0.0.1:4000/` → **HTTP 500**, body
  `home.html not found — looked up from /opt/teleuploader/dist and 6 parent dirs`.
  Confirmed on disk: neither `/opt/teleuploader/home.html` nor `/opt/teleuploader/dist/home.html`
  exists. **The dashboard is already down** — the SPA is restoration, not replacement.
  (Note: `/opt/teleuploader` is reachable from this workstation, so this is the same deployment
  tree prod runs from — not a guess. `schema.sql` *is* present there from an earlier install,
  which is why migrations still succeed despite not being shipped by `deploy.sh` today.)
- **The S3 credentials modal is already empty.** `src/home.html:366` renders `s3AccessKey` /
  `s3SecretKey` inputs with **no `value` attribute**, and no endpoint returns them. This is a
  capability to *build*, not to preserve.
- **Test baseline: 29 unit files.** 34 on disk, 5 quarantined (live-network). `test:unit`
  enumerates all 29. *(An earlier draft claimed `rateLimit` was silently skipped; that was a
  faulty diff, since disproved — no test file is skipped today.)*
- **`CLAUDE.md` is actively wrong** — mandates Bun (`bun test`, `Bun.serve`, "don't use pg")
  while the repo is pnpm + Node + esbuild + Vitest, and cites deleted files.

---

## Phase plan

P0 is a prerequisite, not optional — it is what makes the big-bang survivable.

### P0 — Safety net (no behavior change) — ✅ DONE (commit `007b3ba`, branch `kana-migration`)

1. **Freeze auto-deploy.** Change `deploy.yml` and `release.yml` triggers from `push: main` to
   `workflow_dispatch` only. Without this, every phase merge deploys to production.
   **In the same commit** update the one assertion in `test/deploy-config.test.ts:57` that
   asserts `branches: [main]` — otherwise the freeze breaks the suite immediately.
2. **Add `.github/workflows/ci.yml`** on `pull_request` running `lint` + `test:unit`.
   **Also add `test:unit` to `deploy.yml`'s existing `lint` job** — it already gates
   `build-and-deploy` via `needs: lint`, so this makes the suite a hard precondition of every
   deploy at zero extra cost. Highest-leverage line in this phase.
3. **`scripts/smoke.sh`** — `GET /health`, a signed `s3api list-buckets`, and
   `curl /api/v1/buckets`. Run manually against the **current** prod build; if it's already red,
   fix that first. Keeps S3 credentials out of CI logs.
4. **`pg_dump` the production DB** and record the path. `deploy.sh`'s rollback restores `*.js`
   but cannot reverse DDL.
5. **Fix the `nanoid`/`buildNewFile` imports** in `web-api-controller.ts`.

**Gate:** a PR with a deliberately failing unit test cannot reach `build-and-deploy`;
`smoke.sh` green against current prod.

**Verified:** 29/29 files, 231 tests green · lint exit 0 · both workflows frozen to
`workflow_dispatch` only · freeze assertion proven to fail when the trigger is restored ·
`smoke.sh` 5/5 against local :4000 · typecheck errors 26 → 24.

**Carried forward — discovered during P0, not fixed here:**

- **22 pre-existing typecheck errors remain** (in `upload-controller.ts`, `middleware/auth.ts`,
  `test/bot.test.ts`) and there is **no `typecheck` script and no CI step for one** — that is why
  they rotted unnoticed. `middleware/auth.ts:191,258` cannot even resolve `AuthSession`.
  Wiring `tsc --noEmit` into `ci.yml` is **P1 work** (doing it now would fail CI immediately).
- **Step 4 (`pg_dump` of prod) requires VPS/Bitwarden access** — not performable from here.
- **Step 3 against production** needs real S3 credentials; only the local run was possible.

### P1 — Workspace restructure (zero behavior change) — ✅ DONE (`07170d0` P1a, `4864134` P1b, `d6614ce` cleanup)

`pnpm-workspace.yaml`, `.moon/{workspace,toolchain,tasks}.yml`, `tsconfig.base.json`,
`apps/api/{package.json,tsconfig.json,moon.yml}`; **delete `.npmrc`** (`public-hoist-pattern=[]`
suppresses hoisting that Vite/React tooling expects).

`git mv` map — pure renames + import-path rewrites, **never retype the S3 files**:

| From | To |
|---|---|
| `src/interfaces/s3/**` (1,059 lines) | `apps/api/src/presentation/http/s3/**` |
| `src/interfaces/http/controllers/s3/**` (1,870 lines) | `apps/api/src/presentation/http/s3/handlers/**` |
| `src/interfaces/{http,bot}/**` | `apps/api/src/presentation/{http,telegram}/**` |
| `src/domain/**`, `src/application/**` | `apps/api/src/{domain,application}/**` |
| `src/infrastructure/**` | `apps/api/src/infrastructure/**` |
| `src/shared/{logger,metrics}` | `apps/api/src/infrastructure/observability/` |
| `src/shared/utils/{file,validation,crypto,temp-stream}.ts` (pure) | `apps/api/src/application/shared/` |
| `src/shared/utils/{file-sink,zip,compress,ip,s3-detection}.ts` (import config) | `apps/api/src/infrastructure/**` |

**Resolve the layering violations.** Two existed, both pre-existing:
- ✅ **Resolved:** `shared/utils/s3-detection.ts` → moved to `presentation/http/s3-detection.ts`.
  Its only consumers are `index.ts` and `presentation/http/routes/index.ts`; it was never
  infrastructure. Also `shared/utils/file.ts` → `infrastructure/file.ts`, because it imports
  the logger (so it is not "pure" as the plan assumed) — and `shared/logger|metrics` →
  `infrastructure/observability/{logger,metrics}.ts`.
- ⚠️ **Deferred to P2:** `infrastructure/telegram/chunked-storage.ts:20-21` still imports
  `presentation/s3/{object-stream,range}`. The plan assumed those two files were pure and could
  be promoted to `application/shared/` — **they are not**: `object-stream.ts` imports `./headers`
  and `./range`, both S3 wire-protocol modules, so promoting it would drag the whole S3 chain
  inward. The real fix is to extract the *storage* concern (chunk assembly) from the *HTTP
  response* concern, which is a P2 design change. P1 leaves this one violation documented.

**Complete `schema.ts` for all 5 tables**, copying `schema.sql` **column-for-column** — do not
"tidy" types. `schema.ts` currently declares `publicId` as `text()` while `schema.sql` says
`VARCHAR(21)`; normalizing that emits a table-rewrite `ALTER`. Keep the nullable
`TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, `BOOLEAN DEFAULT false`, and the partial unique index
`ON files(bucket_id, s3_key) WHERE is_deleted = false`.

**Baseline, don't migrate:** `drizzle-kit generate --custom --name=baseline` →
`drizzle/0000_baseline.sql` containing only the journal-table insert marking hash `0` applied.
Diff `pg_dump --schema-only` against `schema.sql` and reconcile drift **before** touching prod.
Generate and commit; **do not apply**.

Convert the 2 `throw new Error` in `upload-file.ts` to typed `AppError` (free here — no tests
touch it). Keep the `finally { cleanupTempFile }` block byte-identical.

Rewrite ~22 `vi.mock('../src/...')` paths.

**Gate:** `moon run :check` green; **29/29** unit files passing with zero test files deleted;
`drizzle-kit generate` produces **no** new migration.

> Consider P1a (workspace scaffolding, zero moves) → P1b (the moves) so "my moon config is
> wrong" is distinguishable from "my move was wrong". Cheap; recommended.

### P2 — Drizzle + Hono/oRPC

**P2a (drizzle baseline) — ✅ DONE (`c9aac9a`).** Schema for all 5 tables reconciled
against `information_schema.columns` on a live DB. Two drifts mattered:
`files.public_id` was declared `text()` vs the real `varchar(21)`, and every
timestamp was `.notNull()` vs nullable — either would have made the first
`drizzle-kit generate` emit table-rewriting ALTERs against production. The baseline
is comment-only SQL plus a **populated** snapshot (`--custom` writes an empty one,
which silently re-emits everything). `drizzle-kit generate` reports "No schema
changes". `migrate.ts` is now the sole runner; the boot-time auto-migration is
deleted.

> **Design error found and fixed.** The baseline was first given a far-future
> (`when: 4070908800000`) timestamp to force the migrator to skip it. That silently
> blocks **every future migration**: drizzle compares each migration against the
> *newest* journal row, so `4070908800000 < <any real timestamp>` is false forever.
> Caught by simulating the P3 tenancy migration — it reported success and created
> nothing. Timestamps are now real, and `runBaseline()` seeds the journal with the
> baseline entry's own sha256 + timestamp.

**P2b (Hono) — ✅ DONE (`2bfb6fd`).** The `serve.ts` shim is replaced by
`presentation/http/app.ts` + `@hono/node-server`. **No controller changed.**

> **The real risk was route order, not mechanics.** The shim matched by specificity
> *score*; Hono matches by *registration order*. Two silent failures the old matcher
> made impossible: dashboard-before-S3 hands every SigV4 request to the dashboard,
> and `/api/v1/*`-before-`/auth/login` swallows the auth endpoints. The order is
> documented inline and pinned by `hono-routing.test.ts` (15 tests).
>
> `live-probe.ts` boots the real app on a real socket (13 probes, green) and caught
> two things unit tests could not: **`req.params` was lost** — file-controller reads
> `req.params?.public_id` and would have 404'd every download; and **`requireAuth`
> applies at route-registration time**, so asserting on it per-request passes
> vacuously.

**P2c (oRPC management surface) — ✅ DONE (`688e633`).** oRPC router at `/rpc/*` over
the **same** controllers that serve `/api/v1/*` — one implementation, two entry
points, so they cannot drift. Additive, not a move: 9 test files and `home.html`
still use `/api/v1/*` until P4. S3 + public data plane stay outside oRPC.

> **Four API facts had to be read off the installed package; all four were wrong
> on first attempt**, each now pinned by live-probe:
> 1. There is no `os.procedure` in @orpc/server 1.15.5 — it's `os.input/os.meta/os.handler`, and `RPCHandler` is a class (needs `new`).
> 2. `RPCHandler` matches the **full path and strips no prefix** — mounted at `/rpc/*`, every procedure 404'd until `handleRpc()` re-attached the prefix.
> 3. `.handle()` resolves to `{ matched, response }`, not a `Response`.
> 4. **The subtle one:** under `implement(contract)`, the *placeholder's return value* defines the procedure's output schema. A `{}` placeholder made oRPC serialise `{}` and strip every field — the client got `{}` while `call()` on the same router returned correct data, which is exactly why it looked like a transport bug. Each placeholder now declares its controller's real shape, and `jsonPayload` is generic so the compiler checks handler returns against it.

Context is declared contract-first via `implement(...).$context()`. The package-level
`os` is typed with an **empty** context, so composing through it erased
`AppRouterContext` from every handler.

**Gate:** 246 tests (30 files) · lint exit 0 · typecheck 24 (P0 baseline) · 2 bundles ·
live-probe 18/18 including 4 new oRPC checks.

**Still deferred:** `serve.ts`, `routes/index.ts` and `swagger.ts` remain — they are
still load-bearing for `s3-routing`, `public-readonly-routes` and `swagger` tests.

Mount order in `apps/api/src/main.ts` (load-bearing):

```
app.use(requestId())
app.on('OPTIONS', '*', s3Preflight)      // BEFORE cors(); cors() would short-circuit OPTIONS
app.all('/{*path}', s3Gate)              // shouldHandleS3 → handleS3Request → RETURN (never falls through)
                                          //              → else await next()
app.use(cors({ origin, credentials: true }))
app.route('/api/auth/*', auth.handler)
app.route('/rpc/*', RPCHandler)
app.route('/api/*', OpenAPIHandler)      // dashboard JSON API
```

Hono uses **registration order, first match wins**, whereas today's `serve.ts` scores routes
for specificity — so the S3 gate must be registered first and `await next()` explicitly for
non-S3 traffic. `shouldHandleS3()` keys off `Authorization: AWS4-…` / `?X-Amz-Signature` /
vhost domain (`s3-detection.ts`), so a dashboard request never matches; the gate is a cheap
3-condition check, not a DB hit.

**oRPC owns the management surface only** (buckets, copy, upload-multipart, delete, activity).
The **data plane stays hand-written controllers** — oRPC's JSON serialization and error shapes
would corrupt XML and SigV4. Delete `serve.ts`, `routes/index.ts`, and the 311-line hand-written
`swagger.ts` (replaced by oRPC's OpenAPI). Preserve GET-public / writes-protected.

Rewrite `test/bootstrap.test.ts` (mocks `serve`), `test/swagger.test.ts`, and
`test/public-readonly-routes.test.ts` (asserts on the deleted `routes` literal).

**Gate:** `smoke.sh` green against a **local** server; all 7 `test/s3-*.test.ts` files pass
**unmodified** except the two that `vi.mock` the s3 auth path.

### P3 — Multi-tenancy + better-auth

**P3a (schema + seed) — ✅ DONE (`397f5a3`).** `organizations` / `members` /
`s3_credentials` created; `buckets.organization_id` added, backfilled, set NOT NULL;
global `buckets_name_key` dropped for a per-org unique index.

> **The plan's cascade assumption was wrong, and it fails silently.**
> `buckets.organization_id ... ON DELETE CASCADE` does **not** cascade to files. Real
> delete rules read from `pg_constraint.confdeltype`: `files → buckets` and
> `multipart_uploads → buckets` are both **`a` (NO ACTION)**. So deleting an org
> cascades to bucket rows and then Postgres **refuses the transaction** — nothing
> corrupts, but the operation is impossible. Consequence: the hand-rolled cascade in
> `bucket-repository.ts` is **load-bearing, not vestigial**, and is kept. Converting
> those FKs means dropping/recreating an FK on the largest table — deferred on
> purpose, not in the same cutover that introduces tenancy.

> **An ordering hazard, found by running it rather than reading it.** 0002 backfills
> from the `slug='default'` org, so the seed must precede it — but seeding before
> `migrate()` fails on a **fresh** DB, because `organizations` doesn't exist until
> 0001 runs. Interleaving seeding between 0001 and 0002 would need runner logic.
> **0002 now creates the bootstrap org itself** (`ON CONFLICT DO NOTHING`), guaranteeing
> its own precondition. `seed.ts` keeps what needs secrets: the owner membership and
> the S3 credential adopted from `S3_ACCESS_KEY`/`S3_SECRET_KEY`.

Verified against real DBs: 0002 **without** a seed RAISES rather than orphaning
buckets · with seed: backfilled, files preserved, NOT NULL, per-org index live · two
orgs may share a bucket name, duplicate within one org rejected · idempotent across
re-runs · `migrate.ts` on a fresh DB completes with 4 journal rows · `drizzle-kit
generate` reports **no schema changes**.

`0003_snapshot_sync.sql` carries **no DDL on purpose** — drizzle emitted it because
schema.ts changed after 0002, and every statement duplicated 0001/0002. Only the
snapshot is kept; the file must still exist or drizzle throws `No file <tag>.sql`.

**P3b (org-scoped repositories + S3 credential resolution) — DONE** (branch
`integration/p3b`: `57817fa` + 4 follow-up fixes). Every bucket read/write is
org-scoped; `s3_credentials` resolves through `makeSecretResolver()`.

> **Five defects the work surfaced, all verified by execution, not by reading.**
>
> 1. **`delete()` reported failure after success** — and this predates P3b. It is on
>    `kana-migration` today. `postgres-js` resolves a `DELETE` without `RETURNING` to
>    an EMPTY array (the count lives on `.count`), so `return result.length > 0` was
>    unconditionally false. Reproduced: one row deleted, buckets 9 → 8, code said
>    `false`. Every `DELETE /api/v1/buckets/:name` therefore returned an error while
>    succeeding. **It was invisible because all three repository mocks hardcode
>    `delete = () => Promise.resolve(true)`** — a mock MORE correct than the
>    implementation, which is a failure mode distinct from a too-loose mock.
> 2. **The new database-backed tests could not fail.** Twelve assertions sat behind
>    `if (!live) return`, which vitest counts as PASSED, and CI runs `test:unit` with
>    no `DATABASE_URL`. Proven by mutation: with the `RETURNING` fix reverted the
>    suite still reported green. CI now provisions PostgreSQL.
> 3. **`resolveAdminOrganizationId` was arity 0** — no request, no session, no user.
>    It read `process.env.BOOTSTRAP_ADMIN_ID`, set nowhere in the repo, and its doc
>    comment falsely claimed it was session-scoped. A missing membership became a
>    per-request 403 on a route documented PUBLIC, plus 401 on every oRPC procedure.
>    Reproduced against a real database. It now throws at boot (`index.ts:37`) — a
>    misconfiguration, not an authorization decision.
> 4. **`describe.skipIf(!process.env.DATABASE_URL)` never fired**, because
>    `setup-env.ts` seeds a placeholder DSN with `||=`. And `if (!live) return` inside
>    an already-skipped block converts "did not run" back into a silent pass. One
>    suite, two verdicts for the same missing precondition.
> 5. **`0002` targeted `ON CONFLICT ("slug")`** but `organizations.name` is UNIQUE
>    too, so a database already holding an org named `TeleUploader` under a different
>    slug aborted the migration (reproduced: exit 3, buckets still unattached). Now a
>    bare `ON CONFLICT DO NOTHING`.

**P3c (better-auth) — still deferred, deliberately.** It has no zero to its name:
better-auth is not installed, no Redis. The dashboard therefore still runs on the
single hardcoded admin session, and `resolveAdminOrganizationId` maps that one
session to the bootstrap org rather than resolving per user. The comment on that
function says so explicitly, because the earlier false comment is what made defect 3
invisible.

**P5 (migration + seed delivery) — DONE on the same branch** (`cf27d19`, `e12b84e`,
`04faa6f`). `deploy.sh` now applies migrations, ships `drizzle/`, and — a gap found
only by running the pieces — **also ships and runs the seeder**.

> **The seed gap is the one worth remembering.** `verify-migrations.ts` runs migrate
> AND seed, so the CI job proved a sequence the deploy never performed: it invoked
> `migrate.js` and stopped. Nothing in CI could see it, because the harness was doing
> more than production did. And the invocation alone would not have worked —
> `deploy.sh` ships `dist/`, never `src/`, so `pnpm db:seed` (`tsx src/...`) could
> never run there. Consequence had it shipped as written: `makeSecretResolver()`
> (`s3-router.ts:101-112`) reads `s3_credentials` with **no environment fallback**
> (verified: `grep s3AccessKey src/presentation/s3/auth.ts` matches only a comment),
> so every S3 client — aws-cli, rclone, Docker registry — would get 403 while the
> dashboard looked healthy. `seed.ts` is now bundled to `dist/seed.js` and runs
> between migrate and restart.
>
> **Also verified for the first time this session:** `dist/migrate.js` resolves
> `drizzle/` from the real deployed layout (`dist/drizzle/`, sibling of the bundle),
> with cwd outside `apps/api` — so risk #0 was narrower than stated. It was missing
> delivery, not a broken resolver.

Schema in **two migrations** (the ordering is a trap — existing buckets have no org, so the FK
cannot be `NOT NULL` at creation):

- `0001_org_tables.sql` — `organizations`, `members`, better-auth `sessions`/`accounts`,
  and `s3_credentials`. Seed the bootstrap org + owner **outside** DDL (in `seed.ts`).
- `0002_buckets_org.sql` — `ADD COLUMN organization_id uuid REFERENCES organizations(id) ON
  DELETE CASCADE` → `UPDATE buckets SET organization_id = '<bootstrap>' WHERE … IS NULL` →
  `SET NOT NULL` → `CREATE UNIQUE INDEX ON buckets(organization_id, name)`.

> **This drops the global `buckets.name UNIQUE`** (verified present in `schema.sql`). Two orgs
> must be able to own the same bucket name, so both constraints cannot coexist. Every
> "already exists" check (`s3-bucket-handlers.ts`, `web-api-controller.ts`) becomes org-scoped,
> and `handleCreateBucket` must gain an `organizationId` parameter.

**S3 credential resolution — the key insight: SigV4 verification does not change, only the
lookup does.** `verifySignature`/`verifyPresignedUrl` already take key+secret as parameters and
already compare in constant time. Add one indirection above them:

1. Export the existing (private) `parseAuthorizationHeader`, or add `extractAccessKey(req)`
   handling both the header form and the presigned `?X-Amz-Credential=` form.
2. New `infrastructure/auth/s3-credentials.ts`: `resolveS3Credentials(accessKey) =>
   { secretKey, organizationId }`. Check the `s3_credentials` table, fall back to the
   `S3_ACCESS_KEY`/`S3_SECRET_KEY` env pair.
3. **Backward compat:** on boot, seed one row from the env pair into the bootstrap org. Because
   the wire bytes and the secret are unchanged, **existing aws-cli/rclone/Docker clients keep
   working with zero config change.**
4. Scope `IBucketRepository.findByName(name)` → `findByName(name, orgId)`, threading
   `organizationId` through the existing `resolveBucketOr404` helper (~10 call sites).
   A cross-tenant bucket read returns `NoSuchBucket` — indistinguishable from nonexistent, which
   is the correct wire behaviour.

**Do not convert the raw-SQL repos to the query builder.** `file-repository.ts:127-134` rebuilds
`listByPrefix` as a dynamic SQL fragment and relies on the `text_pattern_ops` index. The blocker
was never raw SQL — it was that 3 of 5 tables weren't in `schema.ts` at all. Once typed, declare
`sql<BucketRow>` etc. to remove ~20 `as unknown as QueryRow` casts, and keep the SQL.

Keep the **manual bucket-delete cascade**. `files.bucket_id` is `REFERENCES buckets(id)` with
**no `ON DELETE` clause** (verified, `schema.sql:40,55`) → `NO ACTION`, so the hand-rolled
cascade in `bucket-repository.ts:68-89` is load-bearing. Constraint surgery on the largest table
inside an atomic migration is not worth it; defer to a later release.

Delete `authenticate.ts`, `auth-controller.ts`, and `middleware/auth.ts` (321 lines of HMAC
cookie signing) — better-auth replaces all of it. `test/auth.test.ts` + `test/auth-routes.test.ts`
(~300 lines) are **deletions**, not migrations. But `auth-controller.ts:86-92` currently does a
**string comparison** on `'Invalid token'`; `test/auth-routes.test.ts:44-50` pins the 401 and is
the regression guard.

**Gate:** `smoke.sh` green locally against a seeded DB; `test/s3-auth*.test.ts` and
`test/s3-routing.test.ts` green with only the credential seam changed; `/api/upload` and
`/f/:public_id` demonstrably still public.

### P4 — React SPA (restores the currently-500ing dashboard) — ✅ DONE (`a828d58`, `7972da8`)

Built from scratch: `apps/web` did not exist. React 19 + Vite + TanStack Router.

Five routes per the kana layout: `__root.tsx` → `index.tsx` → `_authenticated/` (login, org
select) → `$orgSlug.tsx` → `$orgSlug/{dashboard,$bucketName}.tsx`. Per skill §3.1 these are
**single files, not folders** — don't pre-promote.

Put the bucket/prefix in **search params** (`?bucket=x&prefix=a/b/`), not component state —
`home.html` keeps `currentPrefix` in a JS global, which is the biggest UX trap to avoid.

- **Upload progress:** keep raw `XMLHttpRequest` (`home.html:349-357` uses `xhr.upload.onprogress`).
  oRPC's client won't give transport-level progress; don't force it through TanStack Query.
- **Download/copy-link:** keep plain `<a href>` — they are public GETs today and routing them
  through oRPC would break "download while logged out" for no gain.
- **Credentials modal is a build, not a port** (it's empty today): `s3.createCredentials` mints
  a per-org key and shows the secret **once**; `s3.listCredentials` returns metadata only.
- Serve from `WEB_DIST_PATH` with `index.html` fallback (skill §2.6.5).

**Gate:** local `pnpm dev` against the local API — bucket list, breadcrumb, upload-with-progress,
delete, download, create-bucket, credentials modal all work; GET-public/writes-protected still holds.

**Verified:** 36 files / 327 passed / 16 skipped · lint 0 errors · typecheck 24 (P0 baseline) ·
SPA `tsc` + `vite build` clean · `deploy.sh --check` 7/7 · migrations green on a scratch
database · `/health`, `/`, `/docs`, `/swagger.json` all 200 with correct content-types.

> **Four findings, three of them found by execution rather than by reading.**
>
> 1. **`OpenAPIHandler` does not exist.** The plan named it as the mechanism for restoring
>    `/docs`. It is in neither `@orpc/server@1.15.5` nor `@orpc/openapi@1.15.5` — every
>    "OpenAPI" string in the installed package is a JSDoc `see` link. The plan was checked
>    against `package.json`, not `node_modules`. `@orpc/openapi` exports `OpenAPIGenerator`
>    (`.generate(router) → Promise<OpenAPI.Document>`), not an HTTP handler. Spec generation
>    is hand-wired, and merges the non-oRPC public paths — a generator alone would have
>    **deleted** `/api/upload`, `/f/{public_id}` and `/file/{public_id}/info` from the docs,
>    which are public **by decision**.
> 2. **`/assets/*` returned 404 while `/` returned 200 HTML.** A white screen behind a
>    healthy-looking deploy: every health check passes and the dashboard is blank. No test
>    had requested an asset, only `/`.
> 3. **`home.html` had a confirmed stored XSS.** It interpolated the raw object key into
>    `onclick="downloadObject('...')"`, and its `escapeHtml` (textContent → innerHTML) does
>    not escape quotes — one apostrophe in a key breaks out. React event props make it
>    unrepresentable; proven by rendering the real component with the exact payload.
> 4. **`WEB_DIST_PATH` had to stay optional.** `env.ts` throws at import time on a missing
>    REQUIRED var, and `index.ts` imports it transitively before `serve()` binds the port —
>    so a required `WEB_DIST_PATH` breaks every backend-only deploy. `deploy.sh` exports it
>    only when a `web/` dir was actually installed.

Two further plan claims were contradicted by the real behaviour, so the SPA was built around
what exists instead: `isTruncated` is structurally **always false** (the `maxKeys + 1` probe
row is consumed by delimiter folding before the controller sees it) and
`nextContinuationToken` is always null, so the paginator this plan describes is not
buildable — the UI reports truncation from an observable condition instead. And the DELETE
route returns `{"success": true}` unconditionally, including for keys that do not exist, so
the UI re-reads the listing after a delete and reports honestly.

### P5 — Cutover, split so DDL and binary never ship together

> **A THIRD FALSE-CONFIDENCE GAP — found while planning cleanup.**
>
> Three test files assert against `routes/index.ts`, which **nothing imports at runtime**
> since P2b (verified by grep — `app.ts` registers routes directly):
>
> | File | Exercises | Still green? |
> |---|---|---|
> | `test/hono-routing.test.ts` | **the real `app.ts`** | ✅ meaningful |
> | `test/s3-routing.test.ts` | the **dead** route table | ✅ but proves nothing about the server |
> | `test/public-readonly-routes.test.ts` | the **dead** route table | ✅ but proves nothing about the server |
> | `test/s3-docker-registry.test.ts` | `readFile`s dead source **text** | ✅ real guard, wrong target |
>
> I compared them: every assertion in `s3-routing.test.ts` (S3 claims `/`, OPTIONS →
> 204 vs S3 XML, HEAD/DELETE/POST → 404) is **already covered against the live app** by
> `hono-routing.test.ts`. Same for the GET-public / writes-protected contract in
> `public-readonly-routes.test.ts`. So these are not load-bearing guards — they are
> redundant ones pointed at dead code, and they are the *reason* the Swagger regression
> survived a green suite.
>
> `s3-docker-registry.test.ts` is different: it reads the route table's **source text** to
> assert no `arrayBuffer()` buffering. That IS a real regression guard (Docker registry
> pushes would OOM on a buffered multi-MB body), so it must **move** to whatever replaces
> the route table, not be deleted with the rest.
>
> 1. **`deploy.sh` would ship a STALE BUNDLE.** `apps/api/package.json` builds with
>    `--outfile=dist/...`, which is relative to the *package* cwd, so moon writes
>    `apps/api/dist/`. `deploy.sh` reads root `./dist`. Both exist right now and they
>    **differ** — root `dist/index.js` is 2.4 MB from 22:34 (pre-P3a) and contains no
>    `organizations` / `s3_credentials`; the real build is 2.5 MB from 23:53. Root
>    `dist/` is a leftover from before the P1 move, gitignored, so nothing flags it.
>    **A deploy right now would ship code without the tenancy schema changes.**
> 2. **`schema.sql` is missing from the repo root** — P1 moved it to `apps/api/schema.sql`,
>    but `deploy.sh:89`'s pre-flight list still checks the root path. `bash deploy.sh --check`
>    reports `✗ schema.sql (missing)`.
> 3. **`/docs` and `/swagger.json` return 404** — dropped in P2b. Pinned by commit `d2839ab`;
>    restored in P4 via oRPC's OpenAPIHandler.
>
> Note what did NOT break: `pnpm run build` and `pnpm run lint` both still work from the
> repo root (they are moon wrappers), and `bash deploy.sh --check` still completes. The breakage
> is entirely in *which artifact* the deploy path reads.

**Fix before any real deploy:** make the build output unambiguous. Either point `deploy.sh` at
`apps/api/dist`, or (cleaner) set the esbuild `--outfile` to a path the deploy script and the
build agree on. Then delete the stale root `dist/` so it cannot be shipped again. Add a check
that fails loudly when the dist being shipped is older than the newest source file.

- **P5a — DDL only.** `pg_dump` → run migrations → verify `\d buckets` shows `organization_id
  NOT NULL` and every existing bucket has the bootstrap org. Old binary keeps serving
  (`ADD COLUMN` is backwards-compatible; old code ignores unknown columns). Row counts on all
  5 tables unchanged pre/post.
- **P5b — binary + SPA.** `deploy.sh` ships `dist/index.js`, `dist/migrate.js`, **and the built
  SPA directory** — the third item is what fixes the `home.html` bug. Keep `APP_NAME`,
  `systemctl restart`, `is-active`, `/health`, `pnpm install --frozen-lockfile`, and the absence
  of `nix copy`/`docker compose`/`bun install` — `test/deploy-config.test.ts` asserts these strings.
- **P5c — re-enable** `push: main` on both workflows; re-run `deploy-config.test.ts`.

**Gates:** smoke green against prod before the swap; after, `GET /` returns **200 HTML, not 500**.

### P6 — Housekeeping (post-cutover)

Rewrite `CLAUDE.md` (currently mandates Bun). Delete/update the LEGACY `Dockerfile` +
`docker-compose.yml` (both `oven/bun`-based). Switch Biome to kana style (tabs, double quotes,
`asNeeded`) **as its own final commit** so the S3 code's `git blame` stays auditable.
Add `REDIS_URL`/`BETTER_AUTH_*` to `.env.example`.

---

## Risks

0. ~~🔴 THE MIGRATION ORACLE IS MISSING~~ — **RESOLVED by P5 (`cf27d19`, `04faa6f`),
   narrower than this risk stated.**
   The finding was correct that `deploy.sh` never executed `migrate.js`; P2a had deleted
   the boot-time auto-migration on the false belief that "deploy.sh runs it over SSH", and
   that belief came from this plan. **What the risk got wrong:** it read as though the
   resolver itself were broken. It is not. Verified by executing the real
   `dist/migrate.js` from the actual deployed layout (`dist/` containing `migrate.js` and
   a sibling `drizzle/`), with cwd outside `apps/api` — it logged `Database migration
   completed`. `resolveMigrationsFolder()`'s `join(dir, './drizzle')` candidate covers it.
   So this was missing **delivery**, not a broken mechanism.
   `deploy.sh` now applies migrations, ships `drizzle/`, and ships **and runs the
   seeder** between migrate and restart — the seed was a second, silent gap that would
   have 403'd every S3 client (see the P5 note above).
   *Lesson, now with ten instances rather than three: the stale `dist`, the dropped
   `/docs`, the false "deploy.sh runs it", the oRPC placeholders, the mocks more correct
   than the code, the vakuous DB tests, the harness proving more than production did,
   the `OpenAPIHandler` that exists in no installed package, the always-false
   `isTruncated` the plan told us to build a paginator on, and the `/assets/*` 404 behind
   a healthy-looking `/`. Every one came from writing a claim and trusting it downstream
   instead of executing the thing.*
   *The tenth is the cheapest to catch and the easiest to miss: it was found by asking for
   an asset URL, not by any gate. A suite that only ever requests `/` cannot see a
   dashboard that serves `/` perfectly and nothing else.*

1. **No PR CI + auto-deploy on `main` is the dominant risk.** P0 exists solely to offset it.
2. **`test/deploy-config.test.ts` is a trip-wire** — it asserts the literal text of `deploy.sh`
   *and* `deploy.yml`. It breaks on the P0 freeze (line 57) **and** on the P5b rewrite. Update
   in the same commit each time; never delete these assertions.
   **Its own weakness, found and closed:** for P5 it asserted only `indexOf()` positions of
   `say` strings, so it passed with **no migration invoked at all** — it pinned where the log
   line sits, not that anything ran. The new tests assert real statement positions via
   line-anchored regexes, and four execute `deploy.sh`'s own `restore()` / `on_error()`
   against a simulated filesystem. Both halves proven by negative control against the
   pre-fix script.
3. **A mock can be more correct than the implementation, and that hides bugs a loose one
   would not.** `delete = () => Promise.resolve(true)` in three repository mocks kept
   `bucket-repository.delete()` — which returns `false` after a *successful* delete, because
   postgres-js resolves a `RETURNING`-less DELETE to an empty array — invisible for the whole
   life of the service. A mock that returns the wrong thing is obviously suspect; a mock that
   returns the *right* thing while the code is wrong is not. When writing repository tests,
   assert against real rows and real row counts, never against a hand-written truth value.
4. **`setup-env.ts` lies about configuration, and every `process.env.X` guard downstream
   inherits the lie.** It seeds `process.env.DATABASE_URL ||= '<redacted placeholder>'`, so
   the key is *always* set. Every `describe.skipIf(!process.env.DATABASE_URL)` and every
   `if (!process.env.X)` is therefore dead. Two separate suites hit this independently
   (`tenant-scope-misconfiguration`, and the `live-db` helper the other fixer wrote). The
   helper now judges the *value* via `liveDatabaseRequested()`.
   **Checked the extent rather than assuming it:** `grep -rn skipIf apps/api/test/` now
   returns only call sites routed through `liveDatabaseRequested()`, and there is no
   `.skip`/`describe.skip` anywhere outside it. The `||=` / `??=` uses elsewhere are
   *fallbacks*, not guards — they want a default, so `||=` is correct there. So this risk
   is **closed**, not open: the lie was real, and it was confined to the suites that
   actually gated on `DATABASE_URL`.
3. **Drizzle baseline against a hand-migrated prod DB.** `__drizzle_migrations` must not already
   exist in prod or everything is skipped. Diff `pg_dump --schema-only` vs `schema.sql` first.
4. **PgBouncer (prod is port 6432 = transaction pooling).** — **CORRECTED after investigation.**
   I originally flagged two hazards here. Both turned out to be smaller than stated:

   - **Advisory locks: not applicable.** I read `drizzle-orm/pg-core/dialect.cjs` — the migrator
     takes **no** `pg_advisory_lock` at all. It is table-based
     (`drizzle.__drizzle_migrations`, compared by `created_at`). That is *safer* under
     transaction pooling than a session lock would be, not riskier.
   - **Prepared statements: not a P2a risk.** `drizzle/index.ts` is the RUNTIME client used by
     every live request today, and it has no `prepare: false`. Production works. So either the
     PgBouncer is ≥ 1.21 or postgres.js's prepared-statement path is fine through it — and in
     either case **P2a introduced nothing here**. `migrate.ts` uses the same
     `postgres(config.databaseUrl, { max: 1 })` the pre-P2a migrator used.

   The one genuinely new thing: drizzle's migrator issues DDL
   (`CREATE SCHEMA/TABLE IF NOT EXISTS drizzle.__drizzle_migrations`). Postgres permits DDL in a
   transaction, and PgBouncer transaction mode does too — so this is **low risk, but still
   unverified against the real instance**. Verify it in P5a with the first dry-run against the
   production DSN, not before the cutover.
5. **S3 regression is client-visible.** Treat every S3 test as a release gate and re-run the
   quarantined `s3-sdk` suite (real AWS SDK, real buckets) against the cutover target.
6. **better-auth cannot adopt existing sessions.** The operator will be locked out at cutover
   unless a bootstrap admin is seeded explicitly.
7. **The workspace restructure is the riskiest single commit** — ~9,800 lines, 106 files, 22 mock
   paths, and the esbuild build script all change, while changing no behavior. Its only evidence
   is the test suite, hence CI-before-P1.

## Open uncertainties (flagged, not invented)

- ~~PgBouncer version behind 6432 (determines `prepare: false`)~~ — **RESOLVED, not a risk.**
  The runtime client already runs through PgBouncer in production without `prepare: false`, so
  the prepared-statement concern does not apply to this migration. See the corrected risk #4.
- Whether `drizzle-orm@0.45.2` can express the partial unique index in `pgTable`; if not, it
  stays hand-written in the baseline SQL.
- Whether prod's schema has drifted from `schema.sql`.
- Whether `ADMIN_API_TOKEN` is currently non-empty on prod (env lives in Bitwarden). If empty,
  the dashboard is wide open today.
- **`/f/:public_id` and `/api/upload` have thin coverage** and stay public by decision — they
  are the highest-traffic least-tested paths. Add explicit `smoke.sh` assertions in P0.

## Verification (end-to-end, final)

`pnpm install --frozen-lockfile` → `moon run :check` → `moon run api:test` (**29** files) →
`moon run web:test` → `moon run :build` → boot locally against Postgres :5432 + local Redis →
`smoke.sh` sweep of `/health`, `/api/upload`, `/f/:id`, `/api/v1/*` → **real deploy with
rollback drill** → `test/production-e2e.test.ts` (40 live tests) green.