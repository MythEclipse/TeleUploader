import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IBucketRepository } from '../src/domain/ports/bucket-repository';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID = '-1001234567890';
process.env.BASE_URL = 'http://localhost:4000';
process.env.DATABASE_URL = 'postgresql://asephs:***@100.121.180.82:6432/test';
process.env.PORT = '4000';
process.env.S3_ACCESS_KEY = 'filedrop-admin';
process.env.S3_SECRET_KEY = 'unit-test-secret';

/**
 * What a successful SigV4 verification returns. The router derives the caller's
 * organization from `accessKey`, so this is the tenant every mocked S3 request
 * runs as.
 */
const MOCK_CREDENTIAL = {
  accessKey: 'mock-access-key',
  date: '20260707',
  region: 'us-east-1',
  service: 's3',
};

/**
 * Which user ids have a membership. Keyed by user id so a test can drive the
 * missing-membership path — the previous `userId ? 'org-a' : null` stub returned
 * an org for every truthy input, making that branch unreachable.
 */
const MOCK_MEMBERSHIPS: Record<string, string> = {
  [process.env.BOOTSTRAP_ADMIN_ID || 'bootstrap-admin']: 'org-a',
};

const bucket = {
  id: 'bucket-uuid',
  name: 'gitea',
  organizationId: 'org-a',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

vi.mock('../src/infrastructure/persistence/repositories/bucket-repository', () => ({
  DrizzleBucketRepository: class implements IBucketRepository {
    // Every method takes organizationId. Declaring `implements` is the point:
    // an untyped one-arg mock silently accepts the extra argument in JavaScript
    // and returns the same bucket for every tenant, so the suite stays green
    // while cross-tenant leakage is introduced.
    create = (name: string, organizationId: string) =>
      Promise.resolve({ ...bucket, name, organizationId });
    findByName = (name: string, organizationId: string) =>
      Promise.resolve(
        name === bucket.name && organizationId === bucket.organizationId ? bucket : null,
      );
    list = (organizationId: string) =>
      Promise.resolve(organizationId === bucket.organizationId ? [bucket] : []);
    delete = (name: string, organizationId: string) =>
      Promise.resolve(name === bucket.name && organizationId === bucket.organizationId);
    exists = (name: string, organizationId: string) =>
      Promise.resolve(name === bucket.name && organizationId === bucket.organizationId);
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/s3-credential-repository', () => ({
  DrizzleS3CredentialRepository: class {
    // The router resolves the caller's organization through this lookup, so a
    // mocked S3 request still has to resolve to a tenant.
    findByAccessKey = (accessKey: string) =>
      Promise.resolve(
        accessKey === 'mock-access-key'
          ? { id: 'cred-1', organizationId: 'org-a', accessKey, secretKey: 'unit-test-secret' }
          : null,
      );
    touchLastUsed = () => Promise.resolve();
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/organization-repository', () => ({
  DrizzleOrganizationRepository: class {
    // Keyed by user id rather than answering 'org-a' for any truthy input, so
    // the missing-membership branch is reachable from a test.
    findOrganizationIdByUserId = (userId: string) =>
      Promise.resolve(MOCK_MEMBERSHIPS[userId] ?? null);
  },
}));
vi.mock('../src/infrastructure/persistence/repositories/file-repository', () => ({
  DrizzleFileRepository: class {
    countByBucket = () => Promise.resolve(0);
    findByBucketAndKey = () => Promise.resolve(null);
    listByPrefix = () => Promise.resolve({ objects: [], prefixes: [] });
    softDelete = () => Promise.resolve(true);
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/multipart-repository', () => ({
  DrizzleMultipartRepository: class {
    abort = () => Promise.resolve();
    complete = () => Promise.resolve();
    create = () => Promise.resolve('upload-id');
    findById = () => Promise.resolve(null);
    insertPart = () => Promise.resolve();
    listParts = () => Promise.resolve([]);
    listByBucket = () => Promise.resolve({ uploads: [], isTruncated: false, nextKeyMarker: null });
  },
}));

vi.mock('../src/infrastructure/telegram/chunked-storage', () => ({
  ChunkedStorage: class {
    createChunkedObjectResponse = () => Promise.resolve(new Response(''));
    storeFileInTelegramChunks = () => Promise.resolve({ fileHash: 'hash' });
  },
}));

vi.mock('../src/presentation/s3/auth', () => ({
  // `credential` is REQUIRED: the router reads the access key off it to
  // resolve the caller's organization. A mock returning `{ isValid: true }`
  // alone leaves the tenant unresolvable and every request 403s — which is
  // what happens if this shape drifts from SigV4Result again.
  verifyPresignedUrl: () => Promise.resolve({ isValid: true, credential: MOCK_CREDENTIAL }),
  verifySignature: () => Promise.resolve({ isValid: true, credential: MOCK_CREDENTIAL }),
  verifyBodyHash: () => null,
  isS3Request: () => true,
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
        bot_token: '123456:ABC-DEF',
        file_path: 'documents/file.txt',
        file_size: 100,
        mime_type: 'text/plain',
      }),
  },
}));

describe('S3 bucket configuration compatibility', () => {
  let handleS3Request: typeof import('../src/presentation/http/controllers/s3-controller').handleS3Request;

  beforeAll(async () => {
    ({ handleS3Request } = await import('../src/presentation/http/controllers/s3-controller'));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns VersioningConfiguration for path-style GetBucketVersioning', async () => {
    const res = await handleS3Request(new Request('http://localhost:4000/gitea?versioning'));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(body).toContain('<VersioningConfiguration');
    expect(body).not.toContain('<ListBucketResult');
  });

  it('returns VersioningConfiguration for virtual-hosted GetBucketVersioning', async () => {
    const res = await handleS3Request(
      new Request('http://gitea.localhost:4000/?versioning'),
      'gitea',
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('<VersioningConfiguration');
    expect(body).not.toContain('<ListBucketResult');
  });
});
