import { RPCHandler } from '@orpc/server/fetch';
import type { Context as HonoContext } from 'hono';
import { config } from '../../env';
import {
  MissingOrganizationMembershipError,
  resolveAdminOrganizationId,
} from '../http/controllers/organization-resolver';
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
  deleteBucket: (req: Request, bucket: string, organizationId: string) =>
    handleDeleteBucketV1(req, { bucket }, organizationId),
  listObjects: (req: Request, bucket: string, organizationId: string) =>
    handleListObjectsV1(req, { bucket }, organizationId),
  copyObject: (req: Request, bucket: string, organizationId: string) =>
    handleCopyObjectV1(req, { bucket }, organizationId),
  deleteObject: (req: Request, bucket: string, key: string, organizationId: string) =>
    handleDeleteObjectV1(req, { bucket, key }, organizationId),
  downloadObject: (req: Request, bucket: string, key: string, organizationId: string) =>
    handleDownloadObjectV1(req, { bucket, key }, organizationId),
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

  // P3: resolve the session's organization BEFORE any procedure runs, so an
  // unauthenticated or unmapped caller cannot reach a bucket at all. A missing
  // bootstrap membership THROWS rather than returning a 401 — that is a
  // misconfiguration, and it is refused at boot instead. Unauthenticated
  // callers are already rejected by `rpcAuthenticated` above; answering 401
  // here as well conflated the two failures.
  //
  // The catch exists because src/index.ts resolves the scope at boot, but this
  // handler still runs in processes that do not boot it (tests, embedders). An
  // uncaught throw here becomes an opaque 500 with an empty body, which reads
  // like a crash rather than "this deployment has no tenant scope". 503 + a
  // stable error name says which it is. It is NOT a 401: the caller's
  // credentials were fine.
  let organizationId: string;
  try {
    organizationId = await resolveAdminOrganizationId();
  } catch (error: unknown) {
    if (error instanceof MissingOrganizationMembershipError) {
      return Response.json(
        { error: 'Tenant scope unavailable', detail: 'missing_organization_membership' },
        { status: 503 },
      );
    }
    throw error;
  }
  const rpcPath = request.url.replace(RPC_PREFIX, '');
  const result = await orpcHandler.handle(
    new Request(new URL(rpcPath, request.url).href, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // A streamed body on a Web Request requires this.
      duplex: 'half',
    } as RequestInit),
    { context: buildOrpcContext(c, organizationId) },
  );
  if (result.matched && result.response) return result.response;
  return c.notFound();
};

/**
 * Per-request context.
 *
 * P3: `organizationId` is now required. It is resolved by the caller from the
 * authenticated admin session's membership and threaded into every procedure,
 * which is what scopes the bucket reads and writes the procedures delegate to
 * in `web-api-controller.ts`. `role` still arrives with the two-layer role
 * system.
 *
 * @param c - The Hono request context.
 * @param organizationId - The authenticated caller's organization (UUID).
 */
export const buildOrpcContext = (c: HonoContext, organizationId: string): AppRouterContext => ({
  headers: c.req.raw.headers,
  baseUrl: config.baseUrl,
  organizationId,
});
