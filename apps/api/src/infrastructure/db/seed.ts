import { eq } from 'drizzle-orm';
import { config } from '../../env';
import logger from '../observability/logger';
import { db } from '../persistence/drizzle/index';
import { members, organizations, s3Credentials } from '../persistence/drizzle/schema';

/**
 * P3 seeder — creates the bootstrap organization that 0002 backfills against.
 *
 * WHY THIS RUNS BEFORE MIGRATIONS FINISH, NOT AFTER
 *
 * `0002_bucket_organization.sql` adds `buckets.organization_id`, backfills it from
 * the organization with slug 'default', then RAISES if any bucket is still
 * unattached. So the bootstrap org must exist BEFORE `migrate()` runs, or that
 * migration fails on a fresh database.
 *
 * NOTE: nothing imports `runSeed` outside this file. It is invoked by
 * `pnpm db:seed`, and `migrate.ts` documents that it too is currently orphaned
 * (deploy.sh ships migrate.js but never runs it — see P5).
 *
 * That ordering is the whole reason this is not an ordinary post-migrate seed:
 * seeding afterwards would leave `migrate()` unable to complete.
 *
 * IDEMPOTENT — safe to run on every deploy. Each step is a lookup-then-insert.
 */

/**
 * Fixed slug the migration's backfill looks for. Changing it after buckets exist
 * would orphan them, so it is deliberately a constant rather than config.
 */
const BOOTSTRAP_SLUG = 'default';

const bootstrapIdentity = (): { name: string; userId: string } => ({
  name: 'TeleUploader',
  // better-auth user ids are text. The admin is seeded here and claimed by P3's
  // auth work. Read from config, the SAME value organization-resolver.ts uses,
  // so the seeder and the request path cannot disagree about who the admin is —
  // a second `process.env` read here is exactly the kind of declaration that
  // gets trusted downstream instead of re-checked.
  userId: config.bootstrapAdminId,
});

export const runSeed = async (): Promise<void> => {
  const identity = bootstrapIdentity();

  // 1. Bootstrap organization — 0002 backfills existing buckets to this row.
  const existingOrg = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, BOOTSTRAP_SLUG))
    .limit(1);
  const org =
    existingOrg[0] ??
    (
      await db
        .insert(organizations)
        .values({ name: identity.name, slug: BOOTSTRAP_SLUG })
        .returning()
    )[0];

  if (!org) {
    logger.error('Seed failed: could not create or read the bootstrap organization');
    process.exitCode = 1;
    return;
  }
  logger.info(
    existingOrg[0] ? 'Seed: bootstrap organization exists' : 'Seed: created bootstrap organization',
    { slug: BOOTSTRAP_SLUG, id: org.id },
  );

  // 2. Owner membership for the bootstrap admin.
  const existingMember = await db
    .select()
    .from(members)
    .where(eq(members.userId, identity.userId))
    .limit(1);
  if (existingMember[0]) {
    logger.info('Seed: bootstrap admin membership exists');
  } else {
    await db
      .insert(members)
      .values({ organizationId: org.id, userId: identity.userId, role: 'owner' });
    logger.info('Seed: created bootstrap owner membership', { userId: identity.userId });
  }

  // 3. Carry the existing S3 key over, so current aws-cli / rclone / Docker
  //    clients keep working with no config change. The secret is unchanged, so the
  //    SigV4 wire protocol is untouched — only the lookup moves into the database.
  if (config.s3AccessKey && config.s3SecretKey) {
    const existingCredential = await db
      .select()
      .from(s3Credentials)
      .where(eq(s3Credentials.accessKey, config.s3AccessKey))
      .limit(1);
    if (existingCredential[0]) {
      logger.info('Seed: S3 credential already present');
    } else {
      await db.insert(s3Credentials).values({
        organizationId: org.id,
        accessKey: config.s3AccessKey,
        secretKey: config.s3SecretKey,
        label: 'seeded from environment',
      });
      logger.info('Seed: adopted the existing S3 credential', { accessKey: config.s3AccessKey });
    }
  } else {
    logger.warn(
      'Seed: S3_ACCESS_KEY/S3_SECRET_KEY not both set — no credential seeded. ' +
        'The S3 surface has NO environment fallback: it authenticates against s3_credentials only, ' +
        'so until a credential is seeded no S3 client can authenticate.',
    );
  }
};

// Allow `pnpm db:seed` to run this directly.
const invokedDirectly = process.argv[1] !== undefined && /seed\.[tj]s$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    await runSeed();
  } catch (error: unknown) {
    logger.error('Seed failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
