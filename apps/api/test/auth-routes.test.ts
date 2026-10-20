import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Authentication routes: the Google OAuth flow, the session probe, and logout.
 *
 * ## Why this replaces the old token-login suite
 *
 * The previous file tested `POST /api/v1/auth/login` with an `ADMIN_API_TOKEN` form
 * field. That endpoint no longer exists: Google is the interactive path, and
 * `ADMIN_API_TOKEN` survives only as a Bearer credential for machine callers. What
 * matters now is the OAuth flow's own invariants, each of which is a real attack
 * surface if it regresses:
 *
 *   - `state` is SINGLE-USE (a second callback with the same state must fail);
 *   - `redirect` is validated to a same-origin path (otherwise the callback is an
 *     open redirect);
 *   - the ID token's `aud` must be OUR client id (otherwise a token minted for
 *     another app authenticates here);
 *   - logout DELETES the session row, so a replayed cookie stops working.
 *
 * Unconfigured deployments answer 503 rather than redirecting to a Google error
 * page with a client id that was never set.
 */
const setEnv = (key: string, value: string) => {
	process.env[key] = value;
};

setEnv("BOT_TOKENS", "123456:ABC-DEF");
setEnv("STORAGE_CHANNEL_ID", "-1001234567890");
setEnv("BASE_URL", "https://example.com");
setEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:1/none");
setEnv("PORT", "4000");
setEnv("NODE_ENV", "test");
setEnv("ADMIN_API_TOKEN", "route-secret-token");
setEnv("SESSION_COOKIE_NAME", "route_session");
setEnv("SESSION_COOKIE_MAX_AGE_SECONDS", "3600");

/** In-memory OAuth state ledger, standing in for the `oauth_states` table. */
const oauthStates = new Map<string, { codeVerifier: string; redirectTo: string }>();

/** Sessions keyed by token hash, standing in for the `sessions` table. */
const sessions = new Map<
	string,
	{ user: { id: string; email: string; name: string; avatarUrl: string | null }; expiresAt: Date }
>();

const mockState = {
	/** Whether Google sign-in is configured for this suite. */
	googleConfigured: true,
	/**
	 * The shared admin token, as `isAuthEnabled()` sees it.
	 *
	 * Mutable, and read through a getter in the `env` mock below, because
	 * `isAuthEnabled()` checks `config.adminApiToken` — NOT `process.env`. A test that
	 * only assigns `process.env.ADMIN_API_TOKEN = ""` changes nothing, since `config`
	 * was built once at import time. That is exactly how the first version of the
	 * auth-disabled test below failed with a 401 while looking correct.
	 */
	adminToken: "route-secret-token",
	deletedSessions: [] as string[],
};

vi.mock("../src/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/env")>();
	return {
		...actual,
		config: {
			...actual.config,
			get adminApiToken() {
				return mockState.adminToken;
			},
			get googleClientId() {
				return mockState.googleConfigured ? "test-client-id" : "";
			},
			get googleClientSecret() {
				return mockState.googleConfigured ? "test-client-secret" : "";
			},
			googleRedirectUri: "https://example.com/api/v1/auth/google/callback",
		},
		isGoogleAuthConfigured: () => mockState.googleConfigured,
	};
});

vi.mock("../src/infrastructure/di", () => ({
	identityRepository: {
		createOAuthState: async (
			state: string,
			codeVerifier: string,
			redirectTo: string,
			_expiresAt: Date
		) => {
			oauthStates.set(state, { codeVerifier, redirectTo });
		},
		consumeOAuthState: async (state: string) => {
			// DELETE-returning semantics: the read destroys the row, which is what makes
			// a replayed `state` fail.
			const found = oauthStates.get(state);
			oauthStates.delete(state);
			return found ?? null;
		},
		upsertUserFromGoogle: async (profile: {
			sub: string;
			email: string;
			name: string;
			avatarUrl: string | null;
		}) => ({
			id: `user-${profile.sub}`,
			email: profile.email,
			name: profile.name,
			avatarUrl: profile.avatarUrl,
		}),
		ensurePersonalOrganization: async () => ({
			id: "org-1",
			slug: "org-slug",
			name: "Org",
		}),
		createSession: async (
			userId: string,
			tokenHash: string,
			expiresAt: Date,
			_userAgent: string | null
		) => {
			sessions.set(tokenHash, {
				user: { id: userId, email: "person@example.com", name: "A Person", avatarUrl: null },
				expiresAt,
			});
			return { id: "session-1", userId, expiresAt };
		},
		findSessionUser: async (tokenHash: string) => {
			const found = sessions.get(tokenHash);
			if (!found) return null;
			return {
				user: found.user,
				session: { id: "session-1", userId: found.user.id, expiresAt: found.expiresAt },
			};
		},
		deleteSession: async (tokenHash: string) => {
			mockState.deletedSessions.push(tokenHash);
			return sessions.delete(tokenHash);
		},
		deleteAllSessionsForUser: async () => sessions.size,
		listOrganizationsForUser: async () => [
			{ id: "org-1", slug: "org-slug", name: "Org", role: "owner" as const },
		],
	},
	organizationRepository: {
		findOrganizationIdByUserId: async () => "bootstrap-org",
	},
}));

/**
 * A stub token endpoint and JWKS, so the flow runs without network access.
 *
 * `exchangeCodeForProfile` performs two fetches: the token exchange and the JWKS
 * download. Both are intercepted here; the ID token they return is a REAL
 * RS256-signed JWT, generated below with a key this test controls, so the
 * signature verification path is genuinely exercised rather than bypassed.
 */
const { privateKey, publicJwk } = await (async () => {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"]
	);
	const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<string, unknown>;
	return {
		privateKey: keyPair.privateKey,
		publicJwk: { ...jwk, kid: "test-kid", alg: "RS256", use: "sig" },
	};
})();

/** Builds a signed ID token for the given claims. */
const makeIdToken = async (claims: Record<string, unknown>): Promise<string> => {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ alg: "RS256", kid: "test-kid", typ: "JWT" });
	const payload = encode(claims);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(`${header}.${payload}`)
	);
	return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
};

let idTokenClaims: Record<string, unknown> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();

	if (url.includes("oauth2.googleapis.com/token")) {
		return Response.json({ id_token: await makeIdToken(idTokenClaims) });
	}
	if (url.includes("googleapis.com/oauth2/v3/certs")) {
		return Response.json({ keys: [publicJwk] });
	}
	return realFetch(input, init);
}) as typeof fetch;

const OAuth = await import("../src/infrastructure/oauth/google");
const { handleGoogleCallback, handleGoogleStart, handleLogout, handleMe, safeRedirectPath } =
	await import("../src/presentation/http/controllers/auth-controller");
const { hashSessionToken } = await import(
	"../src/infrastructure/persistence/repositories/identity-repository"
);

beforeEach(() => {
	oauthStates.clear();
	sessions.clear();
	mockState.deletedSessions = [];
	mockState.googleConfigured = true;
	OAuth.resetJwksCache();
	idTokenClaims = {
		iss: "https://accounts.google.com",
		aud: "test-client-id",
		exp: Math.floor(Date.now() / 1000) + 600,
		iat: Math.floor(Date.now() / 1000),
		sub: "google-subject-123",
		email: "Person@Example.com",
		email_verified: true,
		name: "A Person",
	};
});

describe("safeRedirectPath", () => {
	it("accepts a same-origin absolute path", () => {
		expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
		expect(safeRedirectPath("/org/bucket?prefix=a/")).toBe("/org/bucket?prefix=a/");
	});

	it("refuses absolute URLs, protocol-relative URLs, and backslash tricks", () => {
		// This value is written into a `Location` header on the callback, so an
		// unvalidated one is an open redirect.
		expect(safeRedirectPath("https://evil.example")).toBe("/");
		expect(safeRedirectPath("//evil.example")).toBe("/");
		expect(safeRedirectPath("/\\evil.example")).toBe("/");
		expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
	});

	it("falls back to / for a missing value", () => {
		expect(safeRedirectPath(null)).toBe("/");
	});
});

describe("GET /api/v1/auth/google/start", () => {
	it("redirects to Google with PKCE and a state, and disables caching", async () => {
		const res = await handleGoogleStart(
			new Request("https://example.com/api/v1/auth/google/start?redirect=/somewhere")
		);

		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";

		expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
		expect(location).toContain("code_challenge_method=S256");
		expect(location).toContain("code_challenge=");
		expect(location).toContain("state=");
		expect(location).toContain("client_id=test-client-id");
		// The verifier itself must NEVER leave the server.
		expect(location).not.toContain("code_verifier");
		expect(res.headers.get("cache-control")).toBe("no-store");

		// The state was persisted, so the callback can resolve it.
		expect(oauthStates.size).toBe(1);
	});

	it("answers 503 when Google sign-in is not configured", async () => {
		mockState.googleConfigured = false;

		const res = await handleGoogleStart(
			new Request("https://example.com/api/v1/auth/google/start")
		);

		expect(res.status).toBe(503);
	});
});

describe("GET /api/v1/auth/google/callback", () => {
	/** Runs the start step and returns the issued state. */
	const start = async (): Promise<string> => {
		await handleGoogleStart(new Request("https://example.com/api/v1/auth/google/start"));
		const state = [...oauthStates.keys()][0];
		if (!state) throw new Error("start did not persist a state");
		return state;
	};

	it("exchanges the code, verifies the ID token, and sets a session cookie", async () => {
		const state = await start();
		idTokenClaims = { ...idTokenClaims, nonce: state };

		const res = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=auth-code&state=${state}`)
		);

		expect(res.status).toBe(302);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("route_session=");
		expect(setCookie).toContain("HttpOnly");

		// A session row exists, keyed by the HASH of the cookie token — never the token.
		expect(sessions.size).toBe(1);
		const token = setCookie.slice("route_session=".length).split(";")[0] ?? "";
		expect(sessions.has(hashSessionToken(token))).toBe(true);
	});

	it("rejects a replayed state", async () => {
		const state = await start();
		idTokenClaims = { ...idTokenClaims, nonce: state };

		const first = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c1&state=${state}`)
		);
		expect(first.status).toBe(302);

		// Second use of the SAME state must fail: `state` is single-use by design.
		const second = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c1&state=${state}`)
		);
		expect(second.status).toBe(400);
		expect((await second.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("expired or was already used"),
		});
	});

	it("rejects a callback with no state or no code", async () => {
		const res = await handleGoogleCallback(
			new Request("https://example.com/api/v1/auth/google/callback")
		);
		expect(res.status).toBe(400);
	});

	it("reports a user-declined consent as a 400, not a server error", async () => {
		const res = await handleGoogleCallback(
			new Request("https://example.com/api/v1/auth/google/callback?error=access_denied")
		);
		expect(res.status).toBe(400);
	});

	it("rejects an ID token minted for a different client", async () => {
		const state = await start();
		// `aud` is the check most often omitted, and omitting it means an ID token
		// minted for ANY other Google app authenticates here.
		idTokenClaims = { ...idTokenClaims, nonce: state, aud: "someone-elses-client-id" };

		const res = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c&state=${state}`)
		);

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("different client"),
		});
	});

	it("rejects an expired ID token", async () => {
		const state = await start();
		idTokenClaims = {
			...idTokenClaims,
			nonce: state,
			exp: Math.floor(Date.now() / 1000) - 60,
		};

		const res = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c&state=${state}`)
		);

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("expired"),
		});
	});

	it("rejects a nonce that does not match this request", async () => {
		const state = await start();
		idTokenClaims = { ...idTokenClaims, nonce: "some-other-nonce" };

		const res = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c&state=${state}`)
		);

		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("nonce"),
		});
	});

	it("rejects an untrusted issuer", async () => {
		const state = await start();
		idTokenClaims = { ...idTokenClaims, nonce: state, iss: "https://evil.example" };

		const res = await handleGoogleCallback(
			new Request(`https://example.com/api/v1/auth/google/callback?code=c&state=${state}`)
		);

		expect(res.status).toBe(400);
	});
});

describe("GET /api/v1/auth/me", () => {
	it("answers 401 without a session", async () => {
		const res = await handleMe(new Request("https://example.com/api/v1/auth/me"));
		expect(res.status).toBe(401);
	});

	it("returns the profile and the caller's organizations for a valid session", async () => {
		const presented = "presented-token";
		sessions.set(hashSessionToken(presented), {
			user: {
				id: "user-1",
				email: "person@example.com",
				name: "A Person",
				avatarUrl: null,
			},
			expiresAt: new Date(Date.now() + 60_000),
		});

		const res = await handleMe(
			new Request("https://example.com/api/v1/auth/me", {
				headers: { cookie: `route_session=${presented}` },
			})
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			email: string;
			userId: string;
			method: string;
			organizations: { slug: string }[];
			googleEnabled: boolean;
		};
		expect(body.email).toBe("person@example.com");
		expect(body.userId).toBe("user-1");
		expect(body.method).toBe("cookie");
		expect(body.organizations[0]?.slug).toBe("org-slug");
		expect(body.googleEnabled).toBe(true);
	});

	/**
	 * The auth-DISABLED arm, which is a supported deployment and the one the rewritten
	 * dashboard depends on for its write controls.
	 *
	 * When nothing is configured, `requireAuth` is a pass-through and the bucket surface
	 * ACCEPTS writes. Answering 401 here would make the SPA render read-only while the
	 * API would happily perform the write — client and server disagreeing about the
	 * deployment's own capability. A 200 with `method: "disabled"` is what keeps them
	 * agreeing, so this asserts the exact field the client branches on.
	 */
	it("answers 200 with method=disabled when no auth mechanism is configured", async () => {
		const previousToken = mockState.adminToken;
		const previousConfigured = mockState.googleConfigured;
		// Both mechanisms off is what `isAuthEnabled()` reads. Set through `mockState`,
		// not `process.env`, because the controller reads `config`, not the environment.
		mockState.adminToken = "";
		mockState.googleConfigured = false;

		try {
			const res = await handleMe(new Request("https://example.com/api/v1/auth/me"));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				method: string;
				organizations: { slug: string; role: string }[];
				googleEnabled: boolean;
			};
			expect(body.method).toBe("disabled");
			// The bootstrap organization is reported when it resolves, so the switcher has
			// something to name rather than rendering an empty state on a working
			// deployment. It is allowed to be empty here only because this suite mocks
			// `identityRepository` — what matters is that the status is 200 and the method
			// is `disabled`, which is what the client branches on.
			expect(Array.isArray(body.organizations)).toBe(true);
			expect(body.googleEnabled).toBe(false);
		} finally {
			mockState.adminToken = previousToken;
			mockState.googleConfigured = previousConfigured;
		}
	});
});

describe("POST /api/v1/auth/logout", () => {
	it("revokes the session row and clears the cookie", async () => {
		const presented = "live-token";
		const hashed = hashSessionToken(presented);
		sessions.set(hashed, {
			user: { id: "user-1", email: "p@example.com", name: "P", avatarUrl: null },
			expiresAt: new Date(Date.now() + 60_000),
		});

		const res = await handleLogout(
			new Request("https://example.com/api/v1/auth/logout", {
				method: "POST",
				headers: { cookie: `route_session=${presented}` },
			})
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
		// THE behavioural difference from the old design: the row is GONE, so a
		// captured cookie stops working immediately (contract gotcha 13).
		expect(mockState.deletedSessions).toContain(hashed);
		expect(sessions.has(hashed)).toBe(false);
	});
});
