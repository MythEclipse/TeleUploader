/**
 * S3 credential management — the keys that make a tenant's buckets reachable
 * from `aws-cli`, `rclone` and the Docker registry client.
 *
 * WHY THIS NAMESPACE MATTERS MORE THAN ITS SIZE SUGGESTS
 *
 * The S3 surface resolves credentials from the database with no environment
 * fallback. A tenant with buckets and no key pair has buckets no client can
 * reach, so this panel is the difference between "storage" and "storage you can
 * mount". The typed surface is where the dashboard issues and revokes keys.
 *
 * THE SECRET IS RETURNED ONCE, AND TYPING DOES NOT CHANGE THAT
 *
 * `create` answers with `secretKey` in that one response; no later read can
 * reproduce it, because the listing path never selects the column. A typed
 * client makes that easy to misuse accidentally — so the interface below names
 * the field rather than hiding it, and the doc comment says it is one-shot.
 */

import { os } from "@orpc/server";
import { z } from "zod";
import type { RouterBase } from "./bucket";
import { controllerRequest, jsonPayload } from "./shared";

/** The controller functions this namespace delegates to. */
export interface CredentialsHandlers {
	/** `GET /api/v1/credentials` — the tenant's keys, never their secrets. */
	list: (organizationId: string) => Promise<Response>;
	/** `POST /api/v1/credentials` — issue a key pair. */
	create: (req: Request, organizationId: string) => Promise<Response>;
	/** `DELETE /api/v1/credentials/{id}` — revoke one key. */
	remove: (id: string, organizationId: string) => Promise<Response>;
}

/** Contract: routes, inputs and metadata, with no implementation. */
export const credentialsNamespace = {
	list: os.meta({
		method: "GET",
		path: "/api/v1/credentials",
		summary: "List the organization's S3 credentials",
	}),

	create: os
		.input(
			z.object({
				// Optional so the common case is one field: a caller that just wants
				// a key sends nothing and the controller applies a dated default. The
				// 120-character bound is the controller's own limit, mirrored so an
				// over-long label is rejected by the client instead of by a 400.
				label: z.string().trim().max(120).optional().describe("Human label for the key"),
			})
		)
		.meta({
			method: "POST",
			path: "/api/v1/credentials",
			// Says "returned once" in the summary because that is the fact a client
			// author most needs and least expects.
			summary: "Issue a new key pair (the secret is returned once)",
		}),

	remove: os
		.input(
			z.object({
				// Validated as a UUID by the controller before the query runs: a
				// non-UUID would reach Postgres as a cast error and surface as a 500
				// for what is really a bad request. The client checks the same shape.
				id: z.uuid().describe("Credential id"),
			})
		)
		.meta({
			method: "DELETE",
			path: "/api/v1/credentials/{id}",
			summary: "Revoke a credential",
		}),
};

/**
 * Bind the credential procedures to their controller delegates.
 *
 * `create` sends an empty JSON object when no label is supplied: the controller
 * treats an absent body and an empty object identically, but sending the object
 * means the request always carries the `content-type` the route expects.
 *
 * @param base - The root builder.
 * @param handlers - The credentials controller functions.
 * @returns The bound `credentials` router.
 */
export const buildCredentialsRouter = (base: RouterBase, handlers: CredentialsHandlers) =>
	base.credentials.router({
		list: base.credentials.list.handler(async ({ context }) =>
			jsonPayload(await handlers.list(context.organizationId))
		),

		create: base.credentials.create.handler(async ({ input, context }) =>
			jsonPayload(
				await handlers.create(
					controllerRequest(context, "/api/v1/credentials", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input.label === undefined ? {} : { label: input.label }),
					}),
					context.organizationId
				)
			)
		),

		remove: base.credentials.remove.handler(async ({ input, context }) =>
			jsonPayload(await handlers.remove(input.id, context.organizationId))
		),
	});
