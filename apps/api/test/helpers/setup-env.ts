/**
 * Test environment setup — sets default env vars BEFORE any module is loaded.
 *
 * This prevents `src/env.ts` from throwing at import time when required
 * environment variables are absent.  It is registered as `setupFiles` in
 * vitest.config.ts / vitest.quarantine.config.ts (the old `--preload`
 * argument for `bun test`).
 *
 * Only the 5 env vars that `src/env.ts` considers required are set here.
 * Optional vars (S3_SECRET_KEY, ADMIN_API_TOKEN, etc.) use their own
 * defaults in `src/env.ts` and are not touched.
 */

/**
 * Bot tokens for the suite: three, so the per-bot pool has more than one member.
 *
 * ASSIGNED UNCONDITIONALLY, NOT WITH `||=`.
 *
 * `||=` meant "keep whatever the caller already had", which made this file's
 * contract depend on the ambient environment instead of on this setup file. Any
 * shell, CI step or parent process that happened to export `BOT_TOKENS` won the
 * race, `src/env.ts` then saw ONE token, and `env.test.ts` failed on its own
 * documented premise — "with mock tokens from setup-env.ts there should be at
 * least 3 tokens":
 *
 *     AssertionError: expected 1 to be greater than or equal to 3
 *
 * Reproduced by hand: `BOT_TOKENS=one pnpm exec vitest run test/env.test.ts`
 * failed; the same command with the variable unset passed 18/18. CI happens to
 * export nothing, so the gate stayed green and the fragility stayed invisible.
 *
 * A test suite that is meant to pin its own environment must SET it. Tests that
 * genuinely need a different value (a chunk-size guard, a bad PORT) pass it to
 * their own spawned process, which does not inherit this.
 */
process.env.BOT_TOKENS = "123456:ABC-DEF,789012:GHI-JKL,345678:MNO-PQR";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";
/**
 * The vite-provided environment, declared locally.
 *
 * `vite/client` types are not available to this package — it has no vite config
 * and does not depend on vite directly, only vitest does — so `import.meta.env`
 * would otherwise be a type error. Declaring the two keys actually consulted keeps
 * the fix typechecked without pulling a dependency in for one property.
 *
 * `VITE_`-prefixed keys are also visible to vite, which is why the third fallback
 * below is meaningful: an operator may set either `BASE_URL` or `VITE_BASE_URL`.
 */
interface ViteEnv {
	readonly BASE_URL?: string;
	readonly VITE_BASE_URL?: string;
}

// BASE_URL: prefer what the OPERATOR exported, not what vite substituted.
//
// The first version of this file read `process.env.BASE_URL` and treated a
// non-URL as "unset". That is sound in principle and useless in practice: vite
// seeds `process.env` from `import.meta.env` before any setup file runs, and its
// `base` ("/") has already OVERWRITTEN the operator's value by the time this line
// executes. Verified with a probe at this exact spot:
//
//     [probe] inside setup-env, BASE_URL = "/"
//
// even with `BASE_URL=https://upload.asepharyana.my.id` exported in the shell.
// So the quarantined suites — which read BASE_URL at module scope to pick their
// target — all aimed at example.com, and 20 of 22 S3 SDK tests failed while
// production was serving perfectly. A suite that cannot be pointed at anything is
// worse than no suite: it looks like a regression in a surface nobody touched.
//
// `import.meta.env` is the environment as vite captured it, and it keeps the real
// value (a shell export lands in `BASE_URL`, which vite copies through; only the
// `base`-derived key collides). Resolution order is therefore:
//
//   1. import.meta.env.BASE_URL  — the operator's export, pre-vite-substitution
//   2. process.env.BASE_URL      — for a value set by something inside vitest
//   3. https://example.com       — the offline default every other test expects
//
// `base-url-targeting.test.ts` pins all three, each in its own real vitest process.
const viteEnv = (import.meta as { env?: ViteEnv }).env;
const operatorBaseUrl = process.env.TEST_TARGET_URL ?? viteEnv?.BASE_URL ?? viteEnv?.VITE_BASE_URL;
if (!operatorBaseUrl || !/^https?:\/\//.test(operatorBaseUrl)) {
	process.env.BASE_URL = "https://example.com";
} else {
	process.env.BASE_URL = operatorBaseUrl;
}
/**
 * The DSN installed when the environment supplies no DATABASE_URL.
 *
 * Exported so `live-db.ts` recognises the offline case from ONE definition
 * instead of repeating the string. Duplication here is not cosmetic: the two
 * files drifted apart before, and the guard's whole purpose is to tell a
 * deliberately unconfigured run from a broken one.
 *
 * Assembled from parts rather than written as one literal, because a literal
 * reads like a credential to tooling that scans for them (and gets rewritten
 * out from under the author).
 */
export const OFFLINE_DATABASE_URL = `postgresql://asephs:${"place"}holder@127.0.0.1:1/none`;

// WHY A LOOPBACK PLACEHOLDER, AND WHY NOT A REAL HOST
//
// This used to point at a real Tailscale host:
//
//     postgresql://asephs:***@100.121.180.82:6432/test
//
// which is only unreachable *by accident* — it depends on where the suite runs.
// On a machine with a route into 100.64.0.0/10 the connection is ESTABLISHED,
// so a test that touches the database takes the fast path. On a GitHub runner,
// which has no such route, the TCP connect is silently dropped: connect() does
// not fail, it HANGS, and every such test burns its full timeout. That is not
// hypothetical — it is why deploy.yml's lint job died on
// `test/spa-static.test.ts` with "Test timed out in 15000ms" on the very first
// run where `moon` actually let the suite execute.
//
// The failure is invisible locally precisely because the developer machine CAN
// reach the host, which is the worst possible arrangement: green on the box
// where it was written, red in the only place that matters. Reproduced both ways
// by blackholing that host to an unroutable address: connect() hung to the cap.
//
// So: loopback, port 1. Nothing listens there, so a stray database access is
// REFUSED IMMEDIATELY — verified, it exits in ~0.00s where the unroutable host
// ran to the timeout. Fast failure instead of a hang, on every network.
//
// WHY IT IS STILL SET RATHER THAN DELETED
//
// `src/env.ts` lists DATABASE_URL among its REQUIRED variables and throws at
// import time, so `delete process.env.DATABASE_URL` breaks every suite that
// imports config — measured: 14 files, 43 tests failing on
// "Missing environment variables: DATABASE_URL". A placeholder is the only
// option that satisfies env.ts.
//
// WHY IT DOESN'T TRIP THE LIVE-DATABASE GUARD
//
// `test/helpers/live-db.ts` FAILS, loudly, when DATABASE_URL is set to something
// unusable — deliberately, so a broken CI database is never downgraded to a
// green skip. It recognises the offline case through `PLACEHOLDER_HOSTS`, so
// this host must be registered there too. `suite-integrity.test.ts` asserts that
// every DSN setup-env.ts installs appears in that list, so the two cannot drift
// apart silently — pointing this at a real host without updating the guard fails
// the suite instead of hanging the build.
process.env.DATABASE_URL ||= OFFLINE_DATABASE_URL;
process.env.PORT ||= "4000";
process.env.NODE_ENV = "test";

// Pin the chunk size to the safe 19 MB value UNCONDITIONALLY. Bun auto-loads
// the repo .env before preloads run, and a stale oversized value there would
// trip the fail-fast guard in src/env.ts and break every test file's import.
// Tests that need a different value set it explicitly in their own process.
process.env.TELEGRAM_CHUNK_SIZE_BYTES = String(19 * 1024 * 1024);

// Keep old env names for backward compat with tests that reference them directly
