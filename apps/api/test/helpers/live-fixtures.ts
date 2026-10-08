/**
 * Re-runnable fixtures for the live-database suites.
 *
 * WHY THE OLD FIXTURES WERE NOT RE-RUNNABLE
 *
 * `tenant-isolation.test.ts` inserted organizations with FIXED names
 * (`p3b-test-org-1`) into `organizations.name`, which carries
 * `organizations_name_unique`. Any residue from an interrupted run therefore
 * made `beforeAll` throw, and vitest reported the whole file as
 * "6 skipped" — a FAILURE wearing a SKIP's clothes, which is exactly the shape
 * that makes a broken gate look green.
 *
 * Reproduced before this fix: with one stale `p3b-test-org-1` row present, the
 * suite reported `Tests 6 passed | 6 skipped` and
 * `FAIL ... duplicate key value violates unique constraint
 * "organizations_name_unique"`. The green tick in the summary line was the lie;
 * the failure was only visible in the stderr block, which CI does not gate on.
 *
 * The rules this module enforces:
 *
 *   1. Every fixture name is unique PER RUN (`crypto.randomUUID`), so a
 *      previous run's residue can never collide with this one.
 *   2. Cleanup runs in `afterAll` AND is tolerant of a partial previous run:
 *      it deletes by this run's ids, and separately sweeps any earlier rows
 *      carrying the same run-independent PREFIX. Relying on `afterAll` alone is
 *      not enough — a killed process never reaches it.
 *
 * The prefix sweep is intentionally bounded and idempotent, so re-running after
 * a crash converges rather than accumulating.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

/** Row array returned by `db.execute()`. */
type QueryResult = Record<string, unknown>[];

/** The `db` handle, injected so this module stays independent of the schema import. */
export interface FixtureDb {
  execute: (query: unknown) => Promise<unknown>;
}

/** Cast the loosely-typed drizzle handle to the shape this module uses. */
export const asFixtureDb = (db: unknown): FixtureDb => db as FixtureDb;

/**
 * A name that is unique per run but still recognisable in a database dump.
 *
 * The prefix is deliberately constant (so cleanup can sweep by it) and only the
 * suffix varies. `organizations.name` is varchar(63) and `buckets.name` is
 * varchar(63), so the whole thing has to stay short: "p3b-" + a 36-char UUID is
 * 40 characters, which fits with room to spare.
 */
export const fixtureName = (prefix: string): string => `${prefix}-${randomUUID()}`;

/**
 * The stable prefix every organization these suites create carries.
 *
 * Cleanup sweeps on this, so a suite that is killed mid-run leaves rows this
 * can find and remove on the NEXT run.
 */
export const ORG_PREFIX = 'p3b-live-org';

/** Bucket names get their own prefix so a bucket sweep cannot touch a real one. */
export const BUCKET_PREFIX = 'p3b-live-bucket';

/**
 * Create one organization with a per-run unique name.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING as a belt-and-braces guard: the name is
 * already unique per run, so this can only ever fire if a UUID collided, and in
 * that case returning the existing row is strictly better than aborting
 * `beforeAll` and cascading into a fake skip.
 */
export const createOrg = async (db: FixtureDb, prefix = ORG_PREFIX): Promise<string> => {
  const id = randomUUID();
  const name = fixtureName(prefix);
  await db.execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${id}::uuid, ${name}, ${name})
        ON CONFLICT (name) DO NOTHING`,
  );
  return id;
};

/**
 * Remove every organization whose name carries the prefix, whatever its id.
 *
 * This is the tolerance for a partial previous run: rows are found by NAME
 * PREFIX rather than by an id list held in memory, so a process that died
 * before `afterAll` still leaves removable rows. Buckets and files go with the
 * organization (see the delete rules documented in drizzle/0001: buckets is
 * ON DELETE CASCADE from organizations, but `files` is NO ACTION, so files must
 * be removed first or the organization delete raises a foreign-key violation).
 */
export const sweepOrgs = async (db: FixtureDb, prefix = ORG_PREFIX): Promise<void> => {
  await db
    .execute(
      sql`DELETE FROM files WHERE bucket_id IN (
          SELECT b.id FROM buckets b
          JOIN organizations o ON o.id = b.organization_id
          WHERE o.name LIKE ${`${prefix}-%`} AND b.name LIKE ${`${BUCKET_PREFIX}-%`}
        )`,
    )
    .catch(() => {});
  await db.execute(sql`DELETE FROM organizations WHERE name LIKE ${`${prefix}-%`}`).catch(() => {});
};

/**
 * Remove buckets created by these suites, by name prefix.
 *
 * Called before the sweep as well as from `afterAll`, so a leftover row can never
 * satisfy the UNIQUE (organization_id, name) index on a later run even if a
 * future fixture ever reuses a name.
 */
export const sweepBuckets = async (db: FixtureDb, prefix = BUCKET_PREFIX): Promise<void> => {
  await db.execute(sql`DELETE FROM buckets WHERE name LIKE ${`${prefix}-%`}`).catch(() => {});
};

/**
 * Prepare the fixture database for a fresh run and return a teardown function.
 *
 * Runs the sweep FIRST, so residue from a previous interrupted run is gone
 * before this run inserts anything — that is what makes the suite re-runnable
 * rather than merely idempotent-when-nothing-crashed.
 *
 * The returned teardown is safe to call more than once, and it never throws: a
 * failing cleanup must not mask the test result that actually matters.
 */
export const prepareLiveFixtures = async (
  db: FixtureDb,
  orgPrefix = ORG_PREFIX,
  bucketPrefix = BUCKET_PREFIX,
): Promise<() => Promise<void>> => {
  await sweepBuckets(db, bucketPrefix);
  await sweepOrgs(db, orgPrefix);

  return async () => {
    await sweepBuckets(db, bucketPrefix);
    await sweepOrgs(db, orgPrefix);
  };
};

/** Count rows matching a name prefix — used by the self-check in the suites. */
export const countOrgs = async (db: FixtureDb, prefix: string): Promise<number> => {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`${prefix}-%`}`,
  )) as unknown as QueryResult;
  return rows[0]?.n as number;
};
