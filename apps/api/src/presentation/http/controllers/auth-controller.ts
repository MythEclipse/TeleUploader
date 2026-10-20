import type { UserInfoResponse } from "../../../application/dto/auth";
import {
	createLogoutAllUseCase,
	createLogoutUseCase,
	createSignInUseCase,
} from "../../../application/use-cases/authenticate";
import { config, isGoogleAuthConfigured } from "../../../env";
import { identityRepository } from "../../../infrastructure/di";
import {
	buildAuthorizationUrl,
	createCodeChallenge,
	createCodeVerifier,
	createState,
	exchangeCodeForProfile,
	OAuthError,
} from "../../../infrastructure/oauth/google";
import logger from "../../../infrastructure/observability/logger";
import {
	clearSessionCookie,
	createSessionCookie,
	getAuthenticatedCaller,
	isAuthEnabled,
	listOrganizationsForCaller,
	readSessionToken,
	sharedTokenOrganizations,
} from "../middleware/auth";

/**
 * Authentication routes: Google sign-in, session probe, logout.
 *
 * ## The flow, end to end
 *
 *   1. `GET  /api/v1/auth/google/start?redirect=/some/path`
 *        mints `state` + a PKCE verifier, persists both in `oauth_states`, and 302s
 *        to Google. Nothing in the query string is trusted except a same-origin
 *        path, validated by {@link safeRedirectPath}.
 *   2. `GET  /api/v1/auth/google/callback?code=…&state=…`
 *        consumes `state` (a single-use DELETE, which IS the replay check),
 *        exchanges the code, verifies the ID token, upserts the user, provisions
 *        their personal organization, mints a session, sets the cookie, and 302s
 *        onward.
 *   3. `GET  /api/v1/auth/me`
 *        resolves the cookie to a user and returns the profile plus the
 *        organizations the caller may switch to.
 *   4. `POST /api/v1/auth/logout` and `…/logout-all`
 *        DELETE the session row(s), then clear the cookie.
 *
 * ## Why the callback lives on the API origin rather than in the SPA
 *
 * The session cookie is `HttpOnly` and `Path=/`, so it must be set by the origin
 * that serves the API. The callback is therefore here, and it 302s the browser
 * into the SPA afterwards — which is exactly why `?redirect=` is validated to a
 * same-origin PATH instead of being accepted as an absolute URL.
 */

/** Builds a JSON response. */
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	Response.json(data, { status, headers });

/** The error envelope every handler emits. */
const jsonError = (error: string, status: number): Response => Response.json({ error }, { status });

/**
 * Validates a post-login redirect target.
 *
 * Accepts only a same-origin absolute PATH. A value carrying a scheme
 * (`https://…`) or a protocol-relative `//host` is discarded, because this value
 * is written straight into a `Location` header — the one place an unvalidated
 * value becomes an open redirect.
 *
 * @param raw - The untrusted `redirect` query parameter.
 * @returns The path to use; `/` when the input is absent or unsafe.
 */
export const safeRedirectPath = (raw: string | null): string => {
	if (!raw) return "/";
	// `//evil.com` is protocol-relative and leaves the origin.
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
	// Some browsers normalise `\` to `/`, so `/\evil.com` also leaves the origin.
	// Rejecting the character outright beats reasoning about each normalisation.
	if (raw.includes("\\")) return "/";
	if (raw.includes("://")) return "/";
	return raw;
};

/** How long a pending OAuth authorization stays valid. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** The Google client configuration, or `null` when unconfigured. */
const googleConfig = (): { clientId: string; clientSecret: string; redirectUri: string } | null => {
	if (!isGoogleAuthConfigured()) return null;
	return {
		clientId: config.googleClientId,
		clientSecret: config.googleClientSecret,
		redirectUri: config.googleRedirectUri,
	};
};

/**
 * `GET /api/v1/auth/google/start`
 *
 * @param req - The incoming request (reads `?redirect=`).
 * @returns A 302 to Google, or 503 when sign-in is not configured.
 */
export const handleGoogleStart = async (req: Request): Promise<Response> => {
	const google = googleConfig();
	if (!google) {
		return jsonError(
			"Google sign-in is not configured on this server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).",
			503
		);
	}

	const url = new URL(req.url);
	const redirectTo = safeRedirectPath(url.searchParams.get("redirect"));

	const state = createState();
	const codeVerifier = createCodeVerifier();

	await identityRepository.createOAuthState(
		state,
		codeVerifier,
		redirectTo,
		new Date(Date.now() + OAUTH_STATE_TTL_MS)
	);

	return new Response(null, {
		status: 302,
		headers: {
			location: buildAuthorizationUrl(google, state, createCodeChallenge(codeVerifier)),
			// The authorize URL carries `state`, a one-time credential for this flow.
			// A shared cache must never store it.
			"cache-control": "no-store",
		},
	});
};

/**
 * `GET /api/v1/auth/google/callback`
 *
 * @param req - The incoming request carrying `?code=` and `?state=`.
 * @returns A 302 into the app with the session cookie set, or an error.
 */
export const handleGoogleCallback = async (req: Request): Promise<Response> => {
	const google = googleConfig();
	if (!google) return jsonError("Google sign-in is not configured on this server.", 503);

	const url = new URL(req.url);

	const declined = url.searchParams.get("error");
	if (declined) {
		// A user who cancels on Google's consent screen lands here. That is a normal
		// outcome, so it is a 400 the SPA renders, not a logged server failure.
		logger.info("Google sign-in was declined by the user", { error: declined });
		return jsonError(`Sign-in was cancelled (${declined}).`, 400);
	}

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) return jsonError("Missing code or state parameter.", 400);

	// Single-use: this DELETE is the replay check. A second callback carrying the
	// same state finds nothing, which also covers the "someone replayed the URL"
	// case without any extra bookkeeping.
	const pending = await identityRepository.consumeOAuthState(state);
	if (!pending) {
		return jsonError("This sign-in link has expired or was already used. Try again.", 400);
	}

	let profile: Awaited<ReturnType<typeof exchangeCodeForProfile>>;
	try {
		profile = await exchangeCodeForProfile(
			google,
			code,
			pending.codeVerifier,
			// `state` doubles as the nonce: server-generated, unguessable, and already
			// bound to this single authorization.
			state
		);
	} catch (cause: unknown) {
		if (cause instanceof OAuthError) {
			logger.error("Google sign-in failed", { stage: cause.stage, error: cause.message });
			// A configuration fault is the operator's problem, not the visitor's:
			// 503 naming it beats a generic 400 that sends people to support with
			// nothing actionable.
			return jsonError(cause.message, cause.stage === "config" ? 503 : 400);
		}
		throw cause;
	}

	const signIn = createSignInUseCase({
		identityRepository,
		sessionMaxAgeMs: config.sessionMaxAgeMs,
	});
	const result = await signIn(profile, req.headers.get("user-agent")?.slice(0, 500) ?? null);

	logger.info("User signed in", { userId: result.userId, email: result.email });

	return new Response(null, {
		status: 302,
		headers: {
			location: pending.redirectTo,
			"set-cookie": createSessionCookie(result.sessionToken),
			"cache-control": "no-store",
		},
	});
};

/**
 * `GET /api/v1/auth/me`
 *
 * Answers 200 with the profile when authenticated, 401 when not. It deliberately
 * does NOT answer 404 for the auth-disabled case the way the old handler did:
 * `googleEnabled` in the body is a clearer signal than a status code the SPA has
 * to interpret, and a 404 makes a healthy endpoint look missing.
 *
 * ## Auth-disabled is a 200, not a 401
 *
 * When no mechanism is configured (`isAuthEnabled()` false), `requireAuth` is a
 * pass-through and the bucket surface ACCEPTS writes. Answering 401 here would tell
 * the dashboard it is read-only while the API would happily perform the write — the
 * client and the server disagreeing about the deployment's own capability, which is
 * the defect class this probe exists to prevent.
 *
 * So the open deployment reports `method: "disabled"` with the bootstrap
 * organization, and the client treats that as writable. The identity fields are
 * clearly not a person: there is no user row to name.
 *
 * @param req - The incoming request.
 * @returns The caller's profile and organizations, or 401.
 */
export const handleMe = async (req: Request): Promise<Response> => {
	const caller = await getAuthenticatedCaller(req);

	if (!caller) {
		// No credentials presented AND nothing configured: the documented open mode.
		// Anything else (auth enabled, no credentials) is a genuine 401.
		//
		// The 401 still carries `googleEnabled`, and it has to: an anonymous visitor is
		// exactly the caller who needs to know whether a Sign-in button will work. Without
		// it the SPA has nothing to read on a 401 and falls back to assuming Google is
		// available, so a deployment with no credentials rendered a button that dead-ends
		// at this server's own 503 — the misleading button the login page's comment says
		// it avoids. A machine caller can read the flag here too, without a credential.
		if (isAuthEnabled()) {
			return Response.json(
				{ error: "Unauthorized", googleEnabled: isGoogleAuthConfigured() },
				{ status: 401 }
			);
		}

		const organizations = await sharedTokenOrganizations();
		const body: UserInfoResponse = {
			userId: config.bootstrapAdminId,
			email: "",
			name: "Open deployment (no authentication)",
			avatarUrl: null,
			expiresAt: null,
			method: "disabled",
			organizations,
			googleEnabled: isGoogleAuthConfigured(),
		};
		return json(body);
	}

	const organizations = await listOrganizationsForCaller(caller);

	const body: UserInfoResponse = {
		userId: caller.userId ?? config.bootstrapAdminId,
		email: caller.email ?? "admin (shared token)",
		name: caller.name ?? "Shared admin token",
		avatarUrl: null,
		expiresAt: caller.session.expiresAt?.toISOString() ?? null,
		method: caller.session.method,
		organizations,
		googleEnabled: isGoogleAuthConfigured(),
	};

	return json(body);
};

/**
 * `POST /api/v1/auth/logout`
 *
 * REVOKES the session server-side, then clears the cookie. This is the behaviour
 * the previous stateless design could not offer (docs/P4-CONTRACT.md gotcha 13).
 *
 * @param req - The incoming request.
 * @returns 200 with a cleared cookie.
 */
export const handleLogout = async (req: Request): Promise<Response> => {
	const logout = createLogoutUseCase({ identityRepository });

	await logout(readSessionToken(req)).catch((cause: unknown) => {
		// Best-effort. The cookie is cleared regardless, and the row is swept by
		// `pruneExpired` when it expires — a database blip must not leave the
		// browser holding a cookie it believes is still good.
		logger.error("Could not revoke session on logout", {
			error: cause instanceof Error ? cause.message : String(cause),
		});
		return false;
	});

	return json({ success: true }, 200, { "set-cookie": clearSessionCookie() });
};

/**
 * `POST /api/v1/auth/logout-all`
 *
 * Revokes every session for the caller. Requires a real user session: the shared
 * admin token owns no sessions to enumerate.
 *
 * @param req - The incoming request.
 * @returns The number of sessions revoked, or 401/400.
 */
export const handleLogoutAll = async (req: Request): Promise<Response> => {
	const caller = await getAuthenticatedCaller(req);
	if (!caller) return jsonError("Unauthorized", 401);
	if (caller.userId === null) {
		return jsonError("The shared admin token has no sessions to revoke.", 400);
	}

	const logoutAll = createLogoutAllUseCase({ identityRepository });
	const revoked = await logoutAll(caller.userId);

	return json({ success: true, revoked }, 200, { "set-cookie": clearSessionCookie() });
};
