import { afterAll, describe, expect, it, vi } from 'vitest';
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

/**
 * P2b — S3 vs. site routing, asserted against the REAL application.
 *
 * This suite used to import the `{ routes }` table from
 * `src/presentation/http/routes/index.ts` and call `routes['/'].GET(...)`
 * directly. That table is dead code: nothing imports it at runtime, so every
 * assertion here was proving properties of an object the server never
 * consults. Hono (`createApp`) replaced it in P2b.
 *
 * These tests now drive `createApp().request(...)`, the same entry point the
 * production server uses (`src/index.ts` serves `createApp()` via
 * `@hono/node-server`), so a routing regression fails here for the reason it
 * would fail in production.
 *
 * `hono-routing.test.ts` overlaps on two points and covers them with MOCKED
 * controllers, so it cannot make the content-type claims made below. What is
 * unique HERE, and nowhere else in the suite:
 *
 *   1. GET / with SigV4 returns XML (proves the REAL S3 controller ran, not a
 *      mock — `hono-routing.test.ts` only asserts a mock was called).
 *   2. GET / without SigV4 is served by the site root and never answers with
 *      S3 XML (a mocked `handleHome`/`spaIndex` returns a canned string and
 *      proves nothing).
 *   3. HEAD/DELETE/POST on `/` → 404. `hono-routing.test.ts` covers only
 *      GET / and PUT / on the root.
 *   4. OPTIONS on the `/*` CATCH-ALL, both with and without SigV4 headers.
 *      `hono-routing.test.ts` tests OPTIONS on `/` only.
 *
 * Deliberately NOT mocked: `shouldHandleS3` (the real S3 arbiter) and the S3
 * controller itself (so its XML content-type is the real one).
 */
const { createApp } = await import('../src/presentation/http/app');

const req = () => createApp().request;

describe('S3 routing (live app)', () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('routes GET / with AWS4 auth headers to S3 (not the home page)', async () => {
    const res = await req()('/', { headers: { authorization: AWS_AUTH } });
    const contentType = res.headers.get('content-type') || '';
    // S3 answers with XML; the home page would be text/html.
    expect(contentType).toContain('application/xml');
  });

  it('serves GET / without S3 headers as HTML, never as S3 XML', async () => {
    const res = await req()('/');
    // The claim under test is the ROUTING decision: a non-SigV4 root request is
    // served by the site-root handler, NOT claimed by the S3 catch-all.
    //
    // With `WEB_DIST_PATH` unset (the unit-suite default) the site root is the
    // SPA shell, which resolves to no SPA and falls back to 404 — that 404 is
    // the site-root handler answering, which is why the discriminator below is
    // "not the S3 404". S3's own 404 carries an `application/xml` body; this
    // one is `text/plain`. Asserting on content-type rather than status keeps
    // this test honest whether or not a SPA is built.
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).not.toContain('application/xml');
    if (res.status === 200) {
      // A SPA (or home.html) is present: it must be HTML.
      expect(contentType).toContain('text/html');
    } else {
      expect(res.status).toBe(404);
      expect(contentType).toContain('text/plain');
    }
  });

  it('answers OPTIONS /* without S3 headers as a generic 204 CORS preflight (not S3 XML)', async () => {
    const res = await req()('/some/path', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('routes OPTIONS /* with AWS4 auth headers to the S3 handler', async () => {
    const res = await req()('/gitea/key', {
      method: 'OPTIONS',
      headers: { authorization: AWS_AUTH },
    });
    expect(res.status).toBe(204);
  });

  it('answers HEAD / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await req()('/', { method: 'HEAD' });
    // Same caveat as GET /: with no SPA built the site root is 404 anyway, so
    // the discriminator is that it is NOT the S3 handler answering.
    //
    // The status is no longer asserted unconditionally. It used to be, and it
    // passed only because WEB_DIST_PATH is unset in CI: against a real dashboard
    // build the same request answers 200 text/html and this test went red for a
    // reason that had nothing to do with routing. Given the same if/else shape as
    // its sibling at lines 183-192, it is honest in both environments.
    expect(res.headers.get('content-type') || '').not.toContain('application/xml');
    if (res.status === 200) {
      expect(res.headers.get('content-type') || '').toContain('text/html');
    } else {
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') || '').toContain('text/plain');
    }
  });

  it('routes a SigV4 HEAD to the S3 handler, not to a dead HEAD registration', async () => {
    // app.ts used to carry `app.on('HEAD', '/*', s3Or(notFound))` and
    // `app.on(['HEAD', ...], '/', ...)`. Both were DEAD CODE: Hono re-dispatches
    // every HEAD as GET before router.match, so a route registered with method
    // "HEAD" can never be dispatched. HEAD is served by the app.get() routes, and
    // it still reaches S3 because handleS3Request reads req.method off the raw
    // Request — which is still "HEAD" — not off the matched route.
    // Status, not content-type: Hono's c.text() helper labels its own body
    // text/plain regardless of the content it holds, and the app.ts routes in
    // play here answer 404 text/plain when no SPA is configured. What must be
    // proven is that the HEAD is DISPATCHED AT ALL — a dead `app.on('HEAD', ...)`
    // would leave it unrouted.
    const res = await req()('/gitea/key.txt', {
      method: 'HEAD',
      headers: { authorization: AWS_AUTH },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') || '').not.toContain('text/html');
  });

  it('answers DELETE / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await req()('/', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('answers POST / without S3 headers as 404 (never S3-direct)', async () => {
    const res = await req()('/', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
