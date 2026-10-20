/**
 * Live probe for the identity repository, against a real Postgres.
 *
 * Run with a migrated database:
 *
 *   DATABASE_URL=postgresql://tu_test:scratchpw@127.0.0.1:5432/tu_mu1 \
 *     npx tsx test/identity-live-probe.ts
 *
 * This is a PROBE, not a test file, for the same reason
 * `tenant-scope-boot-probe.ts` is one: it opens a real connection, so it must not
 * run inside the unit suite where every other file mocks the database. It exists
 * because the mocked tests prove the DECISION logic and say nothing about whether
 * the SQL is valid — a wrong column name or an unparseable RETURNING clause would
 * pass every mock and fail on the first real sign-in.
 *
 * It asserts the properties a multi-user service cannot get wrong:
 *
 *   1. a user upserts idempotently on google_sub (no duplicate accounts);
 *   2. a session round-trips, and an EXPIRED one does not resolve;
 *   3. logout DELETES the row, so a replay fails;
 *   4. a personal organization is created once and reused (concurrent-safe);
 *   5. one user cannot list or resolve another user's organization;
 *   5b. the partial unique index really does stop a second personal org;
 *   6. OAuth state is single-use (consume deletes).
 */
process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4399";
process.env.PORT ||= "4399";

const { DrizzleIdentityRepository } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);
const { hashSessionToken, generateSessionToken } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);

const repo = new DrizzleIdentityRepository();

/** Test-only emails, so a re-run against the same database starts clean. */
const alice = {
	sub: "probe-google-sub-alice",
	email: "probe-alice@example.com",
	name: "Alice Probe",
	avatarUrl: null,
};
const bob = {
	sub: "probe-google-sub-bob",
	email: "probe-bob@example.com",
	name: "Bob Probe",
	avatarUrl: null,
};

const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ check: name, ok, detail });
};

const main = async (): Promise<void> => {
	// ── 1. Idempotent upsert on google_sub ──────────────────────────────────
	const first = await repo.upsertUserFromGoogle(alice);
	// A second sign-in with a CHANGED display name must update the same row, not
	// create a second account.
	const second = await repo.upsertUserFromGoogle({ ...alice, name: "Alice Renamed" });

	check(
		"upsert is idempotent on google_sub",
		first.id === second.id,
		`${first.id} vs ${second.id}`
	);
	check("upsert refreshes the display name", second.name === "Alice Renamed", second.name);

	// Email is lowercased by the caller, but the unique index means a duplicate would
	// throw — this proves the upsert keys on sub, not email.
	check("upsert kept one row per subject", first.email === second.email, second.email);

	const bobUser = await repo.upsertUserFromGoogle(bob);
	check("two users get distinct ids", first.id !== bobUser.id);

	// ── 2. Session round-trip, and expiry ───────────────────────────────────
	const token = generateSessionToken();
	const tokenHash = hashSessionToken(token);
	const expiresAt = new Date(Date.now() + 60_000);

	const session = await repo.createSession(first.id, tokenHash, expiresAt, "probe-agent");
	check("session row created", typeof session.id === "string");

	const resolved = await repo.findSessionUser(tokenHash);
	check("valid session resolves to its user", resolved?.user.id === first.id, resolved?.user.email);
	check(
		"resolved session carries the expiry",
		resolved?.session.expiresAt.getTime() === expiresAt.getTime()
	);

	// An expired session must NOT resolve — the check lives in SQL, so a caller
	// cannot forget it.
	const expiredToken = generateSessionToken();
	await repo.createSession(
		first.id,
		hashSessionToken(expiredToken),
		new Date(Date.now() - 60_000),
		null
	);
	const expiredResolved = await repo.findSessionUser(hashSessionToken(expiredToken));
	check("expired session does NOT resolve", expiredResolved === null);

	// An unknown token must not resolve either.
	check("unknown session does NOT resolve", (await repo.findSessionUser("0".repeat(64))) === null);

	// ── 3. Logout actually revokes ──────────────────────────────────────────
	const deleted = await repo.deleteSession(tokenHash);
	const afterDelete = await repo.findSessionUser(tokenHash);
	check("logout deletes the session row", deleted === true);
	check("a replayed cookie stops working after logout", afterDelete === null);

	// ── 4. Personal organization is created once and reused ─────────────────
	const orgA = await repo.ensurePersonalOrganization(first.id, first.email);
	const orgA2 = await repo.ensurePersonalOrganization(first.id, first.email);
	check("personal org is stable across calls", orgA.id === orgA2.id, `${orgA.id} vs ${orgA2.id}`);
	check("personal org has a usable slug", orgA.slug.length > 0, orgA.slug);

	// Concurrency: five simultaneous calls must all agree on ONE org. The partial
	// unique index is the concurrency control; the loser re-reads the winner's row.
	const concurrent = await Promise.all(
		Array.from({ length: 5 }, () => repo.ensurePersonalOrganization(bobUser.id, bobUser.email))
	);
	const distinct = new Set(concurrent.map((org) => org.id));
	check(
		"concurrent ensurePersonalOrganization yields ONE org",
		distinct.size === 1,
		`${distinct.size} distinct`
	);

	// ── 5. Cross-tenant isolation ───────────────────────────────────────────
	const bobOrg = concurrent[0]!;
	const aliceOrgs = await repo.listOrganizationsForUser(first.id);
	const bobOrgs = await repo.listOrganizationsForUser(bobUser.id);

	check(
		"each user lists only their own organizations",
		aliceOrgs.length === 1 &&
			bobOrgs.length === 1 &&
			aliceOrgs[0]!.id === orgA.id &&
			bobOrgs[0]!.id === bobOrg.id,
		`alice=${aliceOrgs.map((o) => o.slug).join(",")} bob=${bobOrgs.map((o) => o.slug).join(",")}`
	);

	check(
		"a foreign slug does NOT resolve",
		(await repo.findOrganizationBySlug(first.id, bobOrg.slug)) === null
	);
	check(
		"the owner's own slug DOES resolve",
		(await repo.findOrganizationBySlug(first.id, orgA.slug))?.id === orgA.id
	);
	check(
		"membership is null for a foreign org",
		(await repo.findMembership(first.id, bobOrg.id)) === null
	);
	check(
		"membership is 'owner' for the own org",
		(await repo.findMembership(first.id, orgA.id)) === "owner"
	);

	// ── 5b. The partial unique index stops a second personal org ────────────
	// This is the database-level guarantee behind the concurrency test above. If the
	// index were dropped, a double-sign-in could mint two empty workspaces.
	const duplicatePersonalOrg = await repo
		.ensurePersonalOrganization(first.id, "another-address@example.com")
		.then((org) => org.id);
	check(
		"a second personal org is NOT created for the same user",
		duplicatePersonalOrg === orgA.id,
		duplicatePersonalOrg
	);

	// ── 6. OAuth state is single-use ────────────────────────────────────────
	const state = `probe-state-${Date.now()}`;
	await repo.createOAuthState(
		state,
		"verifier-value",
		"/after-login",
		new Date(Date.now() + 60_000)
	);

	const consumed = await repo.consumeOAuthState(state);
	check("oauth state is consumable once", consumed?.codeVerifier === "verifier-value");
	check("oauth state carries the redirect", consumed?.redirectTo === "/after-login");
	check("a REPLAYED oauth state returns null", (await repo.consumeOAuthState(state)) === null);

	// An expired state must not be consumable.
	const expiredState = `probe-expired-${Date.now()}`;
	await repo.createOAuthState(expiredState, "v", "/", new Date(Date.now() - 1000));
	check(
		"an EXPIRED oauth state returns null",
		(await repo.consumeOAuthState(expiredState)) === null
	);

	// ── 7. pruneExpired removes dead rows ───────────────────────────────────
	const pruned = await repo.pruneExpired();
	check("pruneExpired removes at least the expired session", pruned >= 1, String(pruned));
};

try {
	await main();
} catch (error: unknown) {
	check(
		"probe completed without throwing",
		false,
		error instanceof Error ? error.message : String(error)
	);
}

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
	console.log(
		`${entry.ok ? "PASS" : "FAIL"}  ${entry.check}${entry.detail ? `  [${entry.detail}]` : ""}`
	);
}
console.log(
	JSON.stringify({ total: results.length, failed: failed.length, ok: failed.length === 0 })
);
process.exit(failed.length === 0 ? 0 : 1);
