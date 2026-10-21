/**
 * Storage accounting, search and the S3 endpoint facts.
 *
 * WHY THESE THREE SHARE A NAMESPACE
 *
 * They are the reads that no single-object endpoint can answer, and they are
 * all scoped by the caller's organization rather than by a bucket: the
 * dashboard header needs a tenant-wide total, the search box needs a
 * cross-bucket query, and the credentials panel needs to know which endpoint a
 * client should be pointed at. Grouping them here mirrors
 * `storage-controller.ts`, so a reader moving between the two files does not
 * have to re-learn the map.
 *
 * WHY `endpoint` TAKES NO INPUT AND STILL NEEDS NO CONTEXT
 *
 * `handleStorageEndpointV1()` reads `config.baseUrl` and `config.s3DefaultRegion`
 * — server facts, identical for every caller. It is declared with no input, so
 * it is called with no argument, exactly like `listBuckets`.
 */

import { os } from "@orpc/server";
import { z } from "zod";
import type { RouterBase } from "./bucket";
import { controllerRequest, jsonPayload } from "./shared";

/** The controller functions this namespace delegates to. */
export interface StorageHandlers {
	/** `GET /api/v1/storage` — tenant-wide and per-bucket totals. */
	usage: (organizationId: string) => Promise<Response>;
	/** `GET /api/v1/storage/endpoint` — the S3 endpoint and region. */
	endpoint: () => Response;
	/** `GET /api/v1/search?q=…` — cross-bucket object search. */
	search: (req: Request, organizationId: string) => Promise<Response>;
}

/** Contract: routes, inputs and metadata, with no implementation. */
export const storageNamespace = {
	usage: os.meta({
		method: "GET",
		path: "/api/v1/storage",
		summary: "Storage totals for the caller's organization",
	}),

	endpoint: os.meta({
		method: "GET",
		path: "/api/v1/storage/endpoint",
		summary: "S3 endpoint, region and whether the S3 surface is usable",
	}),

	search: os
		.input(
			z.object({
				// Required, not optional: an empty query would return the newest N
				// objects across the tenant, which is a recents view wearing the
				// same URL. The controller answers 400 for an empty string, and the
				// typed client rejects it before the request is even built.
				q: z.string().min(1).describe("Key fragment to search for"),
			})
		)
		.meta({
			method: "GET",
			path: "/api/v1/search",
			summary: "Search objects by key across every bucket",
		}),
};

/**
 * Bind the storage procedures to their controller delegates.
 *
 * @param base - The root builder.
 * @param handlers - The storage controller functions.
 * @returns The bound `storage` router.
 */
export const buildStorageRouter = (base: RouterBase, handlers: StorageHandlers) =>
	base.storage.router({
		usage: base.storage.usage.handler(async ({ context }) =>
			jsonPayload(await handlers.usage(context.organizationId))
		),

		// Synchronous in the controller, wrapped here only because `jsonPayload`
		// is async — the alternative would be a second, non-JSON code path for one
		// procedure, and the payload is JSON either way.
		endpoint: base.storage.endpoint.handler(async () => jsonPayload(handlers.endpoint())),

		search: base.storage.search.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.search(
					controllerRequest(
						context,
						`/api/v1/search?${new URLSearchParams({ q: input.q }).toString()}`
					),
					context.organizationId
				)
			)
		),
	});
