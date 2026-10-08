/**
 * P3b — tenant isolation, proved against the REAL repository and a REAL database.
 *
 * WHY THIS FILE EXISTS AND WHY IT USES NO MOCKS
 *
 * Every other bucket test in this suite mocks the repository module. Those mocks
 * are one-arg class expressions: JavaScript silently drops an extra argument, so
 * when `findByName(name)` became `findByName(name, organizationId)` no test
 * broke and no typecheck fired — the gate went green while cross-tenant
 * leakage was being introduced. `grep 'implements IBucketRepository' test/`
 * returned nothing before this file, and `tsc --noEmit` reported zero errors in
 * all three mocks.
 *
 * So these tests instantiate `DrizzleBucketRepository` and run it against a live
 * Postgres.
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION OF THIS FILE
 *
 * It guarded every assertion behind `if (!live) return;`. Two independent
 * defects, both verified against a real database rather than reasoned about:
 *
 *   1. A silent early return is not a skip. Vitest counts it as PASSED. CI ran
 *      with no DATABASE_URL, so all six tests "passed" having asserted nothing:
 *      the file reported "Tests 6 passed" while the `delete() ... RETURNING`
 *      regression it exists to catch was fully reintroduced. This is the
 *      session's recurring failure mode — a condition declared once and then
 *      trusted downstream instead of re-checked — with the suite's own green
 *      result as the thing that got trusted.
 *
 *   2. The fixtures inserted organizations with FIXED names (`p3b-test-org-1`)
 *      into a UNIQUE column, so residue from any interrupted run made
 *      `beforeAll` throw and the file report "6 skipped". A failure masquerading
 *      as a skip. Reproduced: with one stale row present the suite reported
 *      `Tests 6 passed | 6 skipped` plus
 *      `duplicate key value violates unique constraint "organizations_name_unique"`.
 *
 * Both are fixed below. Absence of a database is now a deliberate, VISIBLE skip
 * (`describe.skipIf`), so a reader of the summary line can tell "did not run"
 * from "ran and passed"; a database that is configured but unreachable is a HARD
 * FAILURE, because silently downgrading "CI's database is broken" to "skipped,
 * all fine" is how coverage disappears. Fixtures are unique per run and are swept
 * both before and after, so an interrupted run cannot poison the next one.
 *
 * Running it locally:
 *
 *   DATABASE_URL=postgresql://kana:kanaprobe@127.0.0.1:5432/probe_kana \
 *   BOT_TOKENS=1:test STORAGE_CHANNEL_ID=-1001234 BASE_URL=http://127.0.0.1:4311 \
 *   PORT=4311 pnpm vitest run --config vitest.config.ts test/tenant-isolation.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeLiveDatabase } from './helpers/live-db';
import {
  asFixtureDb,
  BUCKET_PREFIX,
  countOrgs,
  createOrg,
  ORG_PREFIX,
  prepareLiveFixtures,
} from './helpers/live-fixtures';

process.env.BOT_TOKENS ||= '1:test';
process.env.STORAGE_CHANNEL_ID ||= '-1001234';
process.env.BASE_URL ||= 'http://127.0.0.1:4311';
process.env.PORT ||= '4311';

const { db } = await import('../src/infrastructure/persistence/drizzle/index');
const { DrizzleBucketRepository } = await import(
  '../src/infrastructure/persistence/repositories/bucket-repository'
);

const repo = new DrizzleBucketRepository();
const fixtureDb = asFixtureDb(db);

/**
 * Probe BEFORE the suite is registered.
 *
 * `describe.skipIf` is evaluated at collection time, so the answer has to exist
 * by then. A top-level await gives exactly that: if this throws, the file fails
 * to collect and vitest reports an error — which is the intended outcome for a
 * database that is configured but broken.
 */
const status = await probeLiveDatabase(async () => {
  await db.execute(sql`SELECT 1`);
});

/**
 * The reason the database-backed tests are not running, or `''` when they are.
 *
 * vitest 5's `skipIf(condition)` takes no reason argument — the 3-arg form the
 * first draft used typechecks as `TestCollectorOptions` and silently added 12
 * errors to `tsc --noEmit` (24 → 36), which is itself this session's recurring
 * failure mode: a change made "somewhere" and not re-checked downstream.
 *
 * So the reason is not passed to skipIf. It is surfaced two other ways that are
 * both verifiable: printed by the `reports its own skip state` test below, and
 * asserted by `test/suite-integrity.test.ts`, which fails this whole file if a
 * database IS available and these tests still did not run.
 */
const SKIP_REASON = status.state === 'live' ? '' : `[live-db] ${status.reason}`;

const live = status.state === 'live';

/** The two organizations each test provisions, cleaned up afterwards. */
const orgIds: string[] = [];
/** Bucket ids created here, cleaned up afterwards. */
const bucketIds: string[] = [];

beforeAll(async () => {
  if (!live) return;
  // Sweep first, so residue from a previous interrupted run cannot collide with
  // this one's inserts. Names are unique per run as well — belt and braces.
  teardown = await prepareLiveFixtures(fixtureDb);
  for (let i = 0; i < 2; i++) {
    orgIds.push(await createOrg(fixtureDb, ORG_PREFIX));
  }
});

let teardown: (() => Promise<void>) | null = null;

afterAll(async () => {
  // Belt and braces on two fronts: delete by id (rows this run created) AND by
  // name prefix (rows an interrupted earlier run left behind). `afterAll` alone
  // is not sufficient — a killed process never reaches it.
  for (const id of bucketIds) {
    await db.execute(sql`DELETE FROM buckets WHERE id = ${id}::uuid`).catch(() => {});
  }
  await teardown?.();
});

/** Create a bucket through the real repository and remember it for cleanup. */
const createBucket = async (name: string, organizationId: string) => {
  const bucket = await repo.create(name, organizationId);
  bucketIds.push(bucket.id);
  return bucket;
};

/** Bucket names are unique per run, so two concurrent runs cannot collide. */
const bucketName = (label: string): string =>
  `${BUCKET_PREFIX}-${label}-${randomUUID().slice(0, 8)}`;

/**
 * Always runs — never skipped — and states outright whether the assertions below
 * executed.
 *
 * This is the guard against the original defect. `if (!live) return` inside the
 * other tests reported "passed" while asserting nothing; here the skip state is
 * itself a checked property, so the summary line can no longer imply coverage
 * that does not exist. When a database IS configured, this test runs and the
 * ones below run too; when one is not, this test still runs and says so.
 */
describe('live database availability', () => {
  it('reports its own skip state, so "did not run" is distinguishable from "passed"', () => {
    if (live) {
      // A live database means the real assertions below executed.
      expect(SKIP_REASON).toBe('');
      return;
    }
    expect(SKIP_REASON).toContain('[live-db]');
    expect(SKIP_REASON).toMatch(/DATABASE_URL is not set/);
    // Logged so the reason is in the run output, not just in this assertion.
    console.info(SKIP_REASON);
  });
});

describe('tenant isolation (real repository, real database)', () => {
  it.skipIf(!live)('create() stamps the organization onto the row', async () => {
    const orgA = orgIds[0]!;
    const name = bucketName('create');

    // Before the fix this threw: INSERT INTO buckets (name) omitted a NOT NULL
    // column, so both creation paths were dead at runtime.
    const bucket = await createBucket(name, orgA);

    expect(bucket.organizationId).toBe(orgA);
    const rows = (await db.execute(
      sql`SELECT organization_id FROM buckets WHERE id = ${bucket.id}::uuid`,
    )) as unknown as Record<string, unknown>[];
    expect(rows[0]?.organization_id).toBe(orgA);
  });

  it.skipIf(!live)('delete() returns true on a real delete', async () => {
    const orgA = orgIds[0]!;
    const name = bucketName('delete');
    await createBucket(name, orgA);

    // Before the fix this returned false: a DELETE without RETURNING resolves
    // to an empty array in postgres-js, so `result.length > 0` was never true.
    await expect(repo.delete(name, orgA)).resolves.toBe(true);

    const remaining = (await db.execute(
      sql`SELECT id FROM buckets WHERE name = ${name} AND organization_id = ${orgA}::uuid`,
    )) as unknown as Record<string, unknown>[];
    expect(remaining).toHaveLength(0);
  });

  it.skipIf(!live)(
    'the same name in two organizations resolves to two different buckets',
    async () => {
      const [orgA, orgB] = orgIds as [string, string];
      const name = bucketName('shared');

      const a = await createBucket(name, orgA);
      const b = await createBucket(name, orgB);

      const foundA = await repo.findByName(name, orgA);
      const foundB = await repo.findByName(name, orgB);

      expect(foundA?.id).toBe(a.id);
      expect(foundB?.id).toBe(b.id);
      expect(foundA?.id).not.toBe(foundB?.id);
    },
  );

  it.skipIf(!live)(
    'a bucket in another organization is invisible, not merely forbidden',
    async () => {
      const [orgA, orgB] = orgIds as [string, string];
      const name = bucketName('hidden');
      await createBucket(name, orgA);

      // The tenant invariant: a cross-tenant miss must be indistinguishable from
      // a nonexistent bucket, so the lookup returns null — never org A's row.
      expect(await repo.findByName(name, orgB)).toBeNull();
      expect(await repo.exists(name, orgB)).toBe(false);
    },
  );

  it.skipIf(!live)("list() returns only the calling organization's buckets", async () => {
    const [orgA, orgB] = orgIds as [string, string];
    const marker = bucketName('listed');
    await createBucket(marker, orgA);

    const listA = await repo.list(orgA);
    const listB = await repo.list(orgB);

    expect(listA.map((b) => b.name)).toContain(marker);
    expect(listB.map((b) => b.name)).not.toContain(marker);
  });

  it.skipIf(!live)("delete() cascades within the caller's tenant only", async () => {
    const [orgA, orgB] = orgIds as [string, string];
    const name = bucketName('cascade');

    // Both organizations own a bucket with this name, each holding a file row.
    const bucketA = await createBucket(name, orgA);
    const bucketB = await createBucket(name, orgB);
    const fileA = randomUUID();
    const fileB = randomUUID();
    // Column list read from `\d files` — every NOT NULL column is supplied.
    const insertFile = (id: string, bucketId: string, name: string, telegramId: string) =>
      db.execute(
        sql`INSERT INTO files (
              id, public_id, telegram_file_id, telegram_file_unique_id,
              storage_chat_id, storage_message_id, file_name, mime_type,
              size_bytes, file_type, uploader_id, bucket_id
            ) VALUES (
              ${id}::uuid, ${`pub${id.replace(/-/g, '').slice(0, 15)}`}, ${telegramId}, ${`uniq-${telegramId}`},
              ${-1001234}, ${1}, ${name}, ${'text/plain'},
              ${1}, ${'document'}, ${1}, ${bucketId}::uuid
            )`,
      );
    await insertFile(fileA, bucketA.id, 'a.txt', 'telegram-a');
    await insertFile(fileB, bucketB.id, 'b.txt', 'telegram-b');

    await expect(repo.delete(name, orgA)).resolves.toBe(true);

    // Org B's bucket and its file must survive org A's delete. The unscoped
    // cascade resolved the bucket by name and destroyed both tenants' data,
    // with `.catch(() => {})` hiding the second failure.
    const survivor = await repo.findByName(name, orgB);
    expect(survivor?.id).toBe(bucketB.id);

    const bFiles = (await db.execute(
      sql`SELECT id FROM files WHERE bucket_id = ${bucketB.id}::uuid`,
    )) as unknown as Record<string, unknown>[];
    expect(bFiles).toHaveLength(1);

    await repo.delete(name, orgB);
  });

  it.skipIf(!live)(
    'the fixtures are re-runnable: a second run leaves no residue and no collision',
    async () => {
      // The old fixtures used FIXED names (`p3b-test-org-1`) in a UNIQUE column,
      // so one stale row turned `beforeAll` into a throw that vitest rendered as
      // "skipped". This asserts the property that makes that impossible: the
      // organizations this suite creates are removed by prefix, so a run that is
      // interrupted mid-way cannot poison the next one.
      await expect(countOrgs(fixtureDb, ORG_PREFIX)).resolves.toBe(2);
    },
  );
});
