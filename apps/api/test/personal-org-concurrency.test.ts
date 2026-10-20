/**
 * Personal-workspace provisioning, proved against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS
 *
 * `ensurePersonalOrganization` has a recovery branch that only runs when the database
 * raises a unique violation: two concurrent first sign-ins for one user race on
 * `organizations_personal_owner_unique`, one INSERT wins, and the loser must recover by
 * RE-READING the row the winner created rather than surfacing an error to the user.
 *
 * That branch was DEAD CODE. It read `(error as { code?: string }).code`, but
 * `db.execute()` never rethrows the driver error — Drizzle wraps it in
 * `DrizzleQueryError`, which carries no `code`; the SQLSTATE is on `error.cause.code`.
 * Verified directly (`test/probe-unique-violation-shape.ts`):
 *
 *     PROBE constructor: DrizzleQueryError
 *     PROBE error.code: undefined
 *     PROBE error.cause.code: 23505
 *
 * The consequence was invisible to every mocked test — `error.code` is whatever a mock
 * says it is — and surfaced only as a failing live probe: a second sign-in in the same
 * millisecond threw `duplicate key value violates unique constraint`. This file pins the
 * behaviour so the branch cannot silently die again.
 *
 * NO MOCKS. The point is the interaction between our code and postgres.js's error
 * shape; a mock can only re-assert our own assumption.
 *
 * Running it locally:
 *
 *   DATABASE_URL=postgresql://tu_test:***@127.0.0.1:5432/tu_mu1 \
 *   BOT_TOKENS=1:test STORAGE_CHANNEL_ID=-1001234 BASE_URL=http://127.0.0.1:4311 \
 *   PORT=4311 pnpm vitest run --config vitest.config.ts test/personal-org-concurrency.test.ts
 */
import { afterAll, describe, expect, it } from "vitest";
import { probeLiveDatabase } from "./helpers/live-db";

process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4311";

const { DrizzleIdentityRepository } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);

const repo = new DrizzleIdentityRepository();

/** Unique per run, so a re-run against the same database starts clean. */
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * The probe's own reachability check, run before collection so `describe.skipIf` can
 * decide. A configured-but-broken database throws here instead of skipping.
 */
const status = await probeLiveDatabase(async () => {
	await repo.listOrganizationsForUser("00000000-0000-0000-0000-000000000000");
});

const live = status.state === "live";

/** Creates a fresh user for the test and returns it. */
const freshUser = async (label: string) =>
	repo.upsertUserFromGoogle({
		sub: `poc-sub-${label}-${runId}`,
		email: `poc-${label}-${runId}@example.com`,
		name: `Concurrency ${label} ${runId}`,
		avatarUrl: null,
	});

describe.skipIf(!live)("ensurePersonalOrganization under concurrency", () => {
	afterAll(async () => {
		// Sweep the fixtures this file created. Best-effort: a leftover row only costs disk,
		// while a throw here would fail an otherwise-passing suite.
		const { db } = await import("../src/infrastructure/persistence/drizzle/index");
		const { sql } = await import("drizzle-orm");
		await db
			.execute(
				sql`DELETE FROM organizations WHERE slug LIKE ${`poc-${runId}%`} OR name LIKE ${`Concurrency % ${runId}`}`
			)
			.catch(() => undefined);
	});

	it("resolves ONE workspace for concurrent first sign-ins without throwing", async () => {
		const user = await freshUser("race");

		// Four simultaneous callers, all for the same brand-new user. Exactly this is what
		// happens when a browser double-submits the OAuth callback or two tabs land at once.
		//
		// NOTE: this is a SMOKE check, not proof of the recovery branch. Measured with
		// `test/probe-race-instrumentation.ts`, these four calls do not reliably interleave:
		// every caller's initial SELECT can complete before the winner's INSERT commits, so
		// several take the "already exists" fast path and the unique-violation branch is
		// never entered. It passed even with the bug reintroduced — which is exactly why the
		// deterministic test below exists.
		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				repo.ensurePersonalOrganization(user.id, user.email, user.name)
			)
		);

		const rejections = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
		expect(rejections.map((r) => String(r.reason).slice(0, 200))).toEqual([]);

		const slugs = settled
			.filter(
				(r): r is PromiseFulfilledResult<{ id: string; slug: string; name: string }> =>
					r.status === "fulfilled"
			)
			.map((r) => r.value.slug);
		expect(slugs).toHaveLength(4);
		// And they must all agree — a recovery that invented a second slug would give the
		// user two workspaces.
		expect(new Set(slugs).size).toBe(1);
	});

	/**
	 * DETERMINISTIC proof that a unique violation is RECOVERED, not surfaced.
	 *
	 * The race test above cannot prove this, because whether the calls actually interleave
	 * depends on commit timing. This test removes the timing from the equation: it makes
	 * the pre-INSERT SELECT report "no workspace" even though one exists, so the INSERT is
	 * GUARANTEED to hit `organizations_personal_owner_unique`. That is precisely the state
	 * a losing concurrent caller is in.
	 *
	 * With the `error.code` bug this throws `duplicate key value violates unique
	 * constraint`; with `sqlStateOf` it re-reads and returns the existing workspace.
	 */
	it("recovers when the INSERT loses a race on the personal-owner index", async () => {
		const user = await freshUser("loser");

		// The winner's row, created for real.
		const winner = await repo.ensurePersonalOrganization(user.id, user.email, user.name);

		// Simulate the loser's stale view: its SELECT ran before the winner committed.
		const internals = repo as unknown as {
			findPersonalOrganization: (id: string) => Promise<unknown>;
		};
		const realFind = internals.findPersonalOrganization.bind(repo);
		let firstCall = true;
		internals.findPersonalOrganization = async (id: string) => {
			if (firstCall) {
				firstCall = false;
				return null;
			}
			return realFind(id);
		};

		try {
			// Must NOT throw: the violation is the expected concurrency signal.
			const recovered = await repo.ensurePersonalOrganization(user.id, user.email, user.name);
			expect(recovered.id).toBe(winner.id);
			expect(recovered.slug).toBe(winner.slug);
		} finally {
			internals.findPersonalOrganization = realFind;
		}
	});

	it("is idempotent on a sequential re-call", async () => {
		const user = await freshUser("repeat");
		const first = await repo.ensurePersonalOrganization(user.id, user.email, user.name);
		const second = await repo.ensurePersonalOrganization(user.id, user.email, user.name);

		expect(second.id).toBe(first.id);
		expect(second.slug).toBe(first.slug);
	});

	it("names the workspace after the person, not their raw email address", async () => {
		const user = await freshUser("naming");
		const org = await repo.ensurePersonalOrganization(user.id, user.email, user.name);

		// The switcher renders this string. `alice@example.com's files` leaks every member's
		// address to anyone who can see the control.
		expect(org.name).not.toContain("@");
		expect(org.name).toContain(user.name);
	});

	it("falls back to the email local part when there is no display name", async () => {
		const user = await freshUser("noname");
		// An empty display name is real: a Google account can have none.
		const org = await repo.ensurePersonalOrganization(user.id, user.email, "");

		expect(org.name).not.toContain("@");
		expect(org.name.length).toBeGreaterThan(0);
	});
});

describe.skipIf(live)("ensurePersonalOrganization (not run)", () => {
	it("explains the skip", () => {
		// A visible, named skip: the summary line then reads "skipped" rather than a
		// "passed" that asserted nothing.
		expect(status.state).toBe("unconfigured");
		expect(status.state === "unconfigured" ? status.reason : "").toContain("DATABASE_URL");
	});
});
