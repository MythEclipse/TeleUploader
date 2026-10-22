import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleProfile } from "../../domain/ports/identity-repository";
import logger from "../observability/logger";

/**
 * Google OAuth 2.0 client — authorization-code flow with PKCE.
 *
 * ## Why this is hand-written instead of `googleapis` / `next-auth` / `better-auth`
 *
 * This service has no web framework to hang an auth library off, and the pieces
 * an SDK would provide are four HTTP calls and one signature check. Pulling in a
 * framework-shaped dependency to obtain them would also pull in its own session
 * model, its own cookie conventions, and its own callback route — none of which
 * match the cookie + Hono mount this service already has. TODO.md item 6
 * proposed better-auth; it was never installed, and the two tables it would have
 * needed are the ones this module now uses directly.
 *
 * ## The security properties this file is responsible for
 *
 * 1. **PKCE (S256).** The verifier never leaves the server — it is stored in
 *    `oauth_states` and only its SHA-256 challenge goes to Google. An
 *    intercepted authorization code is useless without it.
 * 2. **`state` is single-use.** Enforced by the database (a DELETE ... RETURNING
 *    in `consumeOAuthState`), not by a cookie, so it holds across worker
 *    processes and cannot be replayed.
 * 3. **The ID token signature IS verified**, against Google's published JWKS,
 *    and `aud`/`iss`/`exp` are all checked. An implementation that base64-decodes
 *    the payload and trusts the claims is the classic account-takeover bug: the
 *    ID token is a bearer assertion the client controls, so unverified claims let
 *    anyone mint any identity.
 * 4. **`nonce`** ties the ID token to this specific authorization request, on top
 *    of `state` protecting the code exchange.
 *
 * ## Why `nonce` and `state` are now TWO values, not one
 *
 * An earlier version reused the `state` value as the nonce, on the reasoning
 * that it was "unguessable, single-use, and server-generated". That is true of
 * `state` as a CSRF token and FALSE of it as an OIDC nonce, and the difference
 * is not academic — it is the bug this file existed to prevent:
 *
 * Google puts a `nonce` claim in the ID token ONLY when the authorization
 * request carried a `nonce` parameter. Omitting it (which the reused-`state`
 * version did) means Google returns an ID token with **no** `nonce` claim, and
 * {@link verifyIdToken} then rejects every legitimate sign-in with "ID token
 * nonce does not match this request". The nonce must be a SEPARATE value that
 * is actually SENT to Google, and only then is it worth comparing.
 *
 * So the three values in a flow are distinct on purpose:
 *
 *   - `state`  — CSRF: proves the callback belongs to a flow this server started.
 *   - `nonce`  — replay/id-token binding: proves the ID token was minted in
 *                answer to THIS authorization request, not replayed from
 *                another one.
 *   - `code_verifier` — PKCE: proves the code exchanger is the flow's originator.
 */

/** Google's OIDC endpoints. Fixed, not configurable — these are not secrets. */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";

/** Both accepted issuer spellings. Google has historically used both. */
const VALID_ISSUERS: ReadonlySet<string> = new Set([
	"https://accounts.google.com",
	"accounts.google.com",
]);

/** Requested scopes: identity only. No Drive, no Gmail. */
const SCOPE = "openid email profile";

/** Verification keys, cached with the lifetime Google tells us to use. */
interface JwksCache {
	readonly keys: Map<string, CryptoKey>;
	readonly expiresAt: number;
}

let jwksCache: JwksCache | null = null;

/**
 * A base64url-decoded JOSE header/payload. Only the fields this module reads.
 */
interface JoseHeader {
	alg?: string;
	kid?: string;
	typ?: string;
}

interface IdTokenClaims {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	iat?: number;
	nonce?: string;
	sub?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
}

/** Configuration this module needs. Read from `config`, injected for testability. */
export interface GoogleOAuthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	/** Absolute callback URL registered with Google. */
	readonly redirectUri: string;
}

/**
 * Raised when an OAuth exchange fails.
 *
 * Carries `stage` so the controller can distinguish "we could not reach Google"
 * (503) from "the caller's request was bad" (400) without string-matching a
 * message.
 */
export class OAuthError extends Error {
	constructor(
		readonly stage: "authorize" | "token" | "id_token" | "config",
		message: string
	) {
		super(message);
		this.name = "OAuthError";
	}
}

/** base64url encode a Buffer. */
const b64url = (value: Buffer): string => value.toString("base64url");

/** Generate a PKCE verifier: 32 random bytes, base64url = 43 chars. */
export const createCodeVerifier = (): string => b64url(randomBytes(32));

/** Derive the S256 challenge for a verifier. */
export const createCodeChallenge = (verifier: string): string =>
	b64url(createHash("sha256").update(verifier).digest());

/** Generate the opaque `state` value. */
export const createState = (): string => b64url(randomBytes(32));

/**
 * Builds the URL to send the browser to.
 *
 * @param config - Client id and callback URL.
 * @param state - The `state` value already persisted server-side.
 * @param codeChallenge - S256 challenge for the stored verifier.
 * @param nonce - The `nonce` value already persisted server-side. MUST be
 *   supplied: without the parameter Google omits the `nonce` claim from the ID
 *   token, and {@link verifyIdToken} then rejects a correct sign-in.
 * @param loginHint - Optional email to pre-fill. Cosmetic only.
 * @returns The absolute Google authorization URL.
 */
export const buildAuthorizationUrl = (
	config: GoogleOAuthConfig,
	state: string,
	codeChallenge: string,
	nonce: string,
	loginHint?: string
): string => {
	if (!config.clientId) {
		throw new OAuthError("config", "GOOGLE_CLIENT_ID is not set");
	}
	if (!nonce) {
		// Fail loudly rather than emitting a URL Google will answer with an
		// ID token that cannot pass verification. A missing nonce here is a
		// programming error at the call site, not a runtime condition.
		throw new OAuthError("config", "A nonce is required for the authorization request");
	}

	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		scope: SCOPE,
		state,
		nonce,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		// `select_account` rather than `consent`: forcing consent on every sign-in
		// trains users to click through a permissions screen that is not asking
		// anything new. `select_account` still lets a multi-account user pick.
		prompt: "select_account",
	});
	if (loginHint) params.set("login_hint", loginHint);

	return `${AUTH_ENDPOINT}?${params.toString()}`;
};

/**
 * Exchanges an authorization code for tokens, then verifies and returns the
 * identity claims.
 *
 * @param config - Client credentials.
 * @param code - The `code` query parameter from the callback.
 * @param codeVerifier - The verifier stored alongside this `state`.
 * @param nonce - The `nonce` stored for this authorization request, which MUST
 *   match the ID token's `nonce` claim. Sent to Google at authorize time and
 *   echoed back by it, so this binds the token to THIS flow.
 * @returns The verified Google profile.
 * @throws {OAuthError} At the stage that failed.
 */
export const exchangeCodeForProfile = async (
	config: GoogleOAuthConfig,
	code: string,
	codeVerifier: string,
	nonce: string
): Promise<GoogleProfile> => {
	if (!config.clientId || !config.clientSecret) {
		throw new OAuthError("config", "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not both set");
	}

	const tokenResponse = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			code_verifier: codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: config.redirectUri,
		}).toString(),
	}).catch((error: unknown) => {
		throw new OAuthError(
			"token",
			`Could not reach Google's token endpoint: ${error instanceof Error ? error.message : String(error)}`
		);
	});

	if (!tokenResponse.ok) {
		// Read the body: Google's error_description names the real cause (a reused
		// code, a redirect_uri mismatch) and is the only way to debug a live deploy.
		const detail = await tokenResponse.text().catch(() => "");
		logger.error("Google token exchange failed", {
			status: tokenResponse.status,
			detail: detail.slice(0, 500),
		});
		throw new OAuthError("token", `Token exchange failed (HTTP ${tokenResponse.status})`);
	}

	const tokens = (await tokenResponse.json().catch(() => null)) as {
		id_token?: string;
	} | null;

	if (!tokens?.id_token) {
		throw new OAuthError("token", "Google returned no id_token");
	}

	return verifyIdToken(config.clientId, tokens.id_token, nonce);
};

/**
 * Fetches and caches Google's signing keys.
 *
 * Cache lifetime comes from `Cache-Control: max-age` on the response, clamped so
 * a malformed header cannot pin a stale key set forever or re-fetch per request.
 *
 * @returns Key id -> verification key.
 */
const getSigningKeys = async (): Promise<Map<string, CryptoKey>> => {
	const now = Date.now();
	if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;

	const response = await fetch(JWKS_ENDPOINT).catch((error: unknown) => {
		throw new OAuthError(
			"id_token",
			`Could not fetch Google's signing keys: ${error instanceof Error ? error.message : String(error)}`
		);
	});

	if (!response.ok) {
		throw new OAuthError("id_token", `JWKS fetch failed (HTTP ${response.status})`);
	}

	const body = (await response.json().catch(() => null)) as {
		keys?: { kid?: string; kty?: string; alg?: string; n?: string; e?: string }[];
	} | null;

	const keys = new Map<string, CryptoKey>();
	for (const jwk of body?.keys ?? []) {
		if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
		try {
			keys.set(
				jwk.kid,
				await crypto.subtle.importKey(
					"jwk",
					{ kty: "RSA", alg: jwk.alg ?? "RS256", n: jwk.n, e: jwk.e, ext: true },
					{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
					false,
					["verify"]
				)
			);
		} catch {
			// A key that will not import is unusable, not fatal: the loop is over the
			// whole set and one bad entry must not blank the rest.
		}
	}

	if (keys.size === 0) {
		throw new OAuthError("id_token", "Google's JWKS contained no usable RSA keys");
	}

	// Honour the response's max-age when it parses, else 5 minutes — short enough
	// that a rotated key is picked up promptly, long enough to avoid a fetch per
	// sign-in.
	const maxAgeHeader = Number.parseInt(
		response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] ?? "",
		10
	);
	const ttlSeconds = Number.isFinite(maxAgeHeader)
		? Math.min(Math.max(maxAgeHeader, 60), 86_400)
		: 300;

	jwksCache = { keys, expiresAt: now + ttlSeconds * 1000 };
	return keys;
};

/** Test seam: drop the cached JWKS so a test can observe a fresh fetch. */
export const resetJwksCache = (): void => {
	jwksCache = null;
};

/**
 * Verifies a Google ID token and extracts the profile.
 *
 * Checks, in this order and all mandatory:
 *   - the JOSE header names RS256 (no `alg: none`, no algorithm substitution);
 *   - the signature matches a current Google key selected by `kid`;
 *   - `iss` is a Google issuer;
 *   - `aud` equals OUR client id (an ID token minted for another app must not
 *     authenticate here — this is the check that is most often omitted);
 *   - `exp` has not passed, and `iat` is not implausibly far in the future;
 *   - `nonce` matches this authorization request;
 *   - `sub` is present, and the email is verified.
 *
 * @param clientId - Expected `aud`.
 * @param idToken - The compact JWS from the token endpoint.
 * @param expectedNonce - The `nonce` claim to require.
 * @returns The verified profile, email lowercased.
 * @throws {OAuthError} On any failed check.
 */
export const verifyIdToken = async (
	clientId: string,
	idToken: string,
	expectedNonce: string
): Promise<GoogleProfile> => {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw new OAuthError("id_token", "Malformed ID token");

	const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

	const header = parseJson<JoseHeader>(rawHeader);
	// Algorithm substitution is the attack this line exists for: `alg: none` and
	// HS256-signed-with-the-public-key both become unverifiable if unchecked.
	if (header?.alg !== "RS256") {
		throw new OAuthError("id_token", `Unexpected ID token algorithm: ${header?.alg ?? "none"}`);
	}
	if (!header.kid) throw new OAuthError("id_token", "ID token has no key id");

	const keys = await getSigningKeys();
	const key = keys.get(header.kid);
	if (!key) {
		// A `kid` miss usually means Google rotated keys between our fetch and now.
		// Drop the cache so the next attempt re-fetches once, then fail — retrying
		// in a loop here would turn a bad token into an outage.
		jwksCache = null;
		throw new OAuthError("id_token", "ID token signed with an unknown key");
	}

	const signatureValid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		decodeBase64Url(rawSignature),
		new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
	);

	if (!signatureValid) throw new OAuthError("id_token", "ID token signature is invalid");

	const claims = parseJson<IdTokenClaims>(rawPayload);
	if (!claims) throw new OAuthError("id_token", "ID token payload is not JSON");

	if (!claims.iss || !VALID_ISSUERS.has(claims.iss)) {
		throw new OAuthError("id_token", `Untrusted issuer: ${claims.iss ?? "missing"}`);
	}

	// `aud` may be a string or an array. Both are legal; a token minted for a
	// different client must never be accepted here.
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(clientId)) {
		throw new OAuthError("id_token", "ID token was issued for a different client");
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
		throw new OAuthError("id_token", "ID token has expired");
	}
	// 5 minutes of clock skew. A token issued far in the future is not credible.
	if (typeof claims.iat === "number" && claims.iat > nowSeconds + 300) {
		throw new OAuthError("id_token", "ID token was issued in the future");
	}

	if (!claims.nonce || !safeEqual(claims.nonce, expectedNonce)) {
		throw new OAuthError("id_token", "ID token nonce does not match this request");
	}

	if (!claims.sub) throw new OAuthError("id_token", "ID token has no subject claim");
	if (!claims.email) throw new OAuthError("id_token", "ID token has no email claim");
	// An unverified email could be an address the account does not control, and
	// email is what a future invitation flow would trust.
	if (claims.email_verified === false) {
		throw new OAuthError("id_token", "Google reports this email as unverified");
	}

	return {
		sub: claims.sub,
		email: claims.email.trim().toLowerCase(),
		name: typeof claims.name === "string" ? claims.name : "",
		avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
	};
};

/** Constant-time string comparison for the nonce check. */
const safeEqual = (left: string, right: string): boolean => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Decode a base64url segment into bytes.
 *
 * Returns a `Uint8Array` COPY rather than a Buffer VIEW. `Buffer.from(...)` is
 * backed by a pooled `ArrayBufferLike`, which `crypto.subtle.verify`'s
 * `BufferSource` parameter rejects at the type level — the copy is what satisfies
 * it, not a cast.
 */
const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const buffer = Buffer.from(value, "base64url");
	const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
	bytes.set(buffer);
	return bytes;
};

/** Parse a base64url JSON segment, returning `null` rather than throwing. */
const parseJson = <T>(segment: string): T | null => {
	try {
		return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
	} catch {
		return null;
	}
};

/**
 * Generates the opaque `nonce` value sent to Google and required in the ID
 * token.
 *
 * Distinct from {@link createState} because it is sent to Google as the `nonce`
 * parameter: reusing the `state` value meant the parameter was never sent at
 * all, so Google never echoed the claim back and every sign-in failed the nonce
 * check. See the module header.
 *
 * @returns 32 random bytes, base64url — 43 characters, unguessable.
 */
export const createNonce = (): string => b64url(randomBytes(32));
