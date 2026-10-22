/**
 * Repository port for users, sessions, and their organization memberships.
 *
 * ## Why one port instead of three
 *
 * Signing a person in is one atomic story: find-or-create the user, mint a
 * session, guarantee they have a personal organization, and resolve which
 * organizations they can see. Every step needs the others' writes to be visible
 * immediately, and splitting it across three ports would let a caller compose
 * them in the wrong order — mint a session for a user whose membership row
 * failed to insert, or resolve a tenant before the personal org exists. One port
 * keeps the sequence in the adapter where it can be reasoned about.
 *
 * ## Identity is `google_sub`, not email
 *
 * The email is stored and kept current, but the upsert keys on Google's `sub`
 * claim. A Google Workspace admin can reassign an address to a different human;
 * an email-keyed upsert would then hand one person's files to another. `sub` is
 * immutable for the life of the account.
 */

/** A person who can sign in. Mirrors the `users` table. */
export interface UserRecord {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly avatarUrl: string | null;
}

/** A revoked-on-demand session row. The token itself is never stored. */
export interface SessionRecord {
	readonly id: string;
	readonly userId: string;
	readonly expiresAt: Date;
}

/** An organization as the org switcher needs it. */
export interface OrganizationSummary {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	/** The caller's role in this organization. */
	readonly role: MemberRole;
}

/** The three roles a membership row can carry. Mirrors `members.role`. */
export type MemberRole = "owner" | "admin" | "member";

/** Profile claims from a verified Google ID token. */
export interface GoogleProfile {
	/** Google's stable subject claim — the identity key. */
	readonly sub: string;
	/** Already lowercased by the caller. */
	readonly email: string;
	readonly name: string;
	readonly avatarUrl: string | null;
}

/** An in-flight OAuth authorization. */
export interface PendingOAuth {
	readonly codeVerifier: string;
	/**
	 * The OIDC `nonce` this authorization was started with.
	 *
	 * Stored separately from `state` because it is a DIFFERENT credential with a
	 * different job: `state` is the CSRF token Google returns verbatim in the
	 * query string, while `nonce` goes into the signed ID token and must match
	 * what was sent as the authorization request's `nonce` parameter. Reusing
	 * `state` for it meant no `nonce` parameter was ever sent, so Google omitted
	 * the claim and every sign-in failed verification.
	 */
	readonly nonce: string;
	readonly redirectTo: string;
}

export interface IIdentityRepository {
	/**
	 * Create or update a user from a verified Google profile.
	 *
	 * Idempotent on `google_sub`: a returning user is updated (name/avatar can
	 * change), a new one is inserted. Never creates a duplicate for one subject.
	 *
	 * @param profile - Claims from a verified ID token.
	 * @returns The persisted user.
	 */
	upsertUserFromGoogle(profile: GoogleProfile): Promise<UserRecord>;

	/**
	 * Mint a session for a user.
	 *
	 * @param userId - The user's UUID.
	 * @param tokenHash - SHA-256 hex of the cookie token. The token is never
	 *   passed here, so it cannot be persisted by accident.
	 * @param expiresAt - Absolute expiry.
	 * @param userAgent - Truncated request metadata, for a future session list.
	 * @returns The created session.
	 */
	createSession(
		userId: string,
		tokenHash: string,
		expiresAt: Date,
		userAgent: string | null
	): Promise<SessionRecord>;

	/**
	 * Resolve a session token to its user, in ONE query.
	 *
	 * Returns `null` for an unknown, expired, or revoked session. Expiry is
	 * enforced in SQL (`expires_at > now()`), not in the caller, so a caller that
	 * forgets cannot revive a dead session.
	 *
	 * @param tokenHash - SHA-256 hex of the presented cookie token.
	 * @returns The user and session, or `null`.
	 */
	findSessionUser(tokenHash: string): Promise<{ user: UserRecord; session: SessionRecord } | null>;

	/**
	 * Delete one session by token hash. This is what makes logout real.
	 *
	 * @param tokenHash - SHA-256 hex of the presented cookie token.
	 * @returns `true` when a row was removed.
	 */
	deleteSession(tokenHash: string): Promise<boolean>;

	/**
	 * Delete every session for a user — "sign out everywhere".
	 *
	 * @param userId - The user's UUID.
	 * @returns The number of sessions removed.
	 */
	deleteAllSessionsForUser(userId: string): Promise<number>;

	/**
	 * Ensure the user owns exactly one personal organization, and return it.
	 *
	 * Safe to call on every sign-in: the first call creates the org and its owner
	 * membership, later calls return the existing row. Two concurrent calls for
	 * one user are resolved by the partial unique index on
	 * `organizations.personal_owner_user_id` — the loser re-reads the winner's row
	 * rather than failing.
	 *
	 * @param userId - The user's UUID.
	 * @param email - Used to derive a readable org name and unique slug.
	 * @returns The personal organization id and slug.
	 */
	ensurePersonalOrganization(
		userId: string,
		email: string,
		displayName?: string
	): Promise<{ id: string; slug: string; name: string }>;

	/**
	 * Every organization a user belongs to, ordered by name.
	 *
	 * @param userId - The user's UUID.
	 * @returns The memberships. Empty when the user has none (which the caller
	 *   must treat as "no access", never as "all access").
	 */
	listOrganizationsForUser(userId: string): Promise<OrganizationSummary[]>;

	/**
	 * The user's role in one organization, or `null` when not a member.
	 *
	 * This is the tenant authorization check: a caller may only operate on an
	 * organization this method returns a role for.
	 *
	 * @param userId - The user's UUID.
	 * @param organizationId - The organization UUID from the request.
	 */
	findMembership(userId: string, organizationId: string): Promise<MemberRole | null>;

	/**
	 * Resolve an organization by its URL slug, if the user is a member.
	 *
	 * @param userId - The user's UUID.
	 * @param slug - The `$orgSlug` path segment.
	 */
	findOrganizationBySlug(userId: string, slug: string): Promise<OrganizationSummary | null>;

	/**
	 * Store a pending OAuth authorization.
	 *
	 * @param state - Random `state` value; the primary key, so single-use.
	 * @param nonce - Random `nonce` value; required in the ID token's `nonce`
	 *   claim, and sent to Google as the authorization request's `nonce`
	 *   parameter so Google actually echoes it back.
	 * @param codeVerifier - PKCE verifier. Server-side only.
	 * @param redirectTo - A validated same-origin path.
	 * @param expiresAt - Absolute expiry (short — minutes).
	 */
	createOAuthState(
		state: string,
		nonce: string,
		codeVerifier: string,
		redirectTo: string,
		expiresAt: Date
	): Promise<void>;

	/**
	 * Atomically consume a pending OAuth authorization.
	 *
	 * DELETES the row and returns it, so a replayed `state` finds nothing. The
	 * delete is the reuse check — a separate SELECT-then-DELETE would admit a
	 * race between two concurrent callbacks.
	 *
	 * @param state - The `state` value from the callback query string.
	 * @returns The pending authorization, or `null` when unknown or expired.
	 */
	consumeOAuthState(state: string): Promise<PendingOAuth | null>;

	/** Delete expired sessions and OAuth states. Returns rows removed. */
	pruneExpired(): Promise<number>;
}
