import { RPCHandler } from "@orpc/server/fetch";
import type { Context as HonoContext } from "hono";
import { config } from "../../env";
import { handleLogout, handleLogoutAll, handleMe } from "../http/controllers/auth-controller";
import {
	handleCreateCredentialV1,
	handleDeleteCredentialV1,
	handleListCredentialsV1,
} from "../http/controllers/credentials-controller";
import { handleMoveObjectV1 } from "../http/controllers/move-controller";
import {
	handleBucketUsageV1,
	handleSearchObjectsV1,
	handleStorageEndpointV1,
	handleStorageUsageV1,
} from "../http/controllers/storage-controller";
import {
	handleCopyObjectV1,
	handleCreateBucketV1,
	handleDeleteBucketV1,
	handleDeleteObjectV1,
	handleDownloadObjectV1,
	handleListBucketsV1,
	handleListObjectsV1,
	handleWebApiV1,
} from "../http/controllers/web-api-controller";
import { getAuthenticatedCaller, TenantAccessError } from "../http/middleware/auth";
import type { AppRouterContext } from "./context";
import { buildRouter } from "./routers";
import type { RouterHandlers } from "./routers/bucket";

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
 *
 * WHY THE HANDLER MAP IS EXPLICIT
 *
 * Every entry names a controller function directly, and several adapt a
 * signature (`(req, bucket, organizationId)` → `(req, params, organizationId)`).
 * Those adapters are why upload and download stay out of this file's procedure
 * list: `handleUploadObjectV1` takes a streamed multipart body and
 * `handleDownloadObjectV1` returns one, and oRPC serialises both directions as
 * JSON. They keep their binary routes and are called by the web app's
 * `lib/client.ts`, not by `lib/rpc.ts`.
 */
const handlers = {
	bucket: {
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
		bucketUsage: (bucket: string, organizationId: string) =>
			handleBucketUsageV1({ bucket }, organizationId),
		moveObject: (req: Request, bucket: string, organizationId: string) =>
			handleMoveObjectV1(req, { bucket }, organizationId),
	},

	// The auth controllers read the session off the `Request`, so the procedure
	// forwards the caller's headers — see `routers/me.ts`.
	me: {
		getMe: handleMe,
		logout: handleLogout,
		logoutAll: handleLogoutAll,
	},

	// There is no standalone organization controller: the route is a branch of
	// the `/api/v1/*` dispatcher, and delegating to it keeps ONE definition of
	// which tenants a caller may see.
	organization: {
		listOrganizations: handleWebApiV1,
	},

	storage: {
		usage: handleStorageUsageV1,
		endpoint: handleStorageEndpointV1,
		search: handleSearchObjectsV1,
	},

	credentials: {
		list: handleListCredentialsV1,
		create: handleCreateCredentialV1,
		remove: (id: string, organizationId: string) =>
			handleDeleteCredentialV1({ id }, organizationId),
	},
} satisfies RouterHandlers;

const router = buildRouter(handlers);

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
export const RPC_PREFIX = "/rpc";

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

	// P3 → multi-user: resolve the CALLER's organization BEFORE any procedure runs.
	//
	// This used to call `resolveAdminOrganizationId()`, which ignored the request
	// entirely and returned the configured bootstrap org — so every authenticated
	// person shared one tenant regardless of who they were. Now the scope comes from
	// the session, and a caller with no reachable organization gets a 503 rather
	// than a silently-shared workspace.
	//
	// The try/catch exists because an opaque 500 with an empty body reads like a
	// crash, whereas 503 plus a stable error name says which thing is wrong. It is
	// NOT a 401: reaching this point means `rpcAuthenticated` already accepted the
	// credentials.
	const caller = await getAuthenticatedCaller(request);
	if (!caller) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let organizationId: string;
	try {
		const { resolveCallerOrganization } = await import("../http/middleware/auth");
		const resolved = await resolveCallerOrganization(
			caller,
			new URL(request.url).searchParams.get("org")
		);
		organizationId = resolved.organizationId;
	} catch (error: unknown) {
		if (error instanceof TenantAccessError) {
			return Response.json(
				{
					error: error.message,
					detail: error.status === 503 ? "missing_organization_membership" : "not_a_member",
				},
				{ status: error.status }
			);
		}
		throw error;
	}
	const rpcPath = request.url.replace(RPC_PREFIX, "");
	const result = await orpcHandler.handle(
		new Request(new URL(rpcPath, request.url).href, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			// A streamed body on a Web Request requires this.
			duplex: "half",
		} as RequestInit),
		{ context: buildOrpcContext(c, organizationId) }
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
