import { implement } from "@orpc/server";
import type { AppRouterContext } from "../context";
import { type BucketHandlers, buildBucketRouter, type RouterBase, rootContract } from "./bucket";
import { buildCredentialsRouter, type CredentialsHandlers } from "./credentials";
import { buildMeRouter, type MeHandlers } from "./me";
import { buildOrganizationRouter, type OrganizationHandlers } from "./organization";
import { buildStorageRouter, type StorageHandlers } from "./storage";

/**
 * Root oRPC router (P2c, extended in P4).
 *
 * Scope is deliberately narrow: bucket and object MANAGEMENT, the session probe,
 * the organization list, storage accounting and credentials. The S3 wire
 * protocol and the public data plane (`POST /api/upload`, `GET /f/:public_id`)
 * stay as hand-written controllers — see presentation/http/app.ts for why
 * pushing XML through oRPC would be a mistake.
 *
 * Upload and DOWNLOAD also stay off this surface, for a reason that is not
 * stylistic: oRPC serialises both input and output as JSON. A procedure cannot
 * accept a `File`, and `jsonPayload` parses the controller's body with
 * `res.json()`, which destroys a binary one. They remain at
 * `POST /api/v1/buckets/{bucket}/upload` and
 * `GET /api/v1/buckets/{bucket}/download/{key}`, reached from the same web app
 * through `lib/client.ts`.
 *
 * Contract-first: `$context<AppRouterContext>()` is applied once, at the root,
 * rather than per namespace. The package-level `os.router` is typed against an
 * EMPTY context, so routing through it would erase the context every procedure
 * handler depends on.
 *
 * @param handlers - Every controller function, grouped by namespace. Passing
 *   them in rather than importing them here keeps this module free of the
 *   repository graph, which is what lets the web app import `AppRouter` as a
 *   TYPE without pulling server code into its bundle.
 * @returns The composed router.
 */
export const buildRouter = (handlers: {
	readonly bucket: BucketHandlers;
	readonly me: MeHandlers;
	readonly organization: OrganizationHandlers;
	readonly storage: StorageHandlers;
	readonly credentials: CredentialsHandlers;
}) => {
	const base: RouterBase = implement(rootContract).$context<AppRouterContext>();
	return base.router({
		bucket: buildBucketRouter(base, handlers.bucket),
		me: buildMeRouter(base, handlers.me),
		organization: buildOrganizationRouter(base, handlers.organization),
		storage: buildStorageRouter(base, handlers.storage),
		credentials: buildCredentialsRouter(base, handlers.credentials),
	});
};

/**
 * A fully-built router instance.
 *
 * `AppRouter` is what the web app imports as a TYPE to derive its typed client
 * (`AppRouterClient`). That import must be `import type` — it carries no server
 * code across the boundary, per the skill's non-negotiable rule #1.
 */
export type AppRouter = ReturnType<typeof buildRouter>;

/**
 * Every controller function the router delegates to, grouped by namespace.
 *
 * The canonical definition lives in `./bucket.ts` beside the root contract;
 * re-exported here because `buildRouter` is the entry point callers import and
 * requiring a second import just to name its parameter is noise.
 */
export type { RouterHandlers } from "./bucket";
/** Context every procedure receives. Re-exported for router consumers. */
export type { AppRouterContext };
