import { RPCHandler } from '@orpc/server/fetch';
import type { Context as HonoContext } from 'hono';
import { config } from '../../env';
import {
  handleCopyObjectV1,
  handleCreateBucketV1,
  handleDeleteBucketV1,
  handleDeleteObjectV1,
  handleDownloadObjectV1,
  handleListBucketsV1,
  handleListObjectsV1,
} from '../http/controllers/web-api-controller';
import type { AppRouterContext } from './context';
import { buildRouter } from './routers';
import type { BucketHandlers } from './routers/bucket';

/**
 * oRPC composition root (P2c).
 *
 * Builds the router once, binding each procedure to the SAME controller that
 * serves `/api/v1/*`. Both surfaces therefore cannot drift: one implementation
 * of each operation, two ways to reach it.
 *
 * Additive for now. `/api/v1/*` is asserted by 9 test files and consumed by
 * `src/home.html` (4 raw fetches) until P4 replaces the dashboard. P3 then adds
 * organization scoping on top of these same procedures.
 */
const router = buildRouter({
  listBuckets: handleListBucketsV1,
  createBucket: handleCreateBucketV1,
  deleteBucket: (req: Request, bucket: string) => handleDeleteBucketV1(req, { bucket }),
  listObjects: (req: Request, bucket: string) => handleListObjectsV1(req, { bucket }),
  copyObject: (req: Request, bucket: string) => handleCopyObjectV1(req, { bucket }),
  deleteObject: (req: Request, bucket: string, key: string) =>
    handleDeleteObjectV1(req, { bucket, key }),
  downloadObject: (req: Request, bucket: string, key: string) =>
    handleDownloadObjectV1(req, { bucket, key }),
} satisfies BucketHandlers);

/**
 * Fetch-style handler for the router.
 *
 * `RPCHandler` matches the FULL request path against the router — it strips no
 * prefix. Mounted at `/rpc/*`, a request for `/rpc/bucket/listBuckets` therefore
 * does not match, because the procedure path is `/bucket/listBuckets`. Verified
 * rather than assumed: calling `handle()` directly with each shape shows only the
 * unprefixed path returns `matched: true`.
 *
 * `RPC_PREFIX` is re-attached here so the procedures can keep declaring clean
 * paths. P4's typed client points at the same prefix, so it is unchanged.
 */
export const RPC_PREFIX = '/rpc';

/** Mounted at `/rpc/*` by app.ts. */
export const orpcHandler = new RPCHandler(router);

/**
 * Handle a `/rpc/*` request.
 *
 * Returns the adapter's `{ matched, response }` rather than a Response so an
 * unclaimed path can fall through to the next Hono route instead of 404-ing
 * inside the RPC handler.
 */
export const handleRpc = async (c: HonoContext) => {
  const request = c.req.raw;
  const rpcPath = request.url.replace(RPC_PREFIX, '');
  const result = await orpcHandler.handle(
    new Request(new URL(rpcPath, request.url).href, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // A streamed body on a Web Request requires this.
      duplex: 'half',
    } as RequestInit),
    { context: buildOrpcContext(c) },
  );
  if (result.matched && result.response) return result.response;
  return c.notFound();
};

/**
 * Per-request context.
 *
 * `organizationId` and `role` are omitted on purpose — they arrive with P3's
 * tenancy work. A procedure reading one before then gets `undefined` and fails,
 * rather than silently acting on a global scope P3 would have to unwind.
 */
export const buildOrpcContext = (c: HonoContext): AppRouterContext => ({
  headers: c.req.raw.headers,
  baseUrl: config.baseUrl,
});
