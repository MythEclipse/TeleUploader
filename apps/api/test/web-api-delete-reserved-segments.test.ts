/**
 * Regression tests for TODO item 10 — `web-api-controller`'s DELETE catch-all.
 *
 * TWO INDEPENDENT DEFECTS LIVE IN THE SAME HANDLER, and both are pinned here
 * because the TODO required a test per branch BEFORE the fix, not after.
 *
 * DEFECT 1 — reserved-segment shadowing (data loss).
 *
 * `handleWebApiV1` tested `DELETE` on `{bucket}/{key+}` before the `/download`,
 * `/objects`, `/upload` and `/copy` branches, and the delete branch excluded
 * nothing. A file whose key BEGINS with a reserved segment — `download/…`,
 * `objects`, `upload`, `copy` — at a bucket root is therefore reachable by the
 * catch-all, so a stray DELETE soft-deletes a file the caller meant to
 * download. Reproduced against a real database before this fix:
 *
 *     DELETE /api/v1/buckets/probe/download/keepme.txt -> 200 {"success":true}
 *     DB afterwards: download/keepme.txt | t   <- deleted by a request meant to DOWNLOAD it
 *
 * DEFECT 2 — `{"success": true}` was unconditional.
 *
 * `softDelete()` already returns whether a row changed, and the handler threw
 * that answer away, so deleting a key that does not exist also answered 200.
 * Whole-key `%2F`-encoded deletes hit the same branch: the encoded slash never
 * becomes a path separator, `parts.slice(2)` yields one segment, and the key
 * that reaches the repository is not the key the caller named — yet the
 * response still claimed success.
 *
 * WHY A MOCK AND NOT A REAL DATABASE.
 *
 * The routing defect lives entirely in how `parts` is matched, so it is
 * observable through the controller with the repositories stubbed — and doing it
 * here means the test runs in the ordinary `test:unit` gate rather than only
 * under the quarantine. The repository contract these tests rely on is the real
 * one: `softDelete` resolves a boolean, and `findByBucketAndKey` resolves null
 * for an unknown key. A mock that answered `true` unconditionally would let
 * defect 2 pass while production deletes nothing, so `softDelete` below consults
 * a mutable store and reports honestly.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBucketRepository } from '../src/domain/ports/bucket-repository';

const MOCK_ORG = 'org-a';
const BUCKET = 'probe';
const BUCKET_ID = 'uuid-probe';

/**
 * The keys that exist, and whether each has been soft-deleted.
 *
 * A Map rather than a fixed array because defect 2 is about the RESPONSE
 * disagreeing with the STORE: the handler must report success only when this map
 * actually flipped a row.
 */
const store = new Map<string, boolean>();

/** Records what the handler tried to delete, so a shadowed route is visible. */
const deleteAttempts: { bucket: string; key: string }[] = [];

const MOCK_MEMBERSHIPS: Record<string, string> = {
  [process.env.BOOTSTRAP_ADMIN_ID || 'bootstrap-admin']: MOCK_ORG,
};

vi.mock('../src/infrastructure/persistence/repositories/bucket-repository', () => ({
  DrizzleBucketRepository: class implements IBucketRepository {
    list = () => Promise.resolve([]);
    findByName = (name: string, organizationId: string) =>
      Promise.resolve(
        name === BUCKET && organizationId === MOCK_ORG
          ? {
              id: BUCKET_ID,
              name: BUCKET,
              organizationId,
              createdAt: new Date('2026-01-01'),
              updatedAt: new Date('2026-01-01'),
            }
          : null,
      );
    create = (name: string, organizationId: string) =>
      Promise.resolve({
        id: 'new-uuid',
        name,
        organizationId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    delete = () => Promise.resolve(true);
    exists = (name: string, organizationId: string) =>
      Promise.resolve(name === BUCKET && organizationId === MOCK_ORG);
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/organization-repository', () => ({
  DrizzleOrganizationRepository: class {
    findOrganizationIdByUserId = (userId: string) =>
      Promise.resolve(MOCK_MEMBERSHIPS[userId] ?? null);
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/file-repository', () => ({
  DrizzleFileRepository: class {
    findByBucketAndKey = (_bucketId: string, s3Key: string) =>
      Promise.resolve(store.has(s3Key) && store.get(s3Key) === false ? { s3Key } : null);
    listByPrefix = () => Promise.resolve({ objects: [], prefixes: [] });
    /**
     * The REAL contract: a boolean saying whether a row actually changed.
     * Returning `true` unconditionally here is exactly the bug shape that let
     * defect 2 ship, so this mock reports from the store instead.
     */
    softDelete = (_bucketId: string, s3Key: string) => {
      deleteAttempts.push({ bucket: BUCKET, key: s3Key });
      if (!store.has(s3Key) || store.get(s3Key) === true) return Promise.resolve(false);
      store.set(s3Key, true);
      return Promise.resolve(true);
    };
    softDeleteBatch = (_bucketId: string, keys: string[]) =>
      Promise.resolve(keys.filter((k) => store.get(k) === false).length);
    countByBucket = () => Promise.resolve(0);
    findByBucket = () => Promise.resolve([]);
  },
}));

vi.mock('../src/infrastructure/telegram/bot-pool', () => ({
  botPool: {
    forwardToStorage: () =>
      Promise.resolve({
        telegramFileId: 'mock-tg-id',
        telegramFileUniqueId: 'mock-tg-unique',
        storageMessageId: 12345,
      }),
    getFileInfo: () =>
      Promise.resolve({
        file_size: 100,
        mime_type: 'text/plain',
        file_path: 'documents/file.txt',
        bot_token: '123456:ABC-DEF',
      }),
  },
}));

/** Every path segment that the controller routes to a handler of its own. */
const RESERVED_ROOT_SEGMENTS = ['objects', 'upload', 'copy'] as const;

describe('Web API v1 DELETE — reserved-segment shadowing (TODO item 10)', () => {
  let handleWebApiV1: typeof import('../src/presentation/http/controllers/web-api-controller').handleWebApiV1;

  beforeAll(async () => {
    process.env.BOT_TOKEN = '123456:ABC-DEF';
    process.env.STORAGE_CHANNEL_ID = '-1001234567890';
    process.env.BASE_URL = 'http://localhost:4000';
    process.env.DATABASE_URL = 'postgresql://asephs:***@127.0.0.1:5432/test';
    const webApi = await import('../src/presentation/http/controllers/web-api-controller');
    handleWebApiV1 = webApi.handleWebApiV1;
  });

  beforeEach(() => {
    store.clear();
    deleteAttempts.length = 0;
  });

  it('must NOT delete a file whose key starts with the reserved `download/` segment', async () => {
    store.set('download/keepme.txt', false);

    const res = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/download/keepme.txt`, {
        method: 'DELETE',
      }),
    );

    // The file must survive: a request naming the download branch must not be
    // serviced by the delete catch-all.
    expect(store.get('download/keepme.txt')).toBe(false);
    expect(deleteAttempts).toHaveLength(0);
    expect(res.status).toBe(404);
  });

  it.each(RESERVED_ROOT_SEGMENTS)(
    'must NOT delete a root-level object literally named `%s`',
    async (segment) => {
      store.set(segment, false);

      const res = await handleWebApiV1(
        new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/${segment}`, {
          method: 'DELETE',
        }),
      );

      expect(store.get(segment)).toBe(false);
      expect(deleteAttempts).toHaveLength(0);
      expect(res.status).toBe(404);
    },
  );

  it('still deletes an ordinary object — the fix must not disable the catch-all', async () => {
    store.set('reports/2026/q1.pdf', false);

    const res = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/reports/2026/q1.pdf`, {
        method: 'DELETE',
      }),
    );

    expect(store.get('reports/2026/q1.pdf')).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it('deletes a key that merely CONTAINS a reserved word, not as a root segment', async () => {
    store.set('my-objects/data.bin', false);
    store.set('uploads/2026.tar', false);

    const first = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/my-objects/data.bin`, {
        method: 'DELETE',
      }),
    );
    const second = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/uploads/2026.tar`, {
        method: 'DELETE',
      }),
    );

    expect(store.get('my-objects/data.bin')).toBe(true);
    expect(store.get('uploads/2026.tar')).toBe(true);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('Web API v1 DELETE — the response must not lie (TODO item 10)', () => {
  let handleWebApiV1: typeof import('../src/presentation/http/controllers/web-api-controller').handleWebApiV1;

  beforeAll(async () => {
    if (!handleWebApiV1) {
      process.env.BOT_TOKEN = '123456:ABC-DEF';
      process.env.STORAGE_CHANNEL_ID = '-1001234567890';
      process.env.BASE_URL = 'http://localhost:4000';
      process.env.DATABASE_URL = 'postgresql://asephs:***@127.0.0.1:5432/test';
      const webApi = await import('../src/presentation/http/controllers/web-api-controller');
      handleWebApiV1 = webApi.handleWebApiV1;
    }
  });

  beforeEach(() => {
    store.clear();
    deleteAttempts.length = 0;
  });

  it('answers 404 when the key does not exist, instead of an unconditional 200', async () => {
    const res = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/no/such/file.txt`, {
        method: 'DELETE',
      }),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Object not found' });
  });

  it('answers 404 on a second delete of the same key (already deleted)', async () => {
    store.set('once.txt', false);

    const first = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/once.txt`, { method: 'DELETE' }),
    );
    expect(first.status).toBe(200);

    const second = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/once.txt`, { method: 'DELETE' }),
    );
    expect(second.status).toBe(404);
  });

  it('does not report success for a whole-key %2F-encoded delete that removed nothing', async () => {
    store.set('deep/nested/file.txt', false);

    // The slash is percent-encoded, so it is NOT a path separator: this names
    // one bucket-root segment called `deep%2Fnested%2Ffile.txt`, not the nested
    // key. It must not claim to have deleted the nested file.
    const res = await handleWebApiV1(
      new Request(`http://localhost:4000/api/v1/buckets/${BUCKET}/deep%2Fnested%2Ffile.txt`, {
        method: 'DELETE',
      }),
    );

    expect(store.get('deep/nested/file.txt')).toBe(false);
    expect(res.status).toBe(404);
  });

  it('answers 404 for a missing bucket before attempting any delete', async () => {
    const res = await handleWebApiV1(
      new Request('http://localhost:4000/api/v1/buckets/no-such-bucket/some/key.txt', {
        method: 'DELETE',
      }),
    );

    expect(deleteAttempts).toHaveLength(0);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Bucket not found' });
  });
});
