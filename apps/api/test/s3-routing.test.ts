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
  isS3Request: (headers: Record<string, string>) =>
    (headers.authorization || '').startsWith('AWS4-HMAC-SHA256'),
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

const AWS_AUTH =
  'AWS4-HMAC-SHA256 Credential=filedrop-admin/20260101/us-east-1/s3/aws4_request, ' +
  'SignedHeaders=host;x-amz-date, Signature=abc123';

describe('S3 routing (routes table)', () => {
  let routes: typeof import('../src/presentation/http/routes/index').routes;

  beforeAll(async () => {
    ({ routes } = await import('../src/presentation/http/routes/index'));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('routes GET / with AWS4 auth headers to S3 (not the home page)', async () => {
    const res = await routes['/'].GET(
      new Request('http://localhost:4000/', {
        headers: { authorization: AWS_AUTH },
      }),
    );
    const contentType = res.headers.get('content-type') || '';
    // S3 answers with XML; the home page would be text/html.
    expect(contentType).toContain('application/xml');
  });

  it('serves GET / without S3 headers as the home page (HTML 200)', async () => {
    const res = await routes['/'].GET(new Request('http://localhost:4000/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('FileDrop');
  });

  it('answers OPTIONS /* without S3 headers as a generic 204 CORS preflight (not S3 XML)', async () => {
    const res = await routes['/*'].OPTIONS(
      new Request('http://localhost:4000/some/path', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('routes OPTIONS /* with AWS4 auth headers to the S3 handler', async () => {
    const res = await routes['/*'].OPTIONS(
      new Request('http://localhost:4000/gitea/key', {
        method: 'OPTIONS',
        headers: { authorization: AWS_AUTH },
      }),
    );
    expect(res.status).toBe(204);
  });

  it('answers HEAD / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].HEAD(new Request('http://localhost:4000/', { method: 'HEAD' }));
    expect(res.status).toBe(404);
  });

  it('answers DELETE / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].DELETE(
      new Request('http://localhost:4000/', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('answers POST / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await routes['/'].POST(new Request('http://localhost:4000/', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});
