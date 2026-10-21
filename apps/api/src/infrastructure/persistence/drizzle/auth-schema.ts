import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * better-auth's own table shapes, for the drizzle adapter.
 *
 * ## Why these are NOT the `users` / `sessions` tables already in `schema.ts`
 *
 * The existing `users` / `sessions` tables are this project's own identity model,
 * written by `identity-repository.ts` and read by `middleware/auth.ts`. They use
 * `uuid` ids, a `google_sub` column, and `sessions.token_hash` (SHA-256 only).
 *
 * better-auth cannot reuse them without a rewrite it cannot perform: it requires
 * an `email_verified` column, a `name` it treats as NOT NULL with no default, an
 * `account` table it owns entirely (one row per provider link, carrying the
 * provider's `accountId`), and a `verification` table. It also stores the session
 * token VERBATIM in `session.token` — verified in `internal-adapter.mjs`, where
 * `token: generateId(32)` is inserted with no hashing step.
 *
 * That last fact is the reason this file exists instead of an adapter mapping
 * onto the old tables. Reusing `sessions` would mean either (a) storing a
 * plaintext token in a column documented as a hash, or (b) aliasing
 * `session.token` → `sessions.token_hash`, which makes every better-auth session
 * lookup an equality match against a value the browser holds — the exact
 * property the hash exists to prevent.
 *
 * So the two models COEXIST, side by side, deliberately:
 *
 *   - `auth_*` tables: better-auth's. Owned by the library, never written by hand.
 *   - `users` / `sessions` / `oauth_states`: this project's. Kept because the S3
 *     credential path, `members.user_id`, and the live session middleware all read
 *     them, and because 31k production file rows reference the org they scope.
 *
 * `auth_user.email` is the join key between the two worlds. A sign-in through
 * better-auth provisions (or adopts) the matching row in `users`, so every
 * existing bucket keeps resolving to the same organization. See
 * `infrastructure/auth/better-auth.ts` for that bridge.
 *
 * ## Naming
 *
 * Tables are `auth_`-prefixed, and `usePlural` is NOT used, so better-auth's
 * model name `user` maps to table `auth_user` via an explicit `modelName` in its
 * config. The prefix is what keeps a future `drizzle-kit generate` from trying to
 * reconcile these with the unrelated `users` table.
 *
 * Columns are camelCase in TypeScript and snake_case in Postgres, matching
 * `drizzleAdapter({ camelCase: false })` — the library's own default, which is
 * what its field-name lookups expect.
 */

/** better-auth's `user` model. */
export const authUser = pgTable(
	"auth_user",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		/** better-auth refuses to build without this column; it is not optional. */
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [uniqueIndex("auth_user_email_unique").on(t.email)]
);

/** better-auth's `session` model. Holds the token VERBATIM — see the header. */
export const authSession = pgTable(
	"auth_session",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		token: text("token").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("auth_session_token_unique").on(t.token),
		index("idx_auth_session_user_id").on(t.userId),
	]
);

/**
 * better-auth's `account` model — one row per provider link.
 *
 * `providerId` + `accountId` is the stable provider key (Google's `sub` lands in
 * `accountId`), so this is where the "same person, second sign-in" match
 * happens. `password` is present because the schema is shared with credential
 * sign-in; it stays NULL for an OAuth-only deployment.
 */
export const authAccount = pgTable(
	"auth_account",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [
		index("idx_auth_account_user_id").on(t.userId),
		uniqueIndex("auth_account_provider_account_unique").on(t.providerId, t.accountId),
	]
);

/**
 * better-auth's `verification` model (email verification, password reset).
 *
 * Declared because the library creates rows for it during some flows; an unused
 * but present table is correct, while a missing one is a runtime error the moment
 * a flow touches it.
 */
export const authVerification = pgTable(
	"auth_verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(t) => [index("idx_auth_verification_identifier").on(t.identifier)]
);

/**
 * better-auth's `rateLimit` model.
 *
 * Only used when `rateLimit.storage` is `"database"`. Declared for the same
 * reason as `verification`: the adapter resolves the model by name, and a
 * missing table surfaces as an error rather than a clean "not configured".
 *
 * NO `id` COLUMN, and that is not an omission. Verified in better-auth's
 * `dist/api/rate-limiter/index.mjs`: the storage wrapper creates rows with
 * exactly `{ key, count, lastRequest }` and then locates them by `key`. It never
 * generates or reads an id, so declaring one would make the adapter send a column
 * the library never populates — and, with a NOT NULL id, every rate-limit insert
 * would fail.
 */
export const authRateLimit = pgTable(
	"auth_rate_limit",
	{
		/** The bucket key — the primary key, since lookups are by key alone. */
		key: text("key").primaryKey(),
		count: bigint("count", { mode: "number" }).notNull(),
		lastRequest: bigint("last_request", { mode: "number" }).notNull(),
	},
	(t) => [uniqueIndex("auth_rate_limit_key_unique").on(t.key)]
);

/** Every better-auth table, in the shape its drizzle adapter expects (`usePlural: false`). */
export const authSchema = {
	user: authUser,
	session: authSession,
	account: authAccount,
	verification: authVerification,
	rateLimit: authRateLimit,
};
