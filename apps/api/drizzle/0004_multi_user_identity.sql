-- Multi-user identity: users, revocable sessions, OAuth state, personal orgs.
--
-- WHY THIS MIGRATION EXISTS
--
-- 0001 created a tenancy model (organizations + members) whose `members.user_id`
-- is a bare `text` column with no referent. There was no `users` table, no
-- session store, and no way for a second person to exist. The only identity that
-- ever appeared in `members` was the literal 'bootstrap-admin' written by
-- seed.ts, and the only "session" was a signed cookie asserting that same
-- literal. This migration gives that membership something real to point at.
--
-- PURELY ADDITIVE. Every statement is CREATE TABLE / ADD COLUMN / CREATE INDEX
-- (or a guarded DO block). No existing row is modified or dropped, so applying
-- this against a live database cannot lose data and cannot fail on existing
-- content — the failure mode that made 0002 need its own precondition guard.

CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"google_sub" text,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
-- `google_sub` is the join key, NOT the email: a Workspace admin can reassign an
-- address, and an email-keyed upsert would then hand one person another's files.
-- Both indexes are UNIQUE because either column alone identifies an account.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_sub_unique" ON "users" USING btree ("google_sub");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp,
	"user_agent" text
);
--> statement-breakpoint
-- Only the SHA-256 of the cookie token is stored, so a database read cannot mint
-- a working session. UNIQUE because lookup is an equality match on this column.
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_user_id" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
-- Supports the expired-session sweep without a sequential scan.
CREATE INDEX IF NOT EXISTS "idx_sessions_expires_at" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_states" (
	"state" varchar(128) PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_to" text DEFAULT '/' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_states_expires_at" ON "oauth_states" USING btree ("expires_at");
--> statement-breakpoint
-- Marks the organization that belongs to exactly one user.
--
-- A personal org is created on first sign-in, and the creation is a
-- lookup-then-insert in application code. That is a race between two concurrent
-- requests from the same person (a double-click, or StrictMode's double effect
-- firing two probes). The partial UNIQUE index below makes the second insert
-- fail rather than silently creating a second empty workspace — the application
-- then re-reads and returns the winner.
--
-- NULL for shared organizations, which is why the index is partial: a plain
-- UNIQUE would permit only one NULL-less shared org and forbid the rest.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "personal_owner_user_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_personal_owner_unique"
  ON "organizations" USING btree ("personal_owner_user_id")
  WHERE "personal_owner_user_id" IS NOT NULL;
--> statement-breakpoint
-- The dashboard's primary read path is "every organization this user belongs
-- to", which is a members lookup by user_id. 0001 indexed organization_id only,
-- so that query scanned the table.
CREATE INDEX IF NOT EXISTS "idx_members_user_id" ON "members" USING btree ("user_id");
--> statement-breakpoint
-- Attribute a stored file to the person who uploaded it.
--
-- `files.uploader_id` is an existing bigint column that every write path
-- hardcoded to 0 — it was reserved for Telegram's numeric user ids and never
-- used for dashboard uploads. Multi-user file management needs "who uploaded
-- this", so the real id goes here. TEXT, not a foreign key: the same column
-- carries Telegram's numeric sender id from the bot path, which is not a
-- `users.id`. It is an attribution field, deliberately not a constraint.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "uploader_user_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_files_uploader_user_id" ON "files" USING btree ("uploader_user_id");
