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
process.env.BOT_TOKENS = '123456:ABC-DEF,789012:GHI-JKL,345678:MNO-PQR';
process.env.STORAGE_CHANNEL_ID ||= '-1001234567890';
// Vitest/Vite seeds process.env from import.meta.env before the setup file
// runs, so BASE_URL arrives as vite's `base` ("/") and defeats the `||=`
// fallback (bun never did this). Treat anything that is not an absolute
// http(s) URL as "unset" so every test gets the same value bun gave it.
const seededBaseUrl = process.env.BASE_URL;
if (!seededBaseUrl || !/^https?:\/\//.test(seededBaseUrl)) {
  process.env.BASE_URL = 'https://example.com';
}
process.env.DATABASE_URL ||= 'postgresql://asephs:***@100.121.180.82:6432/test';
process.env.PORT ||= '4000';
process.env.NODE_ENV = 'test';

// Pin the chunk size to the safe 19 MB value UNCONDITIONALLY. Bun auto-loads
// the repo .env before preloads run, and a stale oversized value there would
// trip the fail-fast guard in src/env.ts and break every test file's import.
// Tests that need a different value set it explicitly in their own process.
process.env.TELEGRAM_CHUNK_SIZE_BYTES = String(19 * 1024 * 1024);

// Keep old env names for backward compat with tests that reference them directly
