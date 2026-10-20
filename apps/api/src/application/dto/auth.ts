/**
 * Authentication DTOs.
 *
 * ## `AuthSession` changed shape when multi-user landed
 *
 * It used to carry only `username: string`, which the login flow hardcoded to
 * `"admin"` and the cookie parser hard-validated to that same literal. There was
 * no user id, because there was no user — `members.user_id` pointed at a row that
 * did not exist.
 *
 * `userId` is therefore new, and it is what makes per-user tenancy possible.
 * For the shared `ADMIN_API_TOKEN` path it holds the configured bootstrap admin
 * id; those callers are still single-tenant and
 * `resolveCallerOrganization` treats them separately.
 */

/**
 * How a caller authenticated.
 *
 * `disabled` is a real third case, not a placeholder: a deployment with no
 * `ADMIN_API_TOKEN` and no Google credentials runs OPEN, and `requireAuth` is a
 * genuine pass-through there. Reporting it as `bearer` would name a credential
 * nobody presented, and reporting 401 would tell the dashboard it is read-only
 * while the API would happily accept the write.
 */
export type AuthMethod = "cookie" | "bearer" | "disabled";

/**
 * Active authentication session information.
 */
export interface AuthSession {
	/**
	 * The authenticated user's id (`users.id`).
	 *
	 * For a bearer-token session this is `config.bootstrapAdminId`, which names no
	 * `users` row — a shared token has no identity. Do not render it as a person.
	 */
	userId: string;
	/**
	 * Human-facing identity: the user's email for a cookie session, or `"admin"`
	 * for the shared bearer token.
	 */
	username: string;
	/** Session expiry timestamp; null for bearer-token sessions. */
	expiresAt: Date | null;
	/** Authentication method used. */
	method: AuthMethod;
}

/**
 * Response payload for `GET /api/v1/auth/me`.
 *
 * Carries the profile and the organizations the caller may switch between, so
 * the SPA can render the org switcher from one round trip instead of two.
 */
export interface UserInfoResponse {
	/** The user's id. */
	userId: string;
	/** Email address (the login identity). */
	email: string;
	/** Display name; empty string when the provider supplied none. */
	name: string;
	/** Avatar URL, or null. */
	avatarUrl: string | null;
	/** ISO-8601 session expiry; null for a bearer-token and disabled session. */
	expiresAt: string | null;
	/** How the caller authenticated. */
	method: AuthMethod;
	/** Organizations the caller may switch to, ordered by name. */
	organizations: {
		id: string;
		slug: string;
		name: string;
		role: "owner" | "admin" | "member";
	}[];
	/**
	 * Whether the server has Google sign-in configured.
	 *
	 * Lets the login page render a working button (or an actionable explanation)
	 * without probing an endpoint that would redirect it to Google.
	 */
	googleEnabled: boolean;
}

/** Response payload for logout. */
export interface LogoutResponse {
	/** Whether the logout succeeded. */
	success: boolean;
}
