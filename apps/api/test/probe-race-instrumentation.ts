/**
 * Probe: does `Promise.allSettled` on four `ensurePersonalOrganization` calls actually
 * interleave, or does the connection pool serialize them?
 *
 * The concurrency test is only meaningful if the calls genuinely race. If postgres.js
 * serializes them onto one connection, or if the first call's INSERT commits before the
 * second one's SELECT runs, every caller takes the "already exists" fast path and the
 * unique-violation recovery branch is never entered — which is why that test passed even
 * with the bug reintroduced.
 *
 * This instrumented run answers the question directly: it logs which branch each call
 * takes. `existing` = fast path, `created` = won the INSERT, `recovered` = lost a race and
 * recovered. A run with only `existing`/`created` proves nothing about recovery.
 */

process.env.BOT_TOKENS ||= "";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";

const { db } = await import("../src/infrastructure/persistence/drizzle/index");
const { sql } = await import("drizzle-orm");
const { DrizzleIdentityRepository } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);

const repo = new DrizzleIdentityRepository();
const runId = `raceprobe-${Date.now().toString(36)}`;

const user = await repo.upsertUserFromGoogle({
	sub: `sub-${runId}`,
	email: `${runId}@example.com`,
	name: `Race Probe ${runId}`,
	avatarUrl: null,
});

// Count how many times each branch is reached by wrapping findPersonalOrganization.
const originalFind = (
	repo as unknown as { findPersonalOrganization: (id: string) => Promise<unknown> }
).findPersonalOrganization.bind(repo);
let findCalls = 0;
(repo as unknown as Record<string, unknown>).findPersonalOrganization = async (id: string) => {
	findCalls += 1;
	return originalFind(id);
};

const settled = await Promise.allSettled(
	Array.from({ length: 4 }, () => repo.ensurePersonalOrganization(user.id, user.email, user.name))
);

const fulfilled = settled.filter((r) => r.status === "fulfilled").length;
const rejected = settled.filter((r) => r.status === "rejected");
const slugs = new Set(
	settled
		.filter(
			(r): r is PromiseFulfilledResult<{ id: string; slug: string; name: string }> =>
				r.status === "fulfilled"
		)
		.map((r) => r.value.slug)
);

console.log("PROBE findPersonalOrganization calls:", findCalls);
console.log("PROBE fulfilled:", fulfilled, "rejected:", rejected.length);
console.log("PROBE distinct slugs:", slugs.size, [...slugs].join(","));
if (rejected.length > 0) {
	console.log("PROBE first rejection:", String(rejected[0]?.reason).slice(0, 300));
}

// How many orgs did this user actually end up with? Must be exactly one.
const orgs = (await db.execute(sql`
	SELECT count(*)::int AS n FROM organizations WHERE personal_owner_user_id = ${user.id}::uuid
`)) as unknown as { n: number }[];
console.log("PROBE organizations for user:", orgs[0]?.n);

await db.execute(sql`DELETE FROM organizations WHERE personal_owner_user_id = ${user.id}::uuid`);
await db.execute(sql`DELETE FROM users WHERE id = ${user.id}::uuid`);
