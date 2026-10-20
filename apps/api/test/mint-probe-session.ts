/**
 * Mints one real session row and prints a ready-to-use cookie.
 *
 * Used to drive HTTP-level checks against a booted server (see `http-boot-harness.ts`)
 * without going through Google — the OAuth flow needs a real client id, a real browser,
 * and a real Google account, none of which exist in a verification environment.
 *
 * Prints `{"cookie": "...", "slug": "..."}` on the last line, so a shell can capture it:
 *
 *   OUT=$(tsx test/mint-probe-session.ts | tail -1)
 *   COOKIE=$(echo "$OUT" | jq -r .cookie)
 *
 * This is a development/verification tool. It creates a genuine row in the real
 * `sessions` table, so it must only ever point at a scratch database.
 */

process.env.BOT_TOKENS ||= "";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";

const { DrizzleIdentityRepository, generateSessionToken, hashSessionToken } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);
const { config } = await import("../src/env");

const repo = new DrizzleIdentityRepository();

/** Unique per invocation, so repeated runs do not collide on `google_sub`. */
const runId = Date.now().toString(36);

const user = await repo.upsertUserFromGoogle({
	sub: `mint-probe-${runId}`,
	email: `mint-probe-${runId}@example.com`,
	name: "Mint Probe",
	avatarUrl: null,
});

const org = await repo.ensurePersonalOrganization(user.id, user.email, user.name);
const token = generateSessionToken();
await repo.createSession(user.id, hashSessionToken(token), new Date(Date.now() + 3_600_000), null);

console.log(JSON.stringify({ cookie: `${config.sessionCookieName}=${token}`, slug: org.slug }));
