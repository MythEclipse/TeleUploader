-- better-auth's own tables, alongside this project's existing identity model.
--
-- WHY THESE ARE NEW TABLES RATHER THAN A MAPPING ONTO users / sessions
--
-- The project already has `users`, `sessions` and `oauth_states` (migration
-- 0004), written by hand in `identity-repository.ts`. better-auth cannot reuse
-- them:
--
--   * it requires `email_verified` on the user, and an `account` table it owns
--     entirely (one row per provider link, holding Google's `sub` as `account_id`);
--   * it requires a `verification` table, touched by several built-in flows;
--   * it stores the session token VERBATIM in `session.token` — verified in
--     better-auth's `dist/db/internal-adapter.mjs`, which inserts
--     `token: generateId(32)` with no hashing step.
--
-- That last point is decisive. `sessions.token_hash` is documented, and relied
-- on by `findSessionUser`, as being ONLY the SHA-256 of the cookie value, so a
-- database read cannot mint a working session. Aliasing `session.token` onto that
-- column would put a live bearer credential in it, and alias-mapping in the other
-- direction would make every lookup an equality match against a value the browser
-- holds. Neither is acceptable, so the two models coexist:
--
--   auth_user / auth_session / auth_account / auth_verification / auth_rate_limit
--     → owned by better-auth, never hand-written.
--   users / sessions / oauth_states
--     → owned by this application, kept because `members.user_id`, the S3
--       credential path, and 31k file rows scope through them.
--
-- The bridge is `email` → `users.email`, applied in
-- `infrastructure/auth/better-auth.ts`. A sign-in through better-auth upserts the
-- SAME `users` row that owns the person's buckets, so no existing file loses its
-- organization.
--
-- PURELY ADDITIVE: every statement is CREATE TABLE / CREATE INDEX. No existing
-- row, column or constraint is touched, so applying this against the live
-- database (0 users, 0 sessions, 31311 files at time of writing) cannot fail on
-- existing content and cannot lose data.

CREATE TABLE IF NOT EXISTS "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- UNIQUE because better-auth resolves a user by email on every OAuth callback.
CREATE UNIQUE INDEX IF NOT EXISTS "auth_user_email_unique" ON "auth_user" USING btree ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Equality lookup on the cookie value; UNIQUE is what makes it an index seek.
CREATE UNIQUE INDEX IF NOT EXISTS "auth_session_token_unique" ON "auth_session" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_session_user_id" ON "auth_session" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_account_user_id" ON "auth_account" USING btree ("user_id");
--> statement-breakpoint
-- (provider_id, account_id) is the stable provider identity — Google's `sub`
-- lands in `account_id`. UNIQUE because it is the "is this the same person"
-- match, and a duplicate would make that answer ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "auth_account_provider_account_unique"
  ON "auth_account" USING btree ("provider_id", "account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_verification_identifier" ON "auth_verification" USING btree ("identifier");
--> statement-breakpoint
-- NO `id` column: better-auth's rate-limit storage wrapper creates rows with
-- exactly { key, count, lastRequest } and locates them by `key`
-- (dist/api/rate-limiter/index.mjs). It never generates or reads an id, so a
-- NOT NULL id here would fail every insert.
CREATE TABLE IF NOT EXISTS "auth_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" bigint NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_rate_limit_key_unique" ON "auth_rate_limit" USING btree ("key");
