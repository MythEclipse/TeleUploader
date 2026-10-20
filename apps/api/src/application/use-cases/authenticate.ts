import type {
	GoogleProfile,
	IIdentityRepository,
	MemberRole,
} from "../../domain/ports/identity-repository";
import {
	generateSessionToken,
	hashSessionToken,
} from "../../infrastructure/persistence/repositories/identity-repository";
import type { UserInfoResponse } from "../dto/auth";

/**
 * Authentication use cases.
 *
 * ## Why this exists now when the token login barely needed it
 *
 * The previous version of this file held three near-empty functions: `login`
 * compared a token with `timingSafeCompare` and returned the literal `"admin"`.
 * That was small enough to sit in the controller.
 *
 * Signing a person in is not: it is a sequence with real invariants — upsert the
 * identity keyed on an immutable subject claim, provision the workspace BEFORE the
 * session so the first authenticated request has a tenant, mint a token whose hash
 * is stored and whose plaintext is returned exactly once, and return the profile
 * the SPA needs. Keeping that in the HTTP layer would put a durable data invariant
 * behind a transport file, where a second surface (oRPC, a future CLI) could
 * reimplement it differently.
 *
 * The split is therefore: these functions decide WHAT happens, the controller
 * decides how it becomes HTTP (status, `Set-Cookie`, redirect).
 */

/** Dependencies every use case here needs. */
export interface AuthUseCaseDeps {
	readonly identityRepository: IIdentityRepository;
	/** How long a newly minted session lives, in milliseconds. */
	readonly sessionMaxAgeMs: number;
}

/** The outcome of a successful sign-in. */
export interface SignInResult {
	readonly userId: string;
	readonly email: string;
	readonly name: string;
	/**
	 * The opaque session token, to be placed in the cookie.
	 *
	 * This is the ONLY time the plaintext exists outside the browser: the database
	 * holds its SHA-256. Do not log it, and do not persist it anywhere else.
	 */
	readonly sessionToken: string;
	readonly expiresAt: Date;
}

/**
 * Builds the sign-in use case.
 *
 * Idempotent for a returning user: the same Google subject resolves to the same
 * `users` row, and their personal organization is reused rather than duplicated.
 *
 * @param deps - Injected repository and session lifetime.
 * @returns A function turning a verified Google profile into a live session.
 */
export function createSignInUseCase(deps: AuthUseCaseDeps) {
	return async (profile: GoogleProfile, userAgent: string | null): Promise<SignInResult> => {
		const user = await deps.identityRepository.upsertUserFromGoogle(profile);

		// BEFORE the session. Every authenticated read resolves a tenant from
		// `members`, so a session minted before the organization exists would produce
		// a signed-in user whose first dashboard load answers 403.
		await deps.identityRepository.ensurePersonalOrganization(user.id, user.email, user.name);

		const sessionToken = generateSessionToken();
		const expiresAt = new Date(Date.now() + deps.sessionMaxAgeMs);

		// Only the hash is persisted — a database read cannot reconstruct the token.
		await deps.identityRepository.createSession(
			user.id,
			hashSessionToken(sessionToken),
			expiresAt,
			userAgent
		);

		return {
			userId: user.id,
			email: user.email,
			name: user.name,
			sessionToken,
			expiresAt,
		};
	};
}

/**
 * Builds the current-user use case.
 *
 * @param deps - Injected repository.
 * @returns A function assembling the `/auth/me` body for an authenticated caller.
 */
export function createMeUseCase(deps: Pick<AuthUseCaseDeps, "identityRepository">) {
	return async (params: {
		/** `null` for the shared admin token, which has no `users` row. */
		userId: string | null;
		email: string | null;
		name: string | null;
		expiresAt: Date | null;
		method: "cookie" | "bearer";
		/** Used when `userId` is null — the token's bootstrap organization. */
		fallbackOrganizations: UserInfoResponse["organizations"];
		googleEnabled: boolean;
	}): Promise<UserInfoResponse> => {
		const organizations =
			params.userId === null
				? params.fallbackOrganizations
				: await deps.identityRepository.listOrganizationsForUser(params.userId);

		return {
			userId: params.userId ?? "shared-admin-token",
			// Stated plainly rather than as an empty string: a UI that renders "#null"
			// or a blank name is worse than one that says what the caller actually is.
			email: params.email ?? "admin (shared token)",
			name: params.name ?? "Shared admin token",
			avatarUrl: null,
			expiresAt: params.expiresAt?.toISOString() ?? null,
			method: params.method,
			organizations,
			googleEnabled: params.googleEnabled,
		};
	};
}

/**
 * Builds the logout use case.
 *
 * Revocation is the whole point: the session row is DELETED, so a cookie captured
 * before logout stops working immediately. The previous stateless design could
 * only ask the browser to forget.
 *
 * @param deps - Injected repository.
 * @returns A function revoking one session by its plaintext token.
 */
export function createLogoutUseCase(deps: Pick<AuthUseCaseDeps, "identityRepository">) {
	return async (sessionToken: string | null): Promise<boolean> => {
		if (!sessionToken) return false;
		return deps.identityRepository.deleteSession(hashSessionToken(sessionToken));
	};
}

/**
 * Builds the "sign out everywhere" use case.
 *
 * @param deps - Injected repository.
 * @returns A function revoking every session for one user.
 */
export function createLogoutAllUseCase(deps: Pick<AuthUseCaseDeps, "identityRepository">) {
	return async (userId: string): Promise<number> =>
		deps.identityRepository.deleteAllSessionsForUser(userId);
}

/** Re-exported so callers do not need the port module for this one type. */
export type { MemberRole };
