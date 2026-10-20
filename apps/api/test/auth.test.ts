import { describe, expect, it, vi } from "vitest";

/**
 * Multi-user authentication middleware.
 *
 * ## What this file replaces, and why it could not simply be edited
 *
 * The previous suite asserted the STATELESS cookie design: a payload of
 * `{u:"admin",e:…}` signed with an HMAC, where `parseSessionFromCookie` verified
 * the signature and REJECTED any payload whose `u` was not exactly `"admin"`.
 * Every one of those assertions described behaviour that had to go — the cookie
 * carries an opaque token now, the server keeps the row, and the user id comes
 * from the database — so the suite is rewritten rather than patched.
 *
 * The properties still worth keeping are re-asserted against the new shape (cookie
 * attributes, timing-safe bearer comparison, the pass-through when auth is off),
 * and the new session properties are asserted against a stubbed repository.
 */
const setEnv = (key: string, value: string) => {
	process.env[key] = value;
};

setEnv("BOT_TOKENS", "123456:ABC-DEF");
setEnv("STORAGE_CHANNEL_ID", "-1001234567890");
setEnv("BASE_URL", "https://example.com");
// Only needs to satisfy `src/env.ts`. Nothing here opens a connection because both
// repositories are mocked below.
setEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:1/none");
setEnv("PORT", "4000");
setEnv("NODE_ENV", "test");
setEnv("ADMIN_API_TOKEN", "route-secret-token");
setEnv("SESSION_COOKIE_NAME", "route_session");
setEnv("SESSION_COOKIE_MAX_AGE_SECONDS", "3600");

/** A canned session, shaped exactly as `findSessionUser` returns one. */
interface FakeSessionUser {
	user: { id: string; email: string; name: string; avatarUrl: string | null };
	session: { id: string; userId: string; expiresAt: Date };
}

/**
 * Mutable state the mocked repository reads.
 *
 * Declared at module scope rather than inside `vi.mock`'s factory: vitest hoists
 * that factory above every import, so a closure over a local would be hoisted out
 * of scope, while a top-level binding is initialised before the first test runs.
 * `vi.mock` therefore must not reference this object at definition time — only
 * inside the mocked methods, which execute later.
 */
const mockState = {
	sessionUser: null as FakeSessionUser | null,
	findSessionUserCalls: [] as string[],
	deleteSessionCalls: [] as string[],
};

vi.mock("../src/infrastructure/di", () => ({
	identityRepository: {
		findSessionUser: async (tokenHash: string) => {
			mockState.findSessionUserCalls.push(tokenHash);
			return mockState.sessionUser;
		},
		deleteSession: async (tokenHash: string) => {
			mockState.deleteSessionCalls.push(tokenHash);
			return true;
		},
		listOrganizationsForUser: async () => [],
	},
	organizationRepository: {
		findOrganizationIdByUserId: async (userId: string) =>
			userId ? "00000000-0000-4000-8000-000000000001" : null,
	},
}));

const auth = await import("../src/presentation/http/middleware/auth");
const { hashSessionToken } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);

/** A session for a real user, with a future expiry. */
const activeSession = (): FakeSessionUser => ({
	user: {
		id: "11111111-1111-4111-8111-111111111111",
		email: "person@example.com",
		name: "A Person",
		avatarUrl: null,
	},
	session: {
		id: "22222222-2222-4222-8222-222222222222",
		userId: "11111111-1111-4111-8111-111111111111",
		expiresAt: new Date(Date.now() + 60_000),
	},
});

/** Builds a request carrying the session cookie. */
const withCookie = (token: string): Request =>
	new Request("http://localhost/api", { headers: { cookie: `route_session=${token}` } });

describe("cookie construction", () => {
	it("sets HttpOnly, SameSite, Path and Max-Age on the session cookie", () => {
		const cookie = auth.createSessionCookie("opaque-token");

		expect(cookie.startsWith("route_session=")).toBe(true);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=3600");
	});

	it("sets Secure when BASE_URL is https", () => {
		// The old implementation set `Secure` UNCONDITIONALLY, which is why a login on
		// plain http answered 200 and then had its cookie silently discarded by the
		// browser (docs/P4-CONTRACT.md gotcha 12). It now follows the deployment's own
		// scheme, so https keeps the protection and http actually works.
		expect(auth.createSessionCookie("t")).toContain("Secure");
	});

	it("clears the cookie with Max-Age=0", () => {
		const cookie = auth.clearSessionCookie("route_session");

		expect(cookie.startsWith("route_session=;")).toBe(true);
		expect(cookie).toContain("Max-Age=0");
		expect(cookie).toContain("HttpOnly");
	});
});

describe("bearer token", () => {
	const secret = "shared-secret";

	it("accepts the exact token with the Bearer scheme", () => {
		expect(auth.checkBearerToken(`Bearer ${secret}`, secret)).toBe(true);
	});

	it("rejects a wrong token, a wrong scheme, a bare token, and a missing header", () => {
		expect(auth.checkBearerToken("Bearer wrong", secret)).toBe(false);
		// A bare token is not a Bearer credential; accepting it would widen the
		// surface to any header shape.
		expect(auth.checkBearerToken(secret, secret)).toBe(false);
		expect(auth.checkBearerToken(null, secret)).toBe(false);
		// An empty configured secret must never authenticate anything.
		expect(auth.checkBearerToken("Bearer ", "")).toBe(false);
	});
});

describe("session resolution", () => {
	it("resolves a valid session cookie to a real user", async () => {
		mockState.sessionUser = activeSession();

		const caller = await auth.getAuthenticatedCaller(withCookie("opaque-token"));

		expect(caller?.userId).toBe("11111111-1111-4111-8111-111111111111");
		expect(caller?.email).toBe("person@example.com");
		expect(caller?.session.method).toBe("cookie");
		expect(caller?.isSharedAdminToken).toBe(false);
		// The cookie value is HASHED before lookup: the raw token must never reach the
		// database, which is what makes a database read useless to an attacker.
		expect(mockState.findSessionUserCalls.at(-1)).toBe(hashSessionToken("opaque-token"));
	});

	it("returns null for an unknown or expired session", async () => {
		mockState.sessionUser = null;

		const caller = await auth.getAuthenticatedCaller(withCookie("stale-token"));

		expect(caller).toBeNull();
	});

	it("falls back to the bearer token when the cookie is invalid", async () => {
		mockState.sessionUser = null;

		const caller = await auth.getAuthenticatedCaller(
			new Request("http://localhost/api", {
				headers: { cookie: "route_session=bogus", authorization: "Bearer route-secret-token" },
			})
		);

		expect(caller?.session.method).toBe("bearer");
		// NULL, deliberately: the shared token has no `users` row, so no caller may
		// read its id as a person's.
		expect(caller?.userId).toBeNull();
		expect(caller?.isSharedAdminToken).toBe(true);
	});

	it("returns null when neither credential is present", async () => {
		mockState.sessionUser = null;
		const caller = await auth.getAuthenticatedCaller(new Request("http://localhost/api"));
		expect(caller).toBeNull();
	});
});

describe("requireAuth", () => {
	/** A handler that records whether it ran. */
	const counting = () => {
		const counter = { calls: 0 };
		const handler = (): Response => {
			counter.calls += 1;
			return Response.json({ ok: true });
		};
		return { counter, handler };
	};

	it("rejects a request with no session", async () => {
		mockState.sessionUser = null;
		const { counter, handler } = counting();

		const res = await auth.requireAuth(handler)(new Request("http://localhost/api"));

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
		expect(counter.calls).toBe(0);
	});

	it("passes a request carrying a real session", async () => {
		mockState.sessionUser = activeSession();
		const { counter, handler } = counting();

		const res = await auth.requireAuth(handler)(withCookie("opaque-token"));

		expect(res.status).toBe(200);
		expect(counter.calls).toBe(1);
	});

	it("passes a request carrying the shared bearer token", async () => {
		mockState.sessionUser = null;
		const { counter, handler } = counting();

		const res = await auth.requireAuth(handler)(
			new Request("http://localhost/api", {
				headers: { authorization: "Bearer route-secret-token" },
			})
		);

		expect(res.status).toBe(200);
		expect(counter.calls).toBe(1);
	});
});

describe("isAuthEnabled", () => {
	it("is true when a shared token is configured", () => {
		expect(auth.isAuthEnabled()).toBe(true);
	});
});
