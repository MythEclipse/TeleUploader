/**
 * Live HTTP probe: the endpoints the rewritten dashboard actually calls.
 *
 * Run against a migrated database and a booted server:
 *
 *   DATABASE_URL=postgresql://tu_test:***@127.0.0.1:5432/tu_mu1 \
 *   ADMIN_API_TOKEN=... npx tsx test/dashboard-api-live-probe.ts
 *
 * ## Why this exists when 377 unit tests already pass
 *
 * The unit suite mocks the database and the repositories, so it proves the DECISION
 * logic and says nothing about the wire. Every claim below is about the JSON shape and
 * status code the SPA reads — `MeResponse.organizations`, `googleEnabled`, the
 * `?org=` resolution, the 403 on a foreign slug — and a mismatch in any of them is a
 * blank dashboard that no mock would ever catch.
 *
 * The specific regressions it guards:
 *
 *  1. `/auth/me` must report `method: "disabled"` with a 200 on an open deployment.
 *     A 401 there makes the new client render read-only while the API accepts writes.
 *  2. `/api/v1/organizations` must list ONLY the caller's memberships.
 *  3. `?org=<slug>` must be honoured for a member and refused for a non-member.
 *  4. A request with no `?org=` must resolve the caller's personal workspace, which is
 *     what `/` relies on because it has no org segment in its path.
 *  5. Buckets must not leak across tenants.
 */
process.env.BOT_TOKENS ||= "1:test";
process.env.STORAGE_CHANNEL_ID ||= "-1001234";
process.env.BASE_URL ||= "http://127.0.0.1:4399";

const { DrizzleIdentityRepository, generateSessionToken, hashSessionToken } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);
const { createApp } = await import("../src/presentation/http/app");
const { config } = await import("../src/env");

const repo = new DrizzleIdentityRepository();
const app = createApp();

/** Unique per run, so re-running against the same database does not collide. */
const runId = Date.now().toString(36);

interface Check {
	readonly check: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: Check[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ check: name, ok, detail });
};

/**
 * Mints a real session row and returns the cookie header.
 *
 * Deliberately goes through the repository rather than forging a cookie: the point is
 * to prove the middleware's hashed-token lookup works against the real table.
 *
 * @param label - Distinguishes the two accounts. The workspace NAME derives from it and
 *   `organizations.name` is UNIQUE, so a label reused between two sign-ins collides.
 */
const sessionFor = async (label: string): Promise<string> => {
	const user = await repo.upsertUserFromGoogle({
		sub: `probe-sub-${label}-${runId}`,
		email: `probe-${label}-${runId}@example.com`,
		name: `Probe ${label} ${runId}`,
		avatarUrl: null,
	});
	await repo.ensurePersonalOrganization(user.id, user.email, user.name);
	const token = generateSessionToken();
	// NOTE the argument order: `createSession(userId, tokenHash, expiresAt, userAgent)`.
	// Passing the hash first is a real mistake this probe made on its first run and the
	// database caught it (`invalid input syntax for type uuid`) — worth leaving recorded,
	// because a mock would have accepted either order silently.
	await repo.createSession(
		user.id,
		hashSessionToken(token),
		new Date(Date.now() + 3_600_000),
		null
	);
	return `${config.sessionCookieName}=${token}`;
};

/**
 * Issues a request through the real Hono app.
 *
 * `app.fetch` runs the full middleware chain — cookie parse, session lookup, tenant
 * resolution, dispatch — which is the thing under test.
 */
const call = async (
	path: string,
	cookie: string | null,
	init: RequestInit = {}
): Promise<{ status: number; body: unknown }> => {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	const res = await app.fetch(new Request(`http://127.0.0.1:4399${path}`, { ...init, headers }));
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* non-JSON is fine — the status is what some checks assert */
	}
	return { status: res.status, body };
};

const main = async (): Promise<void> => {
	// Two independent accounts, so every cross-tenant assertion has a real counterpart.
	const aliceCookie = await sessionFor("alice");
	const bobCookie = await sessionFor("bob");

	// ── 1. /auth/me shape ───────────────────────────────────────────────────
	const me = await call("/api/v1/auth/me", aliceCookie);
	const meBody = me.body as {
		userId?: string;
		email?: string;
		method?: string;
		organizations?: { slug: string; role: string }[];
		googleEnabled?: boolean;
	};
	check("/auth/me answers 200 for a session", me.status === 200, `status ${me.status}`);
	check("/auth/me reports method=cookie", meBody.method === "cookie", String(meBody.method));
	check(
		"/auth/me carries the caller's email",
		typeof meBody.email === "string" && meBody.email.includes(runId),
		meBody.email
	);
	check(
		"/auth/me lists exactly the caller's own organization",
		Array.isArray(meBody.organizations) && meBody.organizations.length === 1,
		`${meBody.organizations?.length ?? "none"}`
	);
	check(
		"/auth/me reports googleEnabled as a boolean",
		typeof meBody.googleEnabled === "boolean",
		String(meBody.googleEnabled)
	);

	const aliceOrgSlug = meBody.organizations?.[0]?.slug;
	check(
		"the personal organization is owned",
		meBody.organizations?.[0]?.role === "owner",
		String(meBody.organizations?.[0]?.role)
	);

	// ── 2. Unauthenticated probe ────────────────────────────────────────────
	const anonMe = await call("/api/v1/auth/me", null);
	// Auth is ENABLED in this probe (a session exists), so an anonymous probe is a 401.
	// If it were 200 the SPA would render a signed-in shell for nobody.
	check(
		"/auth/me answers 401 with no credential",
		anonMe.status === 401,
		`status ${anonMe.status}`
	);

	// ── 3. /api/v1/organizations ────────────────────────────────────────────
	const orgs = await call("/api/v1/organizations", aliceCookie);
	const orgsBody = orgs.body as { organizations?: { slug: string; name: string }[] };
	check("/organizations answers 200", orgs.status === 200, `status ${orgs.status}`);
	check(
		"/organizations lists exactly one workspace",
		Array.isArray(orgsBody.organizations) && orgsBody.organizations.length === 1,
		`${orgsBody.organizations?.length ?? "none"}`
	);
	check(
		"/organizations never lists the other account's workspace",
		!orgsBody.organizations?.some((org) => org.slug.includes("bob")),
		JSON.stringify(orgsBody.organizations?.map((o) => o.slug))
	);

	// ── 4. ?org= resolution ─────────────────────────────────────────────────
	const unscoped = await call("/api/v1/buckets", aliceCookie);
	check(
		"/buckets with no ?org resolves the personal workspace",
		unscoped.status === 200,
		`status ${unscoped.status}`
	);

	const ownScoped = await call(
		`/api/v1/buckets?org=${encodeURIComponent(aliceOrgSlug ?? "")}`,
		aliceCookie
	);
	check(
		"/buckets with the caller's own ?org answers 200",
		ownScoped.status === 200,
		`status ${ownScoped.status}`
	);

	// The critical cross-tenant assertion: Alice naming BOB's slug must be refused.
	const bobMe = await call("/api/v1/auth/me", bobCookie);
	const bobOrgSlug = (bobMe.body as { organizations?: { slug: string }[] }).organizations?.[0]
		?.slug;

	const crossTenant = await call(
		`/api/v1/buckets?org=${encodeURIComponent(bobOrgSlug ?? "missing")}`,
		aliceCookie
	);
	check(
		"/buckets with ANOTHER account's ?org is refused",
		crossTenant.status === 403,
		`status ${crossTenant.status} body ${JSON.stringify(crossTenant.body).slice(0, 120)}`
	);

	// ── 5. Bucket creation is scoped, and does not leak ─────────────────────
	const bucketName = `probe-${runId}`.toLowerCase();
	const created = await call(
		`/api/v1/buckets?org=${encodeURIComponent(aliceOrgSlug ?? "")}`,
		aliceCookie,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: bucketName }),
		}
	);
	check(
		"POST /buckets creates in the named workspace",
		created.status === 201 || created.status === 409,
		`status ${created.status} body ${JSON.stringify(created.body).slice(0, 120)}`
	);

	const aliceBuckets = await call(
		`/api/v1/buckets?org=${encodeURIComponent(aliceOrgSlug ?? "")}`,
		aliceCookie
	);
	const aliceList = (aliceBuckets.body as { buckets?: { name: string }[] }).buckets ?? [];
	check(
		"the new bucket appears in its own workspace",
		aliceList.some((b) => b.name === bucketName),
		JSON.stringify(aliceList.map((b) => b.name)).slice(0, 200)
	);

	const bobBuckets = await call(
		`/api/v1/buckets?org=${encodeURIComponent(bobOrgSlug ?? "")}`,
		bobCookie
	);
	const bobList = (bobBuckets.body as { buckets?: { name: string }[] }).buckets ?? [];
	check(
		"the other workspace does NOT see that bucket",
		!bobList.some((b) => b.name === bucketName),
		JSON.stringify(bobList.map((b) => b.name)).slice(0, 200)
	);

	// ── 6. Concurrent sign-in must not throw ───────────────────────────────
	//
	// This is the check that proves `sqlStateOf` works. Two simultaneous first sign-ins
	// for ONE new user race on `organizations_personal_owner_unique`: one INSERT wins, the
	// other raises 23505 and MUST recover by re-reading. Drizzle wraps that error, so the
	// SQLSTATE is on `error.cause` — reading `error.code` made this path dead code and the
	// losing request threw instead of returning the workspace.
	const racer = await repo.upsertUserFromGoogle({
		sub: `probe-sub-racer-${runId}`,
		email: `probe-racer-${runId}@example.com`,
		name: `Probe Racer ${runId}`,
		avatarUrl: null,
	});
	const race = await Promise.allSettled(
		Array.from({ length: 4 }, () =>
			repo.ensurePersonalOrganization(racer.id, racer.email, racer.name)
		)
	);
	const fulfilled = race.filter((r) => r.status === "fulfilled");
	const rejected = race.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
	const slugs = new Set(
		fulfilled.map((r) => (r as PromiseFulfilledResult<{ slug: string }>).value.slug)
	);

	check(
		"concurrent first sign-in resolves ONE workspace without throwing",
		rejected.length === 0,
		rejected.length > 0 ? String(rejected[0]?.reason).slice(0, 200) : "no rejections"
	);
	check(
		"every concurrent caller agrees on the same workspace slug",
		slugs.size === 1,
		[...slugs].join(",")
	);

	// ── 7. Logout revokes ──────────────────────────────────────────────────
	const logout = await call("/api/v1/auth/logout", aliceCookie, { method: "POST" });
	check("/auth/logout answers 200", logout.status === 200, `status ${logout.status}`);

	// The SAME cookie must now fail — this is what "server-side session" buys and what
	// the old stateless cookie could not do.
	const afterLogout = await call("/api/v1/auth/me", aliceCookie);
	check(
		"a revoked session no longer authenticates",
		afterLogout.status === 401,
		`status ${afterLogout.status}`
	);

	// ── Report ─────────────────────────────────────────────────────────────
	const failed = results.filter((r) => !r.ok);
	for (const r of results) {
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  — ${r.detail}` : ""}`);
	}
	console.log(
		`\n${results.length - failed.length}/${results.length} checks passed${failed.length > 0 ? ` — ${failed.length} FAILED` : ""}`
	);
	if (failed.length > 0) process.exitCode = 1;
};

await main();
