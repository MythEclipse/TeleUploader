import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
	GoogleProfile,
	IIdentityRepository,
	MemberRole,
	OrganizationSummary,
	PendingOAuth,
	SessionRecord,
	UserRecord,
} from "../../../domain/ports/identity-repository";
import logger from "../../observability/logger";
import { db } from "../drizzle/index";

/** Raw row shape returned by `db.execute()`. */
type QueryResult = Record<string, unknown>[];

/**
 * Parses a `timestamp WITHOUT time zone` value into a UTC-correct `Date`.
 *
 * ## Why this cannot just be `new Date(value)`
 *
 * The identity tables use naive `timestamp` columns (matching the rest of this
 * schema), and postgres.js returns those as STRINGS — it only auto-parses
 * `timestamptz`. `new Date("2026-10-20 09:08:18")` parses a string with a space
 * separator as LOCAL time, so on a +07 host the resulting Date is seven hours off.
 *
 * Values are always WRITTEN as `toISOString()` (UTC), so pinning `Z` on read is the
 * exact inverse. Both halves have to agree or expiry math silently drifts by the
 * deployment's offset.
 *
 * @param value - A timestamp string, a Date, or null.
 * @returns The instant, or `null` when the input is null/invalid.
 */
const parseUtcTimestamp = (value: unknown): Date => {
	if (value instanceof Date) return value;
	if (typeof value !== "string") return new Date(Number.NaN);

	// `2026-10-20 09:08:18.552` -> `2026-10-20T09:08:18.552Z`. An already-ISO value
	// with a `T` and `Z` is left alone.
	const normalised = value.includes("T") ? value : value.replace(" ", "T");
	const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`;
	return new Date(withZone);
};

/**
 * Extracts a Postgres SQLSTATE from a thrown error.
 *
 * ## Why this is not just `error.code`
 *
 * `db.execute()` does NOT rethrow the driver error. Drizzle wraps it:
 *
 * ```ts
 * class DrizzleQueryError extends Error {
 *   constructor(query, params, cause) {
 *     super(`Failed query: ${query}...`);
 *     this.cause = cause;
 *   }
 * }
 * ```
 *
 * So the top-level error has NO `code` property and the SQLSTATE lives at
 * `error.cause.code`. Verified against this exact stack with
 * `test/probe-unique-violation-shape.ts`:
 *
 * ```
 * PROBE constructor: DrizzleQueryError
 * PROBE error.code: undefined
 * PROBE error.cause.code: 23505
 * ```
 *
 * Reading only `error.code` made every unique-violation recovery path unreachable
 * dead code — a concurrent sign-in threw instead of returning the workspace that had
 * just been created by the other request. Both locations are checked because the
 * wrapper is a Drizzle implementation detail, not a contract, and a future version
 * could stop wrapping.
 *
 * @param error - Anything thrown.
 * @returns The SQLSTATE, or `undefined` when this is not a Postgres error.
 */
const sqlStateOf = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined;
	const direct = (error as { code?: unknown }).code;
	if (typeof direct === "string") return direct;
	const nested = (error as { cause?: { code?: unknown } }).cause?.code;
	return typeof nested === "string" ? nested : undefined;
};

/**
 * Maps a raw user row.
 *
 * `name` and `avatar_url` are nullable in practice: a Google account can have no
 * display name, and the avatar column is nullable by design. The mapper coerces
 * `name` to `""` so callers never render the literal string "null".
 */
const mapUser = (row: Record<string, unknown>): UserRecord => ({
	id: row.id as string,
	email: row.email as string,
	name: typeof row.name === "string" ? row.name : "",
	avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
});

/**
 * Derives a slug-safe fragment from an email's local part.
 *
 * Kept deliberately dumb: lowercase, non-alphanumerics collapsed to `-`, and
 * truncated so the result fits `varchar(63)` with room for a uniqueness suffix.
 * Uniqueness itself is NOT solved here — {@link DrizzleIdentityRepository.ensurePersonalOrganization}
 * appends a discriminator and retries, because a slug computed from an email
 * cannot be unique on its own (`a.b@x` and `a-b@x` collapse together).
 */
const slugFragment = (email: string): string => {
	const localPart = email.split("@")[0] ?? "user";
	const cleaned = localPart
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	// 3 is the minimum the S3 bucket-name rules impose on the sibling namespace,
	// and an empty slug would produce `--<suffix>` which reads as a typo.
	return cleaned.length >= 3 ? cleaned.slice(0, 40) : "user";
};

/**
 * Drizzle-backed implementation of {@link IIdentityRepository}.
 *
 * ## Deliberately raw SQL, like every other repository here
 *
 * The sibling repositories use `db.execute(sql…)` rather than Drizzle's query
 * builder. That is not stylistic: `drizzle/index.ts` constructs the client with
 * `schema: { fileParts, files }` only, so a builder query against `users` would
 * compile but have no relational schema behind it. Raw SQL keeps this file
 * consistent with the adapters it sits beside and avoids widening that schema
 * registration as a side effect of adding auth.
 *
 * ## Every statement that can race is written to be race-safe
 *
 * Sign-in is the one flow in this service that two concurrent requests will
 * genuinely interleave (a double-clicked sign-in button, or React StrictMode's
 * doubled effect). Both the user upsert and the personal-org creation therefore
 * use ON CONFLICT plus a re-read, never a SELECT-then-INSERT.
 */
export class DrizzleIdentityRepository implements IIdentityRepository {
	/** {@inheritDoc IIdentityRepository.upsertUserFromGoogle} */
	async upsertUserFromGoogle(profile: GoogleProfile): Promise<UserRecord> {
		// Keyed on google_sub (immutable), NOT email (reassignable). The email and
		// name are brought up to date on every sign-in because they are the fields
		// a provider legitimately changes.
		const rows = (await db.execute(sql`
			INSERT INTO users (email, name, avatar_url, google_sub, last_login_at, updated_at)
			VALUES (${profile.email}, ${profile.name}, ${profile.avatarUrl}, ${profile.sub}, now(), now())
			ON CONFLICT (google_sub) DO UPDATE SET
				email = EXCLUDED.email,
				name = EXCLUDED.name,
				avatar_url = EXCLUDED.avatar_url,
				last_login_at = now(),
				updated_at = now()
			RETURNING id, email, name, avatar_url
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) {
			// Unreachable for an INSERT ... RETURNING, so this is a real fault rather
			// than a branch: refusing loudly beats returning a half-built identity.
			throw new Error("upsertUserFromGoogle returned no row");
		}
		return mapUser(row);
	}

	/** {@inheritDoc IIdentityRepository.createSession} */
	async createSession(
		userId: string,
		tokenHash: string,
		expiresAt: Date,
		userAgent: string | null
	): Promise<SessionRecord> {
		// ISO STRING, not the Date object. `db.execute()` goes through postgres.js's
		// raw simple-query path, which does NOT serialise a JS Date — it throws
		// "The string argument must be of type string or an instance of Buffer or
		// ArrayBuffer. Received an instance of Date". Verified against a live
		// database; every mock passed while the real INSERT failed.
		//
		// The sibling repositories never hit this because they express timestamps as
		// `now()` in SQL rather than binding a Date. Here the expiry is caller-supplied,
		// so it has to cross the boundary explicitly.
		const rows = (await db.execute(sql`
			INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
			VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}, ${userAgent})
			RETURNING id, user_id, expires_at
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) throw new Error("createSession returned no row");

		return {
			id: row.id as string,
			userId: row.user_id as string,
			expiresAt: parseUtcTimestamp(row.expires_at),
		};
	}

	/** {@inheritDoc IIdentityRepository.findSessionUser} */
	async findSessionUser(
		tokenHash: string
	): Promise<{ user: UserRecord; session: SessionRecord } | null> {
		// ── WHY THE EXPIRY COMPARISON IS `now() AT TIME ZONE 'UTC'` ─────────────
		//
		// `sessions.expires_at` is `timestamp WITHOUT time zone`, while `now()` is
		// `timestamptz`. Comparing the two makes Postgres cast the NAIVE value using
		// the session's `TimeZone` setting, so the result depends on where the server
		// happens to run. Verified on this host (TimeZone=Asia/Jakarta, +07): a session
		// written to expire in two minutes read back as ALREADY EXPIRED, because the
		// naive value was interpreted as +07 while it had been stored as UTC.
		//
		// Normalising both sides to UTC removes the dependency. `at time zone 'UTC'`
		// on a `timestamptz` yields the naive UTC wall clock, which is exactly what the
		// column holds — so the comparison is naive-to-naive and timezone-free.
		//
		// Every timestamp comparison in this file uses the same expression. Mixing the
		// two conventions is what produced this bug in the first place.
		const rows = (await db.execute(sql`
			SELECT s.id AS session_id, s.user_id, s.expires_at,
			       u.id, u.email, u.name, u.avatar_url
			FROM sessions s
			JOIN users u ON u.id = s.user_id
			WHERE s.token_hash = ${tokenHash}
			  AND s.expires_at > (now() AT TIME ZONE 'UTC')
			LIMIT 1
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) return null;

		return {
			user: mapUser(row),
			session: {
				id: row.session_id as string,
				userId: row.user_id as string,
				// A `timestamp` column comes back as a STRING, not a Date (postgres.js
				// only parses `timestamptz`). Appending `Z` pins it as UTC, matching how
				// it was written; without it, `new Date("2026-10-20 09:08:18")` is parsed
				// as LOCAL time and silently shifts the reported expiry.
				expiresAt: parseUtcTimestamp(row.expires_at),
			},
		};
	}

	/** {@inheritDoc IIdentityRepository.deleteSession} */
	async deleteSession(tokenHash: string): Promise<boolean> {
		const rows = (await db.execute(sql`
			DELETE FROM sessions WHERE token_hash = ${tokenHash} RETURNING id
		`)) as unknown as QueryResult;
		return rows.length > 0;
	}

	/** {@inheritDoc IIdentityRepository.deleteAllSessionsForUser} */
	async deleteAllSessionsForUser(userId: string): Promise<number> {
		const rows = (await db.execute(sql`
			DELETE FROM sessions WHERE user_id = ${userId}::uuid RETURNING id
		`)) as unknown as QueryResult;
		return rows.length;
	}

	/**
	 * {@inheritDoc IIdentityRepository.ensurePersonalOrganization}
	 *
	 * The insert is guarded by the partial unique index on
	 * `personal_owner_user_id`, so the second of two concurrent callers gets a
	 * unique violation instead of a duplicate workspace. That violation is
	 * EXPECTED and handled by re-reading — it is the concurrency control, not an
	 * error. Any other error propagates.
	 */
	async ensurePersonalOrganization(
		userId: string,
		email: string,
		displayName?: string
	): Promise<{ id: string; slug: string; name: string }> {
		const existing = await this.findPersonalOrganization(userId);
		if (existing) return existing;

		const base = slugFragment(email);
		// The workspace NAME is what the org switcher renders, so it uses the person's
		// display name — "Alice's files" — rather than the raw address. A switcher full
		// of `alice@example.com's files` leaks every member's email to anyone who can
		// see the control, and reads like a bug. The SLUG still comes from the email,
		// because it has to be unique-ish and URL-safe before a display name exists.
		const label =
			displayName && displayName.trim().length > 0
				? displayName.trim()
				: (email.split("@")[0] ?? email);
		// A few attempts rather than a loop to exhaustion: each collision consumes a
		// distinguishable suffix, and giving up loudly is better than spinning on a
		// namespace that will not yield.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
			const name = attempt === 0 ? `${label}'s files` : `${label}'s files (${attempt + 1})`;

			try {
				const rows = (await db.execute(sql`
					INSERT INTO organizations (name, slug, personal_owner_user_id)
					VALUES (${name}, ${slug}, ${userId}::uuid)
					RETURNING id, slug, name
				`)) as unknown as QueryResult;

				const row = rows[0];
				if (!row) throw new Error("ensurePersonalOrganization returned no row");

				const organizationId = row.id as string;
				// The owner membership is what makes the org reachable at all: every
				// read path goes through `members`, so an org without one is invisible
				// to its own owner.
				await db.execute(sql`
					INSERT INTO members (organization_id, user_id, role)
					VALUES (${organizationId}::uuid, ${userId}, 'owner')
					ON CONFLICT (organization_id, user_id) DO NOTHING
				`);

				return { id: organizationId, slug: row.slug as string, name: row.name as string };
			} catch (error: unknown) {
				// Two distinct recoverable collisions share this handler because both
				// mean "someone else got there first":
				//   23505 unique_violation — either the personal-owner index (this user
				//         already has an org) or the slug index (a different user holds
				//         this slug); and the name index, which is also UNIQUE.
				//
				// `sqlStateOf`, not `error.code`: Drizzle wraps the driver error, so the
				// SQLSTATE is on `error.cause`. Reading the top level made this whole
				// recovery path dead code and a concurrent sign-in threw instead.
				if (sqlStateOf(error) === "23505") {
					// Re-read first: if the violation was the personal-owner index, the
					// org already exists and there is nothing left to create.
					const raced = await this.findPersonalOrganization(userId);
					if (raced) return raced;
					// Otherwise it was the slug/name. Try the next discriminator.
					continue;
				}
				throw error;
			}
		}

		logger.error("Could not allocate a unique personal organization slug", { userId });
		throw new Error(`Could not allocate a personal organization for user ${userId}`);
	}

	/**
	 * Reads the user's personal organization, if it already exists.
	 *
	 * @param userId - The user's UUID.
	 * @returns The org, or `null`.
	 */
	private async findPersonalOrganization(
		userId: string
	): Promise<{ id: string; slug: string; name: string } | null> {
		const rows = (await db.execute(sql`
			SELECT id, slug, name FROM organizations
			WHERE personal_owner_user_id = ${userId}::uuid
			LIMIT 1
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) return null;
		return { id: row.id as string, slug: row.slug as string, name: row.name as string };
	}

	/** {@inheritDoc IIdentityRepository.listOrganizationsForUser} */
	async listOrganizationsForUser(userId: string): Promise<OrganizationSummary[]> {
		const rows = (await db.execute(sql`
			SELECT o.id, o.slug, o.name, m.role
			FROM members m
			JOIN organizations o ON o.id = m.organization_id
			WHERE m.user_id = ${userId}
			ORDER BY o.name ASC
		`)) as unknown as QueryResult;

		return rows.map((row) => ({
			id: row.id as string,
			slug: row.slug as string,
			name: row.name as string,
			role: row.role as MemberRole,
		}));
	}

	/** {@inheritDoc IIdentityRepository.findMembership} */
	async findMembership(userId: string, organizationId: string): Promise<MemberRole | null> {
		const rows = (await db.execute(sql`
			SELECT role FROM members
			WHERE user_id = ${userId} AND organization_id = ${organizationId}::uuid
			LIMIT 1
		`)) as unknown as QueryResult;

		const row = rows[0];
		return row ? (row.role as MemberRole) : null;
	}

	/** {@inheritDoc IIdentityRepository.findOrganizationBySlug} */
	async findOrganizationBySlug(userId: string, slug: string): Promise<OrganizationSummary | null> {
		// The JOIN on members is the authorization: a slug the caller is not a
		// member of is indistinguishable from a nonexistent one, which prevents the
		// endpoint from confirming that another tenant's organization exists.
		const rows = (await db.execute(sql`
			SELECT o.id, o.slug, o.name, m.role
			FROM organizations o
			JOIN members m ON m.organization_id = o.id
			WHERE o.slug = ${slug} AND m.user_id = ${userId}
			LIMIT 1
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) return null;
		return {
			id: row.id as string,
			slug: row.slug as string,
			name: row.name as string,
			role: row.role as MemberRole,
		};
	}

	/** {@inheritDoc IIdentityRepository.createOAuthState} */
	async createOAuthState(
		state: string,
		codeVerifier: string,
		redirectTo: string,
		expiresAt: Date
	): Promise<void> {
		// `expiresAt.toISOString()` for the same reason as `createSession`: a bare Date
		// does not survive `db.execute()`'s raw parameter path.
		await db.execute(sql`
			INSERT INTO oauth_states (state, code_verifier, redirect_to, expires_at)
			VALUES (${state}, ${codeVerifier}, ${redirectTo}, ${expiresAt.toISOString()})
		`);
	}

	/**
	 * {@inheritDoc IIdentityRepository.consumeOAuthState}
	 *
	 * DELETE ... RETURNING is the whole reuse check: two concurrent callbacks
	 * carrying the same `state` produce exactly one row from one of them and
	 * `null` from the other.
	 *
	 * The expiry comparison uses `now() AT TIME ZONE 'UTC'` for the same reason
	 * `findSessionUser` does: `expires_at` is a naive `timestamp` and `now()` is a
	 * `timestamptz`, so comparing them directly makes the result depend on the
	 * server's `TimeZone`. On a +07 host that made a fresh state read as expired.
	 */
	async consumeOAuthState(state: string): Promise<PendingOAuth | null> {
		const rows = (await db.execute(sql`
			DELETE FROM oauth_states
			WHERE state = ${state} AND expires_at > (now() AT TIME ZONE 'UTC')
			RETURNING code_verifier, redirect_to
		`)) as unknown as QueryResult;

		const row = rows[0];
		if (!row) return null;
		return {
			codeVerifier: row.code_verifier as string,
			redirectTo: row.redirect_to as string,
		};
	}

	/** {@inheritDoc IIdentityRepository.pruneExpired} */
	async pruneExpired(): Promise<number> {
		// Same naive-vs-timestamptz normalisation as the two lookups above.
		const sessions = (await db.execute(sql`
			DELETE FROM sessions WHERE expires_at <= (now() AT TIME ZONE 'UTC') RETURNING id
		`)) as unknown as QueryResult;
		const states = (await db.execute(sql`
			DELETE FROM oauth_states WHERE expires_at <= (now() AT TIME ZONE 'UTC') RETURNING state
		`)) as unknown as QueryResult;
		return sessions.length + states.length;
	}
}

/**
 * SHA-256 of a session token, hex-encoded.
 *
 * The only place a raw session token is converted to its stored form. Keeping it
 * here — rather than at each call site — is what guarantees the hash used to
 * CREATE a session and the hash used to LOOK ONE UP cannot diverge.
 *
 * @param token - The opaque cookie value.
 * @returns 64-char lowercase hex, matching `sessions.token_hash`.
 */
export const hashSessionToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/**
 * Generates a new opaque session token.
 *
 * `randomUUID` is used rather than `Math.random` or a counter: this value IS the
 * credential, so it must come from the CSPRNG. 122 bits of entropy, and two UUIDs
 * concatenated would be belt-and-braces without benefit, since 122 bits is far
 * past guessable.
 *
 * @returns A URL-safe token safe to place in a cookie.
 */
export const generateSessionToken = (): string => randomUUID();
