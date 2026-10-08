import { implement, os } from '@orpc/server';
import { z } from 'zod';
import type { AppRouterContext } from '../context';

/**
 * Bucket management procedures (P2c).
 *
 * The handlers are NOT migrated in this commit: `web-api-controller.ts` keeps
 * serving `/api/v1/*` unchanged. What is new is a typed procedure surface that
 * P4's React app consumes through the oRPC client, and that P3 scopes to an
 * organization.
 *
 * Why add rather than replace: `/api/v1/*` is asserted by 9 test files and is
 * still consumed by `src/home.html` (4 raw `fetch` calls) until P4 replaces the
 * dashboard. Moving it now would mean rewriting those tests and the dashboard
 * before either has a replacement.
 *
 * Each procedure delegates to the same controller the HTTP route uses, so both
 * surfaces behave identically until P4 retires the old one.
 *
 * Written contract-first via `implement(...).$context()` rather than bare `os`.
 * The package-level `os` is typed with an empty context, which makes `{ context }`
 * resolve to `Record<never, never>`; `$context<AppRouterContext>()` is the
 * supported way to declare it.
 */

const bucketName = z
  .string()
  .min(3)
  .max(63)
  // S3 bucket naming rules, enforced client-side by the dashboard today. Kept
  // here so the typed client rejects the same inputs the controller does.
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'Invalid bucket name')
  .describe('S3 bucket name');

/** Object key within a bucket. May contain slashes. */
const objectPath = z.string().min(1).describe('Object key within the bucket');

/** The controller functions this router delegates to. */
export interface BucketHandlers {
  listBuckets: () => Promise<Response>;
  createBucket: (req: Request) => Promise<Response>;
  deleteBucket: (req: Request, bucket: string) => Promise<Response>;
  listObjects: (req: Request, bucket: string) => Promise<Response>;
  copyObject: (req: Request, bucket: string) => Promise<Response>;
  deleteObject: (req: Request, bucket: string, key: string) => Promise<Response>;
  downloadObject: (req: Request, bucket: string, key: string) => Promise<Response>;
}

/**
 * Build the Web `Request` a controller expects.
 *
 * The controllers take a Request rather than typed arguments, so this adapts.
 * `baseUrl` comes from BASE_URL so that relative asset URLs inside responses
 * resolve exactly as they did over HTTP.
 */
const bucketRequest = (context: AppRouterContext, path: string, init?: RequestInit): Request =>
  new Request(new URL(path, context.baseUrl).href, init);

/** Percent-encode each path segment while preserving `/` separators. */
const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

/** Contract: routes, inputs, and OpenAPI metadata, with no implementation. */
const bucketNamespace = {
  // ── Buckets ──────────────────────────────────────────────────────────────
  listBuckets: os
    .meta({ method: 'GET', path: '/api/v1/buckets', summary: 'List all buckets' })
    .handler(() => ({
      buckets: [] as { id: string; name: string; createdAt: string; objectCount: number }[],
    })),

  createBucket: os
    .input(z.object({ name: bucketName }))
    .meta({ method: 'POST', path: '/api/v1/buckets', summary: 'Create a bucket' })
    .handler(() => ({ id: '', name: '' })),

  deleteBucket: os
    .input(z.object({ bucket: bucketName }))
    .meta({
      method: 'DELETE',
      path: '/api/v1/buckets/{bucket}',
      summary: 'Delete a bucket and its contents',
    })
    .handler(() => ({ success: true })),

  // ── Objects ──────────────────────────────────────────────────────────────
  listObjects: os
    .input(
      z.object({
        bucket: bucketName,
        prefix: z.string().optional(),
        delimiter: z.string().optional(),
        maxKeys: z.coerce.number().int().positive().max(1000).optional(),
      }),
    )
    .meta({
      method: 'GET',
      path: '/api/v1/buckets/{bucket}/objects',
      summary: 'List objects in a bucket',
    })
    .handler(() => ({ objects: [] as Record<string, unknown>[], prefixes: [] as string[] })),

  copyObject: os
    .input(
      z.object({
        bucket: bucketName,
        sourceKey: objectPath,
        destKey: objectPath,
        destBucket: bucketName.optional(),
      }),
    )
    .meta({
      method: 'POST',
      path: '/api/v1/buckets/{bucket}/copy',
      summary: 'Copy an object within or across buckets',
    })
    .handler(() => ({ sourceKey: '', destKey: '', destBucket: '' })),

  deleteObject: os
    .input(z.object({ bucket: bucketName, key: objectPath }))
    .meta({
      method: 'DELETE',
      path: '/api/v1/buckets/{bucket}/{key}',
      summary: 'Delete an object (soft delete)',
    })
    .handler(() => ({ success: true })),

  downloadObject: os
    .input(z.object({ bucket: bucketName, key: objectPath }))
    .meta({
      method: 'GET',
      path: '/api/v1/buckets/{bucket}/download/{key}',
      summary: 'Download an object',
    })
    .handler(() => ({ key: '', size: 0, etag: null as string | null, downloadUrl: '' })),
};

/**
 * Root contract: namespaces are declared here so `$context<AppRouterContext>()`
 * is applied ONCE at the root rather than per-router.
 */
export const rootContract = { bucket: bucketNamespace };

/** The builder produced by applying this app's context to the root contract. */
const typedBuilder = () => implement(rootContract).$context<AppRouterContext>();

/** Typed builder for this app's context. */
export type BucketBase = ReturnType<typeof typedBuilder>;

/** The bound bucket router shape. */
export type BucketRouter = ReturnType<ReturnType<BucketBase['bucket']['router']>>;
/**
 * Convert a controller's JSON `Response` into an RPC payload.
 *
 * The procedures return the controller response directly, which is wrong: oRPC
 * serialises the returned VALUE, and a `Response` serialises to `{}`. Verified —
 * the client received `{"json":{}}` before this adapter existed. So the body is
 * parsed here and the HTTP status is preserved by throwing on a non-2xx, which
 * oRPC maps to an error rather than a success carrying an error payload.
 */
const jsonPayload = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(
      `controller responded ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body ?? {})}`,
    );
  }
  return (await res.json()) as T;
};

/**
 * Bind the bucket contract's procedures to their controller delegates.
 *
 * Takes the typed builder as a parameter so the ROOT router can implement one
 * contract containing both this namespace and any future ones, applying
 * `$context<AppRouterContext>()` exactly once.
 */
export const buildBucketRouter = (base: BucketBase, handlers: BucketHandlers): BucketRouter =>
  base.bucket.router({
    listBuckets: base.bucket.listBuckets.handler(async () =>
      jsonPayload(await handlers.listBuckets()),
    ),

    createBucket: base.bucket.createBucket.handler(async ({ input, context }) =>
      jsonPayload(
        await handlers.createBucket(
          bucketRequest(context, '/api/v1/buckets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: input.name }),
          }),
        ),
      ),
    ),

    deleteBucket: base.bucket.deleteBucket.handler(async ({ input, context }) =>
      jsonPayload(
        await handlers.deleteBucket(
          bucketRequest(context, `/api/v1/buckets/${encodeURIComponent(input.bucket)}`, {
            method: 'DELETE',
          }),
          input.bucket,
        ),
      ),
    ),

    listObjects: base.bucket.listObjects.handler(async ({ input, context }) => {
      const query = new URLSearchParams();
      if (input.prefix !== undefined) query.set('prefix', input.prefix);
      if (input.delimiter !== undefined) query.set('delimiter', input.delimiter);
      if (input.maxKeys !== undefined) query.set('max-keys', String(input.maxKeys));
      const qs = query.toString();
      const path = `/api/v1/buckets/${encodeURIComponent(input.bucket)}/objects`;
      return jsonPayload(
        await handlers.listObjects(
          bucketRequest(context, qs ? `${path}?${qs}` : path),
          input.bucket,
        ),
      );
    }),

    copyObject: base.bucket.copyObject.handler(async ({ input, context }) =>
      jsonPayload(
        await handlers.copyObject(
          bucketRequest(context, `/api/v1/buckets/${encodeURIComponent(input.bucket)}/copy`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceKey: input.sourceKey,
              destKey: input.destKey,
              destBucket: input.destBucket,
            }),
          }),
          input.bucket,
        ),
      ),
    ),

    deleteObject: base.bucket.deleteObject.handler(async ({ input, context }) =>
      jsonPayload(
        await handlers.deleteObject(
          bucketRequest(
            context,
            `/api/v1/buckets/${encodeURIComponent(input.bucket)}/${encodeKey(input.key)}`,
            { method: 'DELETE' },
          ),
          input.bucket,
          input.key,
        ),
      ),
    ),

    downloadObject: base.bucket.downloadObject.handler(async ({ input, context }) =>
      jsonPayload(
        await handlers.downloadObject(
          bucketRequest(
            context,
            `/api/v1/buckets/${encodeURIComponent(input.bucket)}/download/${encodeKey(input.key)}`,
          ),
          input.bucket,
          input.key,
        ),
      ),
    ),
  });
