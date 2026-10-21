import { implement, os } from "@orpc/server";
import { z } from "zod";
import type { AppRouterContext } from "../context";
import { type CredentialsHandlers, credentialsNamespace } from "./credentials";
import { type MeHandlers, meNamespace } from "./me";
import { type OrganizationHandlers, organizationNamespace } from "./organization";
import { controllerRequest, jsonPayload } from "./shared";
import { type StorageHandlers, storageNamespace } from "./storage";

/**
 * The oRPC contract and the bucket/object namespace (P2c).
 *
 * The handlers are NOT migrated: `web-api-controller.ts` keeps serving
 * `/api/v1/*` unchanged. What is new is a typed procedure surface that P4's
 * React app consumes through the oRPC client, and that P3 scopes to an
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
 * This file owns the ROOT CONTRACT for every namespace, not just buckets.
 * `$context<AppRouterContext>()` must be applied exactly once, at the root —
 * declaring it per namespace would give each one its own incompatible builder
 * type, and the package-level `os` is typed with an EMPTY context, which makes
 * `{ context }` resolve to `Record<never, never>`.
 */

const bucketName = z
	.string()
	.min(3)
	.max(63)
	// S3 bucket naming rules, enforced client-side by the dashboard today. Kept
	// here so the typed client rejects the same inputs the controller does.
	.regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Invalid bucket name")
	.describe("S3 bucket name");

/** Object key within a bucket. May contain slashes. */
const objectPath = z.string().min(1).describe("Object key within the bucket");

/** Percent-encode each path segment while preserving `/` separators. */
const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/** The controller functions the bucket namespace delegates to. */
export interface BucketHandlers {
	listBuckets: (organizationId: string) => Promise<Response>;
	createBucket: (req: Request, organizationId: string) => Promise<Response>;
	deleteBucket: (req: Request, bucket: string, organizationId: string) => Promise<Response>;
	listObjects: (req: Request, bucket: string, organizationId: string) => Promise<Response>;
	copyObject: (req: Request, bucket: string, organizationId: string) => Promise<Response>;
	deleteObject: (
		req: Request,
		bucket: string,
		key: string,
		organizationId: string
	) => Promise<Response>;
	/** `GET /api/v1/buckets/{bucket}/usage` — totals for one bucket. */
	bucketUsage: (bucket: string, organizationId: string) => Promise<Response>;
	/** `POST /api/v1/buckets/{bucket}/move` — rename an object or a folder. */
	moveObject: (req: Request, bucket: string, organizationId: string) => Promise<Response>;
}

/** Contract: routes, inputs, and OpenAPI metadata, with no implementation. */
const bucketNamespace = {
	// ── Buckets ──────────────────────────────────────────────────────────────
	listBuckets: os.meta({ method: "GET", path: "/api/v1/buckets", summary: "List all buckets" }),

	createBucket: os
		.input(z.object({ name: bucketName }))
		.meta({ method: "POST", path: "/api/v1/buckets", summary: "Create a bucket" }),

	deleteBucket: os.input(z.object({ bucket: bucketName })).meta({
		method: "DELETE",
		path: "/api/v1/buckets/{bucket}",
		summary: "Delete a bucket and its contents",
	}),

	// ── Objects ──────────────────────────────────────────────────────────────
	listObjects: os
		.input(
			z.object({
				bucket: bucketName,
				prefix: z.string().optional(),
				delimiter: z.string().optional(),
				maxKeys: z.coerce.number().int().positive().max(1000).optional(),
			})
		)
		.meta({
			method: "GET",
			path: "/api/v1/buckets/{bucket}/objects",
			summary: "List objects in a bucket",
		}),

	copyObject: os
		.input(
			z.object({
				bucket: bucketName,
				sourceKey: objectPath,
				destKey: objectPath,
				destBucket: bucketName.optional(),
			})
		)
		.meta({
			method: "POST",
			path: "/api/v1/buckets/{bucket}/copy",
			summary: "Copy an object within or across buckets",
		}),

	deleteObject: os.input(z.object({ bucket: bucketName, key: objectPath })).meta({
		method: "DELETE",
		path: "/api/v1/buckets/{bucket}/{key}",
		summary: "Delete an object (soft delete)",
	}),

	// NO `downloadObject` PROCEDURE EXISTS, DELIBERATELY.
	//
	// Download and upload are the two operations this surface cannot carry, and
	// both for the same class of reason: oRPC serialises through JSON on BOTH
	// directions. `jsonPayload` calls `res.json()`, which throws on a binary body
	// (verified with a 6-byte PNG: `Unexpected token`), so a download procedure
	// here could never return a file — only an error. Upload fails on the input
	// side, where a `File` cannot be JSON-encoded at all.
	//
	// An earlier revision declared `downloadObject` anyway, arguing that the
	// OpenAPI generator wants the path. That was wrong: a procedure whose every
	// invocation throws is not API completeness, it is a trap for the next caller,
	// and the generated document advertised a working endpoint that did not exist.
	//
	// The real routes are hand-written and remain the only ones:
	//   POST /api/v1/buckets/{bucket}/upload
	//   GET  /api/v1/buckets/{bucket}/download/{key}
	// The web client reaches both through `lib/client.ts`, never through `/rpc`.

	// ── File-manager operations ──────────────────────────────────────────────
	usage: os.input(z.object({ bucket: bucketName })).meta({
		method: "GET",
		path: "/api/v1/buckets/{bucket}/usage",
		summary: "Storage totals for one bucket",
	}),

	move: os
		.input(
			z.object({
				bucket: bucketName,
				// The controller validates these further (control characters, a
				// leading slash, backslashes). Length is checked here so an
				// obviously oversized key never makes the round trip.
				fromKey: objectPath,
				toKey: objectPath,
			})
		)
		.meta({
			method: "POST",
			path: "/api/v1/buckets/{bucket}/move",
			summary: "Rename an object or a folder",
		}),
};

/**
 * Root contract: every namespace on ONE object so `$context<AppRouterContext>()`
 * is applied once, at the root, rather than per namespace.
 *
 * A procedure added to any of these namespace objects appears in the typed
 * client and in the generated OpenAPI document without either being edited —
 * `presentation/orpc/openapi.ts` walks this object, not a hand-written list.
 */
export const rootContract = {
	bucket: bucketNamespace,
	me: meNamespace,
	organization: organizationNamespace,
	storage: storageNamespace,
	credentials: credentialsNamespace,
};

/** The builder produced by applying this app's context to the root contract. */
const typedBuilder = () => implement(rootContract).$context<AppRouterContext>();

/** Typed builder for this app's context, shared by every namespace builder. */
export type RouterBase = ReturnType<typeof typedBuilder>;

/** The bound bucket router shape. */
export type BucketRouter = ReturnType<ReturnType<RouterBase["bucket"]["router"]>>;

/**
 * Every controller function the router delegates to, grouped by namespace.
 *
 * One interface rather than five loose parameters, because `buildRouter` is the
 * composition root: a missing group must be a compile error at the call site
 * rather than a procedure that throws on its first invocation in production.
 */
export interface RouterHandlers {
	readonly bucket: BucketHandlers;
	readonly me: MeHandlers;
	readonly organization: OrganizationHandlers;
	readonly storage: StorageHandlers;
	readonly credentials: CredentialsHandlers;
}

/**
 * Bind the bucket contract's procedures to their controller delegates.
 *
 * Takes the typed builder as a parameter so the ROOT router can implement one
 * contract containing every namespace, applying `$context<AppRouterContext>()`
 * exactly once.
 *
 * @param base - The root builder.
 * @param handlers - The bucket and object controller functions.
 * @returns The bound `bucket` router.
 */
export const buildBucketRouter = (base: RouterBase, handlers: BucketHandlers): BucketRouter =>
	base.bucket.router({
		listBuckets: base.bucket.listBuckets.handler(async ({ context }) =>
			jsonPayload(await handlers.listBuckets(context.organizationId))
		),

		createBucket: base.bucket.createBucket.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.createBucket(
					controllerRequest(context, "/api/v1/buckets", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: input.name }),
					}),
					context.organizationId
				)
			)
		),

		deleteBucket: base.bucket.deleteBucket.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.deleteBucket(
					controllerRequest(context, `/api/v1/buckets/${encodeURIComponent(input.bucket)}`, {
						method: "DELETE",
					}),
					input.bucket,
					context.organizationId
				)
			)
		),

		listObjects: base.bucket.listObjects.handler(async ({ input, context }) => {
			const query = new URLSearchParams();
			if (input.prefix !== undefined) query.set("prefix", input.prefix);
			if (input.delimiter !== undefined) query.set("delimiter", input.delimiter);
			if (input.maxKeys !== undefined) query.set("max-keys", String(input.maxKeys));
			const qs = query.toString();
			const path = `/api/v1/buckets/${encodeURIComponent(input.bucket)}/objects`;
			return jsonPayload(
				await handlers.listObjects(
					controllerRequest(context, qs ? `${path}?${qs}` : path),
					input.bucket,
					context.organizationId
				)
			);
		}),

		copyObject: base.bucket.copyObject.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.copyObject(
					controllerRequest(context, `/api/v1/buckets/${encodeURIComponent(input.bucket)}/copy`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sourceKey: input.sourceKey,
							destKey: input.destKey,
							destBucket: input.destBucket,
						}),
					}),
					input.bucket,
					context.organizationId
				)
			)
		),

		deleteObject: base.bucket.deleteObject.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.deleteObject(
					controllerRequest(
						context,
						`/api/v1/buckets/${encodeURIComponent(input.bucket)}/${encodeKey(input.key)}`,
						{ method: "DELETE" }
					),
					input.bucket,
					input.key,
					context.organizationId
				)
			)
		),

		usage: base.bucket.usage.handler(async ({ input, context }) =>
			jsonPayload(await handlers.bucketUsage(input.bucket, context.organizationId))
		),

		move: base.bucket.move.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.moveObject(
					controllerRequest(context, `/api/v1/buckets/${encodeURIComponent(input.bucket)}/move`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ fromKey: input.fromKey, toKey: input.toKey }),
					}),
					input.bucket,
					context.organizationId
				)
			)
		),
	});
