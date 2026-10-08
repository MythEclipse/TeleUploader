/**
 * P3b — multipart tenancy.
 *
 * Four handlers (`handleUploadPart`, `handleCompleteMultipartUpload`,
 * `handleAbortMultipartUpload`, `handleListParts`) previously called
 * `requireUploadOr404` WITHOUT resolving a bucket, so the guard had no bucket
 * to compare against. `findById` returns `bucketId`, but nothing checked it: an
 * upload belonging to another organization was reachable by anyone who knew
 * the uploadId, and a wholly fictional bucket path still returned success.
 *
 * These tests drive the real handlers with a bucket repository that answers per
 * organization, then assert the WIRE response — status and S3 error code —
 * because a handler that returns 404 with the wrong code is still broken.
 *
 * The tenant invariant under test: a cross-tenant miss must be byte-identical
 * to a bucket that exists in no organization at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.BOT_TOKENS ||= '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID ||= '-1001234567890';
process.env.BASE_URL ||= 'https://example.com';
process.env.PORT ||= '4000';
process.env.NODE_ENV = 'test';

const ORG_A = 'org-a-0000-0000-00000000000a';
const ORG_B = 'org-b-0000-0000-00000000000b';

/** An upload that belongs to org A's bucket — the thing org B must not touch. */
const UPLOAD_ID = 'upload-owned-by-org-a';
const BUCKET_A_ID = 'bucket-a-0000-0000-0000000000a';
const BUCKET_B_ID = 'bucket-b-0000-0000-0000000000b';

const bucketA = {
  id: BUCKET_A_ID,
  name: 'shared',
  organizationId: ORG_A,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};
const bucketB = {
  id: BUCKET_B_ID,
  name: 'shared',
  organizationId: ORG_B,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};
/** A bucket ONLY org A owns, used for the fictional-vs-cross-tenant comparison. */
const bucketOnlyA = {
  id: 'bucket-only-a-00000000000000a',
  name: 'owned-by-a',
  organizationId: ORG_A,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

/** Records every mutation so a cross-tenant write can be detected directly. */
let aborted: string[] = [];
let completed: string[] = [];

/** The upload's current status, flipped by abort/complete. */
let uploadStatus = 'in_progress';

vi.mock('../src/infrastructure/persistence/repositories/bucket-repository', () => ({
  DrizzleBucketRepository: class {
    create = (name: string, organizationId: string) =>
      Promise.resolve({
        id: 'new',
        name,
        organizationId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    // Answers per organization — both orgs own a bucket literally named
    // 'shared', so a name-only lookup cannot tell them apart.
    findByName = (name: string, organizationId: string) => {
      if (name === 'shared' && organizationId === ORG_A) return Promise.resolve(bucketA);
      if (name === 'shared' && organizationId === ORG_B) return Promise.resolve(bucketB);
      // Only org A owns this one, so org B's lookup misses — the same code path
      // a bucket owned by nobody takes.
      if (name === 'owned-by-a' && organizationId === ORG_A) return Promise.resolve(bucketOnlyA);
      return Promise.resolve(null);
    };
    list = (organizationId: string) =>
      Promise.resolve(organizationId === ORG_A ? [bucketA, bucketOnlyA] : [bucketB]);
    delete = () => Promise.resolve(true);
    exists = () => Promise.resolve(true);
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/multipart-repository', () => ({
  DrizzleMultipartRepository: class {
    create = () => Promise.resolve(UPLOAD_ID);
    // The upload always belongs to org A's bucket, whoever is asking.
    findById = (uploadId: string) =>
      Promise.resolve(
        uploadId === UPLOAD_ID && uploadStatus === 'in_progress'
          ? {
              uploadId,
              bucketId: BUCKET_A_ID,
              s3Key: 'shared-key.txt',
              initiatedAt: new Date('2026-01-01'),
              status: uploadStatus,
              initiatedBy: 'access-key-a',
            }
          : null,
      );
    abort = (uploadId: string) => {
      aborted.push(uploadId);
      uploadStatus = 'aborted';
      return Promise.resolve();
    };
    complete = (uploadId: string) => {
      completed.push(uploadId);
      uploadStatus = 'completed';
      return Promise.resolve();
    };
    insertPart = () => Promise.resolve();
    listParts = () => Promise.resolve([]);
    listByBucket = () => Promise.resolve({ uploads: [], isTruncated: false, nextKeyMarker: null });
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

vi.mock('../src/infrastructure/persistence/repositories/s3-credential-repository', () => ({
  DrizzleS3CredentialRepository: class {
    // The tenant under test is chosen by the access key the request presents.
    findByAccessKey = (accessKey: string) =>
      Promise.resolve(
        accessKey === 'key-a'
          ? { id: 'c-a', organizationId: ORG_A, accessKey, secretKey: 'secret' }
          : accessKey === 'key-b'
            ? { id: 'c-b', organizationId: ORG_B, accessKey, secretKey: 'secret' }
            : null,
      );
    touchLastUsed = () => Promise.resolve();
  },
}));

vi.mock('../src/infrastructure/persistence/repositories/organization-repository', () => ({
  DrizzleOrganizationRepository: class {
    findOrganizationIdByUserId = () => Promise.resolve(ORG_A);
  },
}));

vi.mock('../src/presentation/s3/auth', () => ({
  verifyPresignedUrl: () => Promise.resolve({ isValid: true, credential: MOCK_CREDENTIAL }),
  verifySignature: () => Promise.resolve({ isValid: true, credential: MOCK_CREDENTIAL }),
  verifyBodyHash: () => null,
  isS3Request: () => true,
}));

/** Which tenant the mocked SigV4 verification reports; set per test. */
let MOCK_CREDENTIAL = {
  accessKey: 'key-a',
  date: '20260707',
  region: 'us-east-1',
  service: 's3',
};

const { handleS3Request } = await import('../src/presentation/http/controllers/s3/s3-router');

beforeEach(() => {
  aborted = [];
  completed = [];
  uploadStatus = 'in_progress';
  MOCK_CREDENTIAL = {
    accessKey: 'key-a',
    date: '20260707',
    region: 'us-east-1',
    service: 's3',
  };
});

/** Issue a multipart request as org B against an arbitrary bucket path. */
const asIntruderFor = (method: string, query: string, bucket: string, body?: string) => {
  MOCK_CREDENTIAL = {
    accessKey: 'key-b',
    date: '20260707',
    region: 'us-east-1',
    service: 's3',
  };
  return handleS3Request(
    new Request(`http://localhost/${bucket}/shared-key.txt?${query}`, { method, body }),
    null,
  ).then(async (res) => ({ status: res.status, body: await res.text() }));
};

/** Issue a multipart request as org B against the bucket path 'shared'. */
const asIntruder = (method: string, query: string, body?: string) =>
  asIntruderFor(method, query, 'shared', body);

/**
 * Normalise an S3 error body for comparison between two requests.
 *
 * Drops the two things that legitimately differ: the per-request random
 * RequestId/HostId, and `<Resource>`, which echoes back the bucket name the
 * CALLER typed in the request path. The client supplied that string, so
 * echoing it discloses nothing — what must match is the error CODE, MESSAGE
 * and STATUS, which together are the whole of the oracle.
 */
const errorShape = (body: string): string =>
  body.replace(/<(RequestId|HostId|Resource)>[^<]*<\/\1>/g, '<$1/>').replace(/<\?xml[^>]*\?>/, '');

/** The same request against a bucket name owned by no organization. */
const asIntruderUnknownBucket = (method: string, query: string) => {
  MOCK_CREDENTIAL = {
    accessKey: 'key-b',
    date: '20260707',
    region: 'us-east-1',
    service: 's3',
  };
  return handleS3Request(
    new Request(`http://localhost/no-such-bucket/shared-key.txt?${query}`, { method }),
    null,
  ).then(async (res) => ({ status: res.status, body: await res.text() }));
};

describe('multipart cross-tenant requests', () => {
  it("ListParts against another tenant's upload returns 404 NoSuchUpload", async () => {
    const res = await asIntruder('GET', `uploadId=${UPLOAD_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toContain('NoSuchUpload');
  });

  it("Abort against another tenant's upload returns 404 and does NOT abort it", async () => {
    const res = await asIntruder('DELETE', `uploadId=${UPLOAD_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toContain('NoSuchUpload');
    // The write must not have happened at all.
    expect(aborted).toEqual([]);
    expect(uploadStatus).toBe('in_progress');
  });

  it("UploadPart against another tenant's upload returns 404", async () => {
    const res = await asIntruder('PUT', `uploadId=${UPLOAD_ID}&partNumber=1`, 'binary-part');
    expect(res.status).toBe(404);
    expect(res.body).toContain('NoSuchUpload');
  });

  it("Complete against another tenant's upload returns 404 and does NOT complete it", async () => {
    const res = await asIntruder(
      'POST',
      `uploadId=${UPLOAD_ID}`,
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"x"</ETag></Part></CompleteMultipartUpload>',
    );
    expect(res.status).toBe(404);
    expect(res.body).toContain('NoSuchUpload');
    expect(completed).toEqual([]);
    expect(uploadStatus).toBe('in_progress');
  });

  it("a bucket absent from the caller's org is byte-identical to a fictional one", async () => {
    // THE TENANT INVARIANT. Org B does NOT own a bucket named 'owned-by-a'
    // (only org A does), so resolution fails in org B exactly as it would for a
    // name owned by nobody. If these two ever diverge, the response is an
    // oracle confirming the name exists in some other tenant.
    for (const [method, query] of [
      ['GET', `uploadId=${UPLOAD_ID}`],
      ['DELETE', `uploadId=${UPLOAD_ID}`],
      ['PUT', `uploadId=${UPLOAD_ID}&partNumber=1`],
    ] as const) {
      const crossTenant = await asIntruderFor(method, query, 'owned-by-a');
      uploadStatus = 'in_progress';
      const unknownBucket = await asIntruderUnknownBucket(method, query);

      expect(crossTenant.status).toBe(unknownBucket.status);
      expect(errorShape(crossTenant.body)).toBe(errorShape(unknownBucket.body));
      expect(crossTenant.body).toContain('NoSuchBucket');
    }
  });

  it('when the caller owns a same-named bucket, the upload mismatch is NoSuchUpload', async () => {
    // The other half of the invariant: org B DOES own a bucket named 'shared',
    // so the bucket resolves legitimately and the rejection must come from the
    // upload's bucketId not matching — 404 NoSuchUpload, still a 404, still no
    // write, and still revealing nothing about org A's data.
    for (const [method, query] of [
      ['GET', `uploadId=${UPLOAD_ID}`],
      ['DELETE', `uploadId=${UPLOAD_ID}`],
      ['PUT', `uploadId=${UPLOAD_ID}&partNumber=1`],
    ] as const) {
      const res = await asIntruder(method, query);
      expect(res.status).toBe(404);
      expect(res.body).toContain('NoSuchUpload');
    }
    expect(aborted).toEqual([]);
    expect(completed).toEqual([]);
    expect(uploadStatus).toBe('in_progress');
  });

  it('the owning tenant still reaches its own upload', async () => {
    // The fix must not simply deny everyone: org A's own ListParts succeeds.
    MOCK_CREDENTIAL = {
      accessKey: 'key-a',
      date: '20260707',
      region: 'us-east-1',
      service: 's3',
    };
    const res = await handleS3Request(
      new Request(`http://localhost/shared/shared-key.txt?uploadId=${UPLOAD_ID}`, {
        method: 'GET',
      }),
      null,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ListPartsResult');
  });

  it('the owning tenant can still abort its own upload', async () => {
    MOCK_CREDENTIAL = {
      accessKey: 'key-a',
      date: '20260707',
      region: 'us-east-1',
      service: 's3',
    };
    const res = await handleS3Request(
      new Request(`http://localhost/shared/shared-key.txt?uploadId=${UPLOAD_ID}`, {
        method: 'DELETE',
      }),
      null,
    );
    expect(res.status).toBe(204);
    expect(aborted).toEqual([UPLOAD_ID]);
  });
});
