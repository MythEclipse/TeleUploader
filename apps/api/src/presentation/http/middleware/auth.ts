import { createHmac } from "node:crypto";
import type { AuthSession } from "../../../application/dto/auth";
import { timingSafeCompare } from "../../../application/shared/utils/crypto";
import { hashSessionToken } from "../../../application/shared/utils/session";
import type { MemberRole } from "../../../domain/ports/identity-repository";
import { config } from "../../../env";
import {
	resolveBetterAuthSession,
	resolveBridgedUserId,
} from "../../../infrastructure/auth/session-resolver";
import { identityRepository } from "../../../infrastructure/di";

/**
 * Authentication middleware — cookie sessions, bearer admin token, and the
 * tenant authorization check.
 *
 * ── WHAT CHANGED FROM THE SINGLE-ADMIN VERSION ──────────────────────────────
 *
 * The previous module minted a STATELESS cookie: `base64url({u,e})` plus an
 * HMAC, where `u` was hardcoded to the literal `"admin"`, and
 * `parseSessionFromCookie` REJECTED any cookie whose `u` was not exactly that
 * string. That is why a second person could not exist, and why logout revoked
 * nothing (docs/P4-CONTRACT.md gotcha 13): there was no server-side record to
 * delete.
 *
 * This version is backed by the `sessions` table. The cookie carries an opaque
 * random token; the database stores only its SHA-256, so:
 *
 *   - logout is REAL (the row is deleted, and a replayed cookie stops working);
 *   - a session belongs to an actual `users` row, so `organizationId` can be
 *     resolved from the CALLER rather than from a configured bootstrap id;
 *   - sessions expire server-side, not just by an `exp` field the client could
 *     be tricked about.
 *
 * ── THE BEARER PATH IS DELIBERATELY KEPT ────────────────────────────────────
 *
 * `ADMIN_API_TOKEN` still authenticates machine callers (scripts, CI, curl). It
 * has no user row, so it resolves to the configured bootstrap admin — the same
 * behaviour as before — and it is the ONLY path that does. Removing it would
 * break every existing automation, and it is a shared secret an operator
 * controls, not a user credential.
 *
 * ── WHY THE SESSION READ IS ASYNC AND THE COOKIE PARSE IS NOT ───────────────
 *
 * Parsing the cookie is pure string work. Resolving it to a user is a database
 * round trip. `getAuthSession` is therefore async, and every caller awaits it —
 * a synchronous wrapper that returned a stub would reintroduce the "username
 * only" session this module exists to replace.
 */

const ADMIN_USERNAME = "admin";
const SIGNATURE_SEPARATOR = ".";
/** Cookie carrying the opaque session token. Distinct from the legacy name. */
const LEGACY_BEARER_PREFIX = "Bearer ";

/** A request handler function that returns a Response. */
type Handler = (req: Request) => Response | Promise<Response>;

export type { AuthSession };

/** Options for configuring cookie behaviour. */
interface CookieOptions {
	/** Name of the session cookie (defaults to {@link config.sessionCookieName}). */
	cookieName?: string;
	/** Session lifetime in milliseconds (defaults to {@link config.sessionMaxAgeMs}). */
	maxAgeMs?: number;
}

/**
 * The authenticated caller, with the tenant facts every scoped surface needs.
 *
 * Distinct from {@link AuthSession}, which is the transport-level answer to "is
 * this request authenticated". This one answers "who, and what may they reach",
 * which requires the database and therefore cannot live on the DTO.
 */
export interface AuthenticatedCaller {
	readonly session: AuthSession;
	/**
	 * The `users.id` of the caller.
	 *
	 * `null` for the bearer-token path: a shared admin token has no user row. A
	 * caller MUST NOT treat null as "all access" — {@link resolveCallerOrganization}
	 * refuses to resolve a tenant for it.
	 */
	readonly userId: string | null;
	readonly email: string | null;
	readonly name: string | null;
	/** True only for the shared `ADMIN_API_TOKEN` path. */
	readonly isSharedAdminToken: boolean;
}

const getCookieName = (cookieName?: string): string => cookieName ?? config.sessionCookieName;
const getMaxAgeMs = (maxAgeMs?: number): number => maxAgeMs ?? config.sessionMaxAgeMs;

/**
 * Checks whether ANY authentication mechanism is enabled.
 *
 * Auth is "enabled" when either Google sign-in is configured or a legacy admin
 * token is set. This is what decides whether the dashboard offers a login at all.
 *
 * @returns `true` when at least one mechanism can authenticate a caller.
 */
export const isAuthEnabled = (): boolean =>
	config.adminApiToken.length > 0 ||
	(config.googleClientId.length > 0 && config.googleClientSecret.length > 0);

/** @deprecated Kept for the S3 surface, which compares against one shared secret. */
export { timingSafeCompare } from "../../../application/shared/utils/crypto";

/**
 * Signs an arbitrary payload with HMAC-SHA256.
 *
 * RETAINED, but no longer used to build sessions. The S3 surface and a few tests
 * still exercise it, and removing it would mean touching the SigV4 path in the
 * same change that rewrites authentication — two unrelated risk surfaces at once.
 * New session code must NOT use this: sessions are random opaque tokens now.
 *
 * @param payload - The value to sign.
 * @param secret - HMAC signing key.
 * @returns The base64url-encoded signature.
 */
export const signCookiePayload = (payload: string, secret: string): string =>
	createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * Verifies an HMAC signature and returns the signed payload.
 *
 * @param cookieValue - `<payload>.<signature>`.
 * @param secret - HMAC signing key.
 * @returns The payload, or `null` when invalid.
 */
export const verifyCookieSignature = (cookieValue: string, secret: string): string | null => {
	const separatorIndex = cookieValue.lastIndexOf(SIGNATURE_SEPARATOR);
	if (separatorIndex <= 0 || separatorIndex === cookieValue.length - 1) return null;

	const payload = cookieValue.slice(0, separatorIndex);
	const signature = cookieValue.slice(separatorIndex + 1);
	if (!timingSafeCompare(signature, signCookiePayload(payload, secret))) return null;

	return payload;
};

/**
 * Builds the `Set-Cookie` attributes.
 *
 * `Secure` is set when the deployment is https. It used to be set
 * UNCONDITIONALLY, which is why login over plain http silently produced a 200 and
 * a browser that dropped the cookie (contract gotcha 12). Deriving it from
 * `BASE_URL` makes a local http deployment work and keeps https strict.
 *
 * @param maxAgeSeconds - Max-Age in seconds.
 * @returns The attribute string.
 */
const cookieAttributes = (maxAgeSeconds: number): string => {
	const isHttps = config.baseUrl.startsWith("https://");
	const attributes = [`Max-Age=${maxAgeSeconds}`, "Path=/", "HttpOnly", "SameSite=Lax"];
	if (isHttps) attributes.push("Secure");
	return attributes.join("; ");
};

/**
 * Creates the `Set-Cookie` value for a real session token.
 *
 * @param token - The opaque token whose SHA-256 was persisted.
 * @param options - Cookie name / lifetime overrides.
 * @returns A fully-formed `Set-Cookie` header value.
 */
export const createSessionCookie = (token: string, options: CookieOptions = {}): string => {
	const cookieName = getCookieName(options.cookieName);
	const maxAgeMs = getMaxAgeMs(options.maxAgeMs);
	const maxAgeSeconds = Math.max(1, Math.floor(maxAgeMs / 1000));
	return `${cookieName}=${token}; ${cookieAttributes(maxAgeSeconds)}`;
};

/**
 * Creates a `Set-Cookie` value that expires the session cookie.
 *
 * @param cookieName - Name of the cookie to clear.
 * @returns A `Set-Cookie` header value with Max-Age=0.
 */
export const clearSessionCookie = (cookieName = config.sessionCookieName): string =>
	`${cookieName}=; ${cookieAttributes(0)}`;

/**
 * Finds a named cookie's value in a raw `Cookie` header.
 *
 * @param cookieHeader - The raw header, or `null`.
 * @param cookieName - Name to look for.
 * @returns The value, or `null`.
 */
const findCookieValue = (cookieHeader: string | null, cookieName: string): string | null => {
	if (!cookieHeader) return null;

	for (const rawCookie of cookieHeader.split(";")) {
		const cookie = rawCookie.trim();
		const equalsIndex = cookie.indexOf("=");
		if (equalsIndex <= 0) continue;

		const name = cookie.slice(0, equalsIndex);
		if (name === cookieName) return cookie.slice(equalsIndex + 1);
	}

	return null;
};

/**
 * Extracts the opaque session token from a request.
 *
 * @param req - The incoming request.
 * @param cookieName - Cookie name override.
 * @returns The token, or `null`.
 */
export const readSessionToken = (
	req: Request,
	cookieName = config.sessionCookieName
): string | null => findCookieValue(req.headers.get("cookie"), cookieName);

/**
 * Validates a `Bearer` token against the shared admin token.
 *
 * @param authorizationHeader - Raw `Authorization` header, or `null`.
 * @param secret - Expected token (defaults to `config.adminApiToken`).
 * @returns `true` when valid.
 */
export const checkBearerToken = (
	authorizationHeader: string | null,
	secret = config.adminApiToken
): boolean => {
	if (secret.length === 0 || !authorizationHeader) return false;
	if (!authorizationHeader.startsWith(LEGACY_BEARER_PREFIX)) return false;

	const token = authorizationHeader.slice(LEGACY_BEARER_PREFIX.length).trim();
	return token.length > 0 && timingSafeCompare(token, secret);
};

/**
 * Resolves the authenticated caller for a request.
 *
 * Order: session cookie (a real user), then bearer token (the shared admin).
 * Returns `null` when the request carries neither.
 *
 * @param req - The incoming request.
 * @param options - Cookie name override.
 * @returns The caller, or `null`.
 */
export const getAuthenticatedCaller = async (
	req: Request,
	options: Pick<CookieOptions, "cookieName"> = {}
): Promise<AuthenticatedCaller | null> => {
	// ── better-auth FIRST, the legacy table second ────────────────────────────
	//
	// better-auth owns new sign-ins; `sessions` is now a drain-only path for
	// cookies minted before it was installed, so it empties as they expire. Both
	// are consulted because dropping the second would log out every existing
	// session on deploy.
	//
	// This runs BEFORE the legacy cookie read on purpose: the two use different
	// cookie names (`tu_session` here, better-auth's own prefix), so there is no
	// ambiguity to resolve — but checking the going concern first means the
	// common case is one lookup, not two.
	const bridged = await resolveBetterAuthSession(req);
	if (bridged) {
		return {
			session: bridged.session,
			// better-auth's `auth_user.id` is a TEXT column, while every consumer
			// of `caller.userId` treats it as a `users.id` UUID — it becomes a
			// `$org=` membership lookup and an `uploader_user_id` foreign value.
			// Resolving the bridged `users` row keeps the two id spaces from being
			// conflated; `findUserIdByBetterAuthId` is a single indexed read and
			// is what makes "the same person" true across both models.
			userId: await resolveBridgedUserId(bridged.userId),
			email: bridged.email,
			name: bridged.name,
			isSharedAdminToken: false,
		};
	}

	const token = readSessionToken(req, getCookieName(options.cookieName));

	if (token) {
		const resolved = await identityRepository.findSessionUser(hashSessionToken(token));
		if (resolved) {
			return {
				session: {
					userId: resolved.user.id,
					username: resolved.user.email,
					expiresAt: resolved.session.expiresAt,
					method: "cookie",
				},
				userId: resolved.user.id,
				email: resolved.user.email,
				name: resolved.user.name,
				isSharedAdminToken: false,
			};
		}
		// A present-but-invalid cookie falls through to the bearer check rather than
		// short-circuiting: a machine caller may legitimately send both.
	}

	if (checkBearerToken(req.headers.get("authorization"))) {
		return {
			session: {
				userId: config.bootstrapAdminId,
				username: ADMIN_USERNAME,
				expiresAt: null,
				method: "bearer",
			},
			// NULL, deliberately: the shared token has no user row. Callers must fall
			// back to the bootstrap org explicitly, never assume global access.
			userId: null,
			email: null,
			name: null,
			isSharedAdminToken: true,
		};
	}

	return null;
};

/**
 * Session-only view of the caller, for surfaces that predate tenancy.
 *
 * @param req - The incoming request.
 * @returns The session, or `null`.
 */
export const getAuthSession = async (req: Request): Promise<AuthSession | null> => {
	const caller = await getAuthenticatedCaller(req);
	return caller?.session ?? null;
};

/**
 * Resolves WHICH organization a caller may operate on — the tenant boundary.
 *
 * ## Why this is not "the bootstrap admin's org" any more
 *
 * The previous `resolveAdminOrganizationId()` took no request and never read the
 * session: it mapped the configured `BOOTSTRAP_ADMIN_ID` to its organization on
 * every call, so every authenticated person shared one tenant. That was a
 * documented limitation, not a design, and it meant `members.user_id` was never
 * consulted for authorization.
 *
 * The rule now:
 *
 *   - a SESSION caller resolves to an organization they are actually a member of;
 *   - the requested slug is optional — absent, the caller's personal org is used;
 *   - a slug the caller is NOT a member of is a 403, never a silent fallback to
 *     their own org (which would make a shared link show the wrong files);
 *   - the BEARER caller (no user row) resolves to the configured bootstrap org,
 *     which is the pre-existing single-tenant behaviour.
 *
 * @param caller - The authenticated caller.
 * @param requestedSlug - Optional `$orgSlug`-style slug from the request.
 * @returns The organization id and the caller's role.
 * @throws {TenantAccessError} When the caller may not reach any/that tenant.
 */
export const resolveCallerOrganization = async (
	caller: AuthenticatedCaller,
	requestedSlug?: string | null
): Promise<{ organizationId: string; role: MemberRole }> => {
	if (caller.userId === null) {
		// Shared admin token: single-tenant behaviour, resolved from config. This is
		// the ONLY path that does not consult `members`.
		const organizationId = await bootstrapOrganizationId();
		return { organizationId, role: "owner" };
	}

	if (requestedSlug) {
		const organization = await identityRepository.findOrganizationBySlug(
			caller.userId,
			requestedSlug
		);
		if (!organization) {
			throw new TenantAccessError(
				`You are not a member of the organization "${requestedSlug}".`,
				403
			);
		}
		return { organizationId: organization.id, role: organization.role };
	}

	// No slug: the caller's personal workspace, which every user is guaranteed to
	// have after sign-in. This keeps `/api/v1/buckets` working without the client
	// having to know a slug first.
	const organizations = await identityRepository.listOrganizationsForUser(caller.userId);
	const personal = organizations.find((org) => org.role === "owner") ?? organizations[0];
	if (!personal) {
		throw new TenantAccessError(
			"No organization is available for this account. Sign out and sign in again to provision one.",
			403
		);
	}
	return { organizationId: personal.id, role: personal.role };
};

/**
 * Raised when a caller is authenticated but may not reach the tenant.
 *
 * Carries the status so the HTTP layer does not have to map error strings to
 * status codes — the mistake that previously turned a misconfiguration into a
 * per-request 403 indistinguishable from a real denial.
 */
export class TenantAccessError extends Error {
	constructor(
		message: string,
		readonly status: 403 | 503
	) {
		super(message);
		this.name = "TenantAccessError";
	}
}

/**
 * The bootstrap organization, resolved once and cached.
 *
 * @returns The organization UUID.
 * @throws {TenantAccessError} 503 when the bootstrap admin has no membership.
 */
let bootstrapOrganization: Promise<string> | null = null;

export const bootstrapOrganizationId = async (): Promise<string> => {
	bootstrapOrganization ??= (async () => {
		const { organizationRepository } = await import("../../../infrastructure/di");
		const organizationId = await organizationRepository.findOrganizationIdByUserId(
			config.bootstrapAdminId
		);
		if (!organizationId) {
			throw new TenantAccessError(
				`No organization membership for the bootstrap admin "${config.bootstrapAdminId}". ` +
					"Run `pnpm db:seed`, or point BOOTSTRAP_ADMIN_ID at an existing member.",
				503
			);
		}
		return organizationId;
	})().catch((error: unknown) => {
		// Do not cache a failure: a membership can be created without a restart.
		bootstrapOrganization = null;
		throw error;
	});

	return bootstrapOrganization;
};

/** Test seam: drop the memoized bootstrap organization. */
export const resetBootstrapOrganizationCache = (): void => {
	bootstrapOrganization = null;
};

/**
 * The organizations a caller may see, in one call.
 *
 * Branches on the caller's identity because the two cases genuinely differ: a real
 * user has membership rows, while the shared admin token has none and resolves to
 * the configured bootstrap organization. Centralising the branch keeps the two
 * callers (`GET /auth/me` and `GET /api/v1/organizations`) from drifting apart —
 * they were already duplicated once during this change, and a switcher that
 * disagreed with the session probe would render a selection the API then rejects.
 *
 * @param caller - The authenticated caller.
 * @returns The organizations, ordered by name. Empty when none are reachable.
 */
export const listOrganizationsForCaller = async (
	caller: AuthenticatedCaller
): Promise<{ id: string; slug: string; name: string; role: MemberRole }[]> => {
	if (caller.userId === null) return sharedTokenOrganizations();
	return identityRepository.listOrganizationsForUser(caller.userId);
};

/**
 * The shared admin token's single organization.
 *
 * @returns A one-entry list, or empty when the bootstrap membership is missing.
 */
export const sharedTokenOrganizations = async (): Promise<
	{ id: string; slug: string; name: string; role: MemberRole }[]
> => {
	const organizationId = await bootstrapOrganizationId().catch(() => null);
	if (!organizationId) return [];
	return [{ id: organizationId, slug: "default", name: "This deployment", role: "owner" }];
};

/**
 * A 401 JSON response.
 *
 * @returns A `Response` with status 401.
 */
export const unauthorizedResponse = (): Response =>
	Response.json({ error: "Unauthorized" }, { status: 401 });

/**
 * Wraps a raw handler in an authentication check.
 *
 * IMPORTANT: this checks AUTHENTICATION only. Tenant authorization is the
 * handler's job, because the handler knows which organization the request names
 * (`/api/v1/buckets/{bucket}` implies none, so the caller's default is used).
 *
 * When no auth mechanism is configured the handler is invoked directly — the
 * documented "auth disabled" mode, preserved so existing deployments that
 * deliberately run open keep working.
 *
 * @param handler - The handler to protect.
 * @param options - Cookie name override.
 * @returns A wrapped handler.
 */
export const requireAuth = (
	handler: Handler,
	options: Pick<CookieOptions, "cookieName"> = {}
): ((req: Request) => Promise<Response>) => {
	return async (req: Request): Promise<Response> => {
		if (!isAuthEnabled()) return handler(req);

		const caller = await getAuthenticatedCaller(req, options);
		if (!caller) return unauthorizedResponse();

		return handler(req);
	};
};
