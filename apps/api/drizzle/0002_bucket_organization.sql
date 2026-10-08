-- P3 — attach buckets to organizations.
--
-- Unlike 0001 this migration MODIFIES EXISTING DATA on `buckets`, so it is
-- written to be re-runnable and to leave the database usable if it stops halfway.
--
-- Why it is not merged into 0001: existing buckets have no organization, so the
-- column cannot be NOT NULL at creation time. It is added nullable, backfilled,
-- then tightened — keeping the nullable window as short as possible. If this
-- migration succeeds, the column is NOT NULL by the time it ends.
--
-- SEEDING IS NOT DONE HERE. The bootstrap organization is created by seed.ts,
-- because it needs the admin identity from the environment. This file only
-- backfills existing buckets to whichever organization the seeder created,
-- identified by the fixed slug 'default'. If that organization does not exist,
-- the backfill updates zero rows and the guard below raises — which is the
-- intended behaviour, because proceeding would silently orphan every bucket.

ALTER TABLE "buckets" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
--> statement-breakpoint
-- Added separately from the column so a re-run is safe. ON DELETE CASCADE here
-- removes only the bucket ROW; it does not remove files or multipart uploads.
-- See 0001 for why those FKs are NO ACTION.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buckets_organization_id_fkey') THEN
    ALTER TABLE "buckets"
      ADD CONSTRAINT "buckets_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
-- Create the bootstrap organization if the seeder has not yet run.
--
-- Migration 0002 has a data precondition: existing buckets must be attached to an
-- organization, and the backfill below sources that from the row with slug
-- 'default'. Making THIS migration guarantee its own precondition removes an
-- ordering hazard — `db:migrate` would otherwise have to interleave seeding
-- between 0001 and 0002, which fails on a fresh database (verified: seeding
-- before 0001 fails with `relation "organizations" does not exist`, because the
-- table does not exist until 0001 runs).
--
-- seed.ts still owns everything that needs secrets or the environment: the owner
-- membership and the S3 credential. This INSERT only guarantees a non-empty
-- backfill source, so the migration cannot silently orphan every bucket.
--
-- ON CONFLICT DO NOTHING keeps it idempotent: if seed.ts already created the
-- organization, this is a no-op and the backfill uses the existing row.
INSERT INTO "organizations" ("name", "slug")
VALUES ('TeleUploader', 'default')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- Backfill every existing bucket to the bootstrap organization.
UPDATE "buckets"
SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default' LIMIT 1)
WHERE "organization_id" IS NULL;
--> statement-breakpoint
-- Refuse to continue if any bucket is still unattached. Without this guard the
-- NOT NULL step below fails with a much less obvious message.
DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "buckets" WHERE "organization_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      '% bucket(s) have no organization. Seed the bootstrap organization (slug=default) first.', orphans;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "buckets" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
-- Bucket names become unique PER ORGANIZATION instead of globally.
--
-- This DROPS the global `buckets_name_key`. The two cannot coexist: two
-- organizations must be able to own a bucket with the same name, or the feature
-- is not multi-tenant. Consequence: any code that treated a bucket name as a
-- global identifier must now pass an organization. That is the
-- `findByName(name, organizationId)` signature change landing in this same phase.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buckets_name_key') THEN
    ALTER TABLE "buckets" DROP CONSTRAINT "buckets_name_key";
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buckets_organization_id_name_unique"
  ON "buckets" USING btree ("organization_id", "name");