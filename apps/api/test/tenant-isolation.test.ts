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
 * Postgres. They are skipped (not failed) when no usable DATABASE_URL is
 * configured, so the suite stays runnable offline.
 *
 *   DATABASE_URL=postgresql://kana:kanaprobe@127.0.0.1:5432/probe_kana \
 *   BOT_TOKENS=1:test STORAGE_CHANNEL_ID=-1001234 BASE_URL=http://127.0.0.1:4311 \
 *   PORT=4311 npx vitest run --config vitest.config.ts test/tenant-isolation.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.BOT_TOKENS ||= '1:test';
process.env.STORAGE_CHANNEL_ID ||= '-1001234';
process.env.BASE_URL ||= 'http://127.0.0.1:4311';
process.env.PORT ||= '4311';

const { db } = await import('../src/infrastructure/persistence/drizzle/index');
const { DrizzleBucketRepository } = await import(
  '../src/infrastructure/persistence/repositories/bucket-repository'
);

/** The two organizations each test provisions, cleaned up afterwards. */
const orgIds: string[] = [];
/** Bucket ids created here, cleaned up afterwards. */
const bucketIds: string[] = [];

const repo = new DrizzleBucketRepository();

/** True only when DATABASE_URL points somewhere we can actually reach. */
const databaseReachable = async (): Promise<boolean> => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
};

let live = false;

beforeAll(async () => {
  live = await databaseReachable();
  if (!live) return;
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    orgIds.push(id);
    await db.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${id}::uuid, ${`p3b-test-org-${i}`}, ${`p3b-test-org-${i}`})`,
    );
  }
});

afterAll(async () => {
  if (!live) return;
  for (const id of bucketIds) {
    await db.execute(sql`DELETE FROM buckets WHERE id = ${id}::uuid`).catch(() => {});
  }
  for (const id of orgIds) {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${id}::uuid`).catch(() => {});
  }
});

/** Create a bucket through the real repository and remember it for cleanup. */
const createBucket = async (name: string, organizationId: string) => {
  const bucket = await repo.create(name, organizationId);
  bucketIds.push(bucket.id);
  return bucket;
};

describe('tenant isolation (real repository, real database)', () => {
  it('create() stamps the organization onto the row', async () => {
    if (!live) return;
    const orgA = orgIds[0]!;
    const name = `p3b-create-${randomUUID().slice(0, 8)}`;

    // Before the fix this threw: INSERT INTO buckets (name) omitted a NOT NULL
    // column, so both creation paths were dead at runtime.
    const bucket = await createBucket(name, orgA);

    expect(bucket.organizationId).toBe(orgA);
    const rows = (await db.execute(
      sql`SELECT organization_id FROM buckets WHERE id = ${bucket.id}::uuid`,
    )) as unknown as Record<string, unknown>[];
    expect(rows[0]?.organization_id).toBe(orgA);
  });

  it('delete() returns true on a real delete', async () => {
    if (!live) return;
    const orgA = orgIds[0]!;
    const name = `p3b-delete-${randomUUID().slice(0, 8)}`;
    await createBucket(name, orgA);

    // Before the fix this returned false: a DELETE without RETURNING resolves to
    // an empty array in postgres-js, so `result.length > 0` was never true.
    await expect(repo.delete(name, orgA)).resolves.toBe(true);

    const remaining = (await db.execute(
      sql`SELECT id FROM buckets WHERE name = ${name} AND organization_id = ${orgA}::uuid`,
    )) as unknown as Record<string, unknown>[];
    expect(remaining).toHaveLength(0);
  });

  it('the same name in two organizations resolves to two different buckets', async () => {
    if (!live) return;
    const [orgA, orgB] = orgIds as [string, string];
    const name = `shared-${randomUUID().slice(0, 8)}`;

    const a = await createBucket(name, orgA);
    const b = await createBucket(name, orgB);

    const foundA = await repo.findByName(name, orgA);
    const foundB = await repo.findByName(name, orgB);

    expect(foundA?.id).toBe(a.id);
    expect(foundB?.id).toBe(b.id);
    expect(foundA?.id).not.toBe(foundB?.id);
  });

  it('a bucket in another organization is invisible, not merely forbidden', async () => {
    if (!live) return;
    const [orgA, orgB] = orgIds as [string, string];
    const name = `hidden-${randomUUID().slice(0, 8)}`;
    await createBucket(name, orgA);

    // The tenant invariant: a cross-tenant miss must be indistinguishable from
    // a nonexistent bucket, so the lookup returns null — never org A's row.
    expect(await repo.findByName(name, orgB)).toBeNull();
    expect(await repo.exists(name, orgB)).toBe(false);
  });

  it("list() returns only the calling organization's buckets", async () => {
    if (!live) return;
    const [orgA, orgB] = orgIds as [string, string];
    const marker = `listed-${randomUUID().slice(0, 8)}`;
    await createBucket(marker, orgA);

    const listA = await repo.list(orgA);
    const listB = await repo.list(orgB);

    expect(listA.map((b) => b.name)).toContain(marker);
    expect(listB.map((b) => b.name)).not.toContain(marker);
  });

  it("delete() cascades within the caller's tenant only", async () => {
    if (!live) return;
    const [orgA, orgB] = orgIds as [string, string];
    const name = `cascade-${randomUUID().slice(0, 8)}`;

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
});
