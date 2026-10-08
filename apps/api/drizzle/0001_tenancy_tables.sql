-- P3 — tenancy tables.
--
-- Creates the organization/member model plus the S3 credential table that maps an
-- S3 access key to an organization. Safe to run against production: every
-- statement is additive (CREATE TABLE), so no existing row is touched.
--
-- IMPORTANT — why org deletion does NOT cascade to files
--
-- The obvious design is `buckets.organization_id ... ON DELETE CASCADE` and
-- letting Postgres remove everything below it. That does not work here, and the
-- failure is silent until someone deletes an organization in production.
--
-- The delete rules in this database (read from pg_constraint.confdeltype, where
-- 'a' = NO ACTION and 'c' = CASCADE) are:
--
--   organizations    -> (parent)
--   buckets          -> organizations    c   (set in 0002)
--   files            -> buckets          a   NO ACTION   <-- the blocker
--   multipart_uploads-> buckets          a   NO ACTION   <-- the blocker
--   multipart_parts  -> multipart_uploads c
--   file_parts       -> files            c
--
-- So deleting an organization cascades to the `buckets` rows, and then Postgres
-- REFUSES the delete because files and multipart_uploads still reference those
-- buckets. The org is not deleted; the transaction rolls back with a
-- foreign-key violation. Nothing is corrupted, but the operation is impossible.
--
-- The hand-rolled cascade in
-- infrastructure/persistence/repositories/bucket-repository.ts (multipart_parts ->
-- multipart_uploads -> files -> bucket, in that order) is therefore load-bearing,
-- NOT vestigial. It is kept, and organization deletion must go through it rather
-- than relying on the database.
--
-- Converting files.bucket_id and multipart_uploads.bucket_id to ON DELETE CASCADE
-- is deferred to a later migration on purpose: it means dropping and recreating a
-- foreign key on the largest table, and doing that inside the same atomic cutover
-- that introduces tenancy would put the highest-consequence change of the project
-- in the least-observed step.

CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(63) NOT NULL,
	"slug" varchar(63) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "organizations_name_unique" UNIQUE("name"),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "members_org_user_unique" UNIQUE("organization_id", "user_id")
);
--> statement-breakpoint
-- One row per S3 access key, resolving to the organization that owns it.
--
-- `secret_key` holds the same secret the SigV4 verifier already compares against:
-- the wire protocol is unchanged, only the lookup is. A row seeded from the
-- existing S3_ACCESS_KEY/S3_SECRET_KEY env pair keeps every current aws-cli /
-- rclone / Docker-registry client working with no config change.
CREATE TABLE IF NOT EXISTS "s3_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"access_key" varchar(255) NOT NULL,
	"secret_key" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now(),
	"last_used_at" timestamp,
	CONSTRAINT "s3_credentials_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_members_organization_id" ON "members" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_s3_credentials_organization_id" ON "s3_credentials" USING btree ("organization_id");