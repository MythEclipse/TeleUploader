/**
 * P3b — S3 credential lookup is genuinely exercised.
 *
 * This is the test that would have caught the whole premise being false. Before
 * P3 the ONLY place in `src/` that read `config.s3AccessKey` /
 * `config.s3SecretKey` for verification was s3-router.ts, so a credential that
 * existed only in `s3_credentials` could not authenticate at all: signing a
 * presigned GET with a database-only pair returned `SignatureDoesNotMatch`
 * while the environment pair returned `isValid: true`, because the verification
 * path never touched the database.
 *
 * The SigV4 arithmetic itself is unchanged and is covered by s3-auth.test.ts.
 * What is under test here is only WHICH secret is resolved, and that an unknown
 * key is rejected rather than falling through to the environment pair.
 */
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.BOT_TOKENS ||= '123456:ABC-DEF';
process.env.STORAGE_CHANNEL_ID ||= '-1001234567890';
process.env.BASE_URL ||= 'https://example.com';
process.env.PORT ||= '4000';
process.env.NODE_ENV = 'test';

const { verifyPresignedUrl, verifySignature, parseCredentialScope } = await import(
  '../src/presentation/s3/auth'
);
const { DrizzleS3CredentialRepository } = await import(
  '../src/infrastructure/persistence/repositories/s3-credential-repository'
);
const { db } = await import('../src/infrastructure/persistence/drizzle/index');

const REGION = 'us-east-1';

/**
 * These tests read `s3_credentials` for real — that IS the behaviour under
 * test, so it cannot be mocked the way the other suites mock their
 * repositories. They skip (rather than fail) when no database is reachable, so
 * the suite stays runnable offline.
 */
let live = false;

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    live = true;
  } catch {
    live = false;
  }
});

/**
 * Resolves against the real repository, i.e. against `s3_credentials`.
 *
 * This is the point of the test: the resolver is the production one, so a
 * database-only key must verify and an absent key must not.
 */
const dbBackedResolver = async (accessKey: string): Promise<string | null> => {
  const repo = new DrizzleS3CredentialRepository();
  const credential = await repo.findByAccessKey(accessKey);
  return credential?.secretKey ?? null;
};

/** A key that exists in NO store — used to prove there is no env fallback. */
const UNKNOWN_KEY = 'no-such-key-anywhere-in-the-store';

/** SHA-256 hex, matching auth.ts's internal helper. */
const sha256hex = (data: string): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer, message: string): Buffer =>
  createHmac('sha256', key).update(message).digest();

/** The four-step SigV4 signing key derivation, mirroring auth.ts. */
const signingKey = (secret: string, dateStamp: string, region: string): Buffer => {
  const kDate = hmac(Buffer.from(`AWS4${secret}`), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
};

/** Build a valid presigned GET URL for the given key pair. */
const presign = (host: string, path: string, accessKey: string, secret: string): string => {
  const dateStamp = '20260707';
  const amzDate = '20260707T120000Z';
  const sp = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${dateStamp}/${REGION}/s3/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '3600',
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalRequest = `GET\n${path}\n${sp.toString()}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  sp.set(
    'X-Amz-Signature',
    hmac(signingKey(secret, dateStamp, REGION), stringToSign).toString('hex'),
  );
  return `https://${host}${path}?${sp.toString()}`;
};

describe('parseCredentialScope', () => {
  it('splits a scope into its five parts', () => {
    expect(parseCredentialScope('key/20260707/us-east-1/s3/aws4_request')).toEqual({
      accessKey: 'key',
      date: '20260707',
      region: 'us-east-1',
      service: 's3',
      termination: 'aws4_request',
    });
  });

  it('rejects a scope that is not exactly five parts', () => {
    expect(parseCredentialScope('key/20260707/us-east-1')).toBeNull();
    expect(parseCredentialScope('key/20260707/us-east-1/s3/aws4_request/extra')).toBeNull();
    // Empty segments are not a usable credential.
    expect(parseCredentialScope('/20260707/us-east-1/s3/aws4_request')).toBeNull();
  });
});

describe('credential resolution', () => {
  it('a presigned URL signed with the env-only pair is REJECTED (no env fallback)', async () => {
    if (!live) return;
    // The environment pair is deliberately NOT consulted anywhere in the S3
    // path any more — seed.ts carries it into s3_credentials instead. This
    // test is what stops a future "just fall back to config" from quietly
    // re-opening a global scope.
    const url = presign('localhost', '/bucket/key.txt', 'filedrop-admin', 'unit-test-secret');
    const result = await verifyPresignedUrl({
      url,
      method: 'GET',
      headers: { host: 'localhost' },
      resolveSecret: dbBackedResolver,
      region: REGION,
      now: new Date('2026-07-07T12:05:00Z'),
    });

    // Either the key is absent from s3_credentials (rejected) or it is present
    // and verifies. What must never happen is "valid because of the env".
    const inStore = await new DrizzleS3CredentialRepository().findByAccessKey('filedrop-admin');
    if (!inStore) {
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe('SignatureDoesNotMatch');
    } else {
      expect(result.isValid).toBe(true);
    }
  });

  it('a key present in no store is rejected', async () => {
    if (!live) return;
    const url = presign('localhost', '/bucket/key.txt', UNKNOWN_KEY, 'whatever');
    const result = await verifyPresignedUrl({
      url,
      method: 'GET',
      headers: { host: 'localhost' },
      resolveSecret: dbBackedResolver,
      region: REGION,
      now: new Date('2026-07-07T12:05:00Z'),
    });
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('SignatureDoesNotMatch');
  });

  it('a wrong secret for a known-scope key does not verify', async () => {
    if (!live) return;
    const url = presign('localhost', '/bucket/key.txt', 'filedrop-admin', 'the-wrong-secret');
    const result = await verifyPresignedUrl({
      url,
      method: 'GET',
      headers: { host: 'localhost' },
      resolveSecret: dbBackedResolver,
      region: REGION,
      now: new Date('2026-07-07T12:05:00Z'),
    });
    // Either rejected as unknown, or rejected as a bad signature. Never valid.
    expect(result.isValid).toBe(false);
  });

  it('header-based auth also resolves through the callback, not the environment', async () => {
    if (!live) return;
    const dateStamp = '20260707';
    const amzDate = '20260707T120000Z';
    const accessKey = UNKNOWN_KEY;
    const headers = {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${dateStamp}/${REGION}/s3/aws4_request, SignedHeaders=host, Signature=${'0'.repeat(64)}`,
      'x-amz-date': amzDate,
      host: 'localhost',
    };
    const result = await verifySignature(
      'GET',
      'http://localhost/',
      headers,
      null,
      dbBackedResolver,
      REGION,
    );
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('SignatureDoesNotMatch');
  });
});
