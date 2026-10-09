# TODO — Kana migration

Items that **cannot be done from the development workstation**. Each one needs
credentials, infrastructure, or a human decision that a coding agent must not
make alone.

Status legend: `[ ]` open · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Cutover

These block the big-bang cutover. Everything above them is complete and
branch-verified.

### `[!]` 1. `pg_dump` the production database

The P0 plan lists this as the first cutover step and it is still not done.

**Why it is not optional.** `deploy.sh`'s rollback restores `*.js` and `drizzle/`,
but it **cannot reverse DDL**. The P3 tenancy migration is not additive:

- `ALTER TABLE buckets ALTER COLUMN organization_id SET NOT NULL`
- `DROP CONSTRAINT buckets_name_key` (the global `buckets.name` UNIQUE)

If the binary rolls back and the schema does not, the old code fails on
`organization_id NOT NULL` with no default. This was reproduced locally during
P5 — the rollback is safe in one direction only.

**Needs:** SSH to the VPS, plus the Bitwarden-managed `DATABASE_URL`.

**Do this before** deploying anything that runs `migrate.js` in production.

---

### `[ ]` 2. P5a — dry-run migrations against the production DSN

Migrations have only ever run against a local PostgreSQL 18.6 on port 5432.

**The one genuinely unverified risk** (plan risk #4): production is behind
**PgBouncer on port 6432**, transaction pooling. Two hazards were investigated
and *closed*:

- **Advisory locks — not applicable.** The drizzle migrator is table-based
  (`drizzle.__drizzle_migrations`, compared by `created_at`) and takes no
  `pg_advisory_lock`. That is *safer* under transaction pooling, not riskier.
- **Prepared statements — not a new risk.** `drizzle/index.ts` is the runtime
  client used by every live request in production today and has no
  `prepare: false`.

What remains: drizzle's migrator issues DDL (`CREATE SCHEMA/TABLE IF NOT
EXISTS drizzle.__drizzle_migrations`). PostgreSQL permits DDL in a transaction
and PgBouncer transaction mode does too — so this is **low risk but genuinely
unverified against the real instance**.

**Needs:** production `DATABASE_URL`. Run against a copy first, never the live
database, and take item 1's dump before starting.

---

### `[ ]` 3. P5b — production deploy + rollback drill

Deploy, confirm health, then **deliberately** trigger a rollback to prove it
works before relying on it. The schema/binary skew in item 1 makes the drill
worth more than the deploy itself.

**Post-deploy smoke, all of which must be verified against the real instance:**

| Check | Why it matters |
|---|---|
| `GET /` → 200 HTML | Was a 500 in production until P4 (deploy.sh never shipped `home.html`). |
| `GET /health` | The deploy probe's target. |
| `GET /docs`, `/swagger.json` → 200 | Were 404 since P2b. |
| Signed `s3api list-buckets` | Proves `seed.ts` actually adopted the S3 credential. |
| `GET /f/:public_id` unauthenticated | Must stay **public** — the user's explicit decision. |
| `POST /api/upload` unauthenticated | Must stay **public** — the user's explicit decision. |

---

### `[ ]` 4. Confirm whether `ADMIN_API_TOKEN` is set on production

**Unverifiable by construction.** The credential lives in Bitwarden and the
repository's `setup-env.ts` DSN is redacted (`asephs:***`) — which is correct
behaviour, and means no agent can answer this by reading anything.

If it is empty, **the dashboard is currently wide open**: every
`POST`/`DELETE`/`PUT` on `/api/v1/*` and every `/rpc/*` procedure is
unauthenticated, and bucket creation and deletion are reachable by anyone who
can reach the host.

**Needs:** Bitwarden access. Check before the cutover, not after.

---

## Registry access

### `[ ]` 5. Join the Gitea remote

The repo mirrors to Gitea via `.github/workflows/mirror-gitea.yml`, which runs
`git push --mirror` — a **force push that overwrites remote refs wholesale**.

`mirror-gitea.yml` is one of the three workflows the P5c unfreeze restores
`push: branches: [main]` on. Restoring it means a single merge to `main`
force-pushes every ref to Gitea.

**This is a human decision.** The workflow agent was instructed to restore the
trigger and flag the hazard rather than decide it alone; that flag is where this
item came from. Before the first merge to `main` after P5c:

1. Confirm the Gitea remote URL and that it is reachable.
2. Confirm nothing else pushes to that remote — a `--mirror` from a repo that
   is not the sole owner of its refs will destroy branches.
3. Decide whether P5c restores all three workflows, or defers `mirror-gitea.yml`
   to its own change.

---

## Deferred by decision

Not blocked — deliberately postponed. Listed so the deferral stays visible
instead of decaying into an assumption that someone meant to do them.

### `[ ]` 6. P3c — better-auth + Redis

Neither package is installed. There is **no zero to this phase's name**: the
dashboard still runs on a single hardcoded admin session, and
`resolveAdminOrganizationId()` maps that one session to the bootstrap
organization rather than resolving per user.

**Why this is load-bearing to document.** `AuthSession` carries only a hardcoded
`username: 'admin'`. An earlier comment on that function claimed it was
session-scoped, and that false comment is what hid defect #3 — the function was
arity-0, reading `process.env.BOOTSTRAP_ADMIN_ID`, which is set nowhere in the
repository. A missing membership became a per-request 403 on a route documented
public.

**Consequence for multi-tenancy:** with one hardcoded session, there is exactly
one organization in practice. The schema, the repositories and the S3 credential
resolution are genuinely multi-tenant, but nothing yet *exercises* more than one
tenant through the API. Item 7 is the test of that.

---

### `[ ]` 7. Cross-tenant isolation test through the API

`tenant-isolation.test.ts` and `s3-credential-lookup.test.ts` cover the
repositories against a real database. Neither exercises **two organizations
through the running API** — no second session exists to authenticate as, until
item 6 lands.

**Needs:** item 6.

---

### `[ ]` 8. Quarantined live-network suites against the cutover target

Five suites hit the live production endpoint and create and destroy real buckets.
They are opt-in (`workflow_dispatch`) and are the only coverage of the S3 wire
protocol with real clients — `s3-sdk.test.ts` uses the real AWS SDK.

The plan's risk register calls S3 regression **client-visible**: the S3 surface
is ~2,900 lines of hand-rolled SigV4, XML, Range and multipart that must stay
byte-compatible for aws-cli, rclone, s3cmd and Docker registry clients.

**Needs:** item 3, plus `S3_SECRET_KEY` and `ADMIN_API_TOKEN` from Bitwarden.
Run these against the cutover target, not the current build.

---

### `[ ]` 9. Docker registry push regression

`s3-docker-registry.test.ts` guards against `arrayBuffer()` buffering, because
Docker registry pushes would OOM on a buffered multi-GB body. It is a real
guard that was pointed at a dead route table and has been re-aimed at the live
app path.

**Re-aimed and proven to still bite** — negative control, by injecting
`streamBodyToTemp(await req.arrayBuffer())` into the real
`s3-object-write.ts:119` and running the quarantined suite:

```
FAIL  test/s3-docker-registry.test.ts > S3 Streaming Upload Safety >
      uses streaming instead of req.arrayBuffer() for PUT body
AssertionError: expected '…' not to match /req\.arrayBuffer\(\)/
      Tests  1 failed | 9 passed (10)
```

Restored afterwards; the failure named the sabotaged line, not a collection
error — which is what distinguishes a guard that bites from a file that merely
failed to load.

**What has still never run:** a real registry push against production.

**Needs:** item 3.

---

### `[ ]` 10. `web-api-controller` — the DELETE catch-all shadows reserved segments

Found by P4's inspect lane, verified against a real database. **Data-loss
class, unfixed.**

`handleWebApiV1` checks `DELETE` on `{bucket}/{key}` before the `/download`,
`/objects`, `/upload` and `/copy` branches, and the delete branch excludes
nothing (`web-api-controller.ts:466-470`). A file named `download/…`,
`objects`, `upload` or `copy` at a bucket root is therefore deleted by a
stray DELETE:

```
DELETE /api/v1/buckets/probe/download/keepme.txt -> 200 {"success":true}
DB afterwards: download/keepme.txt | t   <- soft-deleted by a request meant to DOWNLOAD it
DELETE /api/v1/buckets/probe/objects            -> 200 {"success":true}
DELETE /api/v1/buckets/probe/upload             -> 200 {"success":true}
DELETE /api/v1/buckets/probe/copy               -> 200 {"success":true}
```

Two independent defects in the same handler:

- **Reserved-segment shadowing** (above). The fix is to reject reserved
  segments in the delete branch, or to order the dispatch so the specific
  handlers win.
- **`{"success": true}` is unconditional.** Deleting a key that does not
  exist also returns 200; whole-key `%2F`-encoded deletes return 200 without
  deleting anything. The P4 SPA works around this by re-reading the listing
  after a delete (`assertDeleted`) rather than trusting the response — the
  server still lies.

**Neither is fixed.** The SPA workaround means the UI is honest, but the API
is not. Needs a regression test per branch before the fix, not after.

---

### `[ ]` 11. `GET /api/v1/buckets` is public

By design `GET /api/v1/*` is registered bare and only writes are wrapped in
`requireAuth` (`app.ts:296-299`). That means **every bucket name and object
count is world-readable** to an unauthenticated caller:

```
GET /api/v1/buckets   (no cookie) -> 200 {"buckets":[{"id":"…","name":"…"}]}
```

This is a deliberate part of the "GET-public / writes-protected" contract from
the migration plan, so it is listed here rather than fixed. It is a security
decision, not an oversight — but bucket names are not obviously public
information, and the plan never asked. **Confirm this is intended before
cutover.**

---

## Housekeeping

Deferred to P6, deliberately sequenced after the cutover rather than before it.

### `[ ]` 12. Rewrite `CLAUDE.md`

Currently mandates Bun (`bun test`, `Bun.serve()`, `don't use pg`, `bun build`)
while the repo is pnpm + Node + esbuild + Vitest, and cites files deleted during
the migration. **Actively wrong** — it will misdirect the next agent or
contributor.

### `[ ]` 13. Dockerfile and docker-compose.yml

Both are `oven/bun`-based. `deploy.sh` deliberately does not Dockerize — the
systemd unit runs `/usr/bin/node dist/index.js`. They describe a runtime this
project no longer has.

### `[ ]` 14. Biome style switch (kana: tabs, double quotes, `asNeeded`)

Must be its **own final commit** so the S3 files' `git blame` stays auditable.
Doing it earlier would rewrite 2,900 lines of untouched hand-rolled code and
destroy the one piece of history that explains why it is that way.

### `[ ]` 15. `REDIS_URL` / `BETTER_AUTH_*` in `.env.example`

Lands with item 6.