/**
 * The organization switcher's data source, on the typed surface.
 *
 * WHY IT DELEGATES TO THE DISPATCHER RATHER THAN A CONTROLLER
 *
 * There is no `handleListOrganizationsV1`. The route is one branch inside
 * `dispatchWithScope` in `web-api-controller.ts`, and it is the branch that
 * decides WHO the caller is before answering: a real session gets its
 * membership rows, an open deployment gets the bootstrap organization, and a
 * signed-out caller under configured auth gets nothing. Re-implementing that
 * decision here would be a second definition of "which tenants may this caller
 * see", and the two would eventually disagree — the switcher would render a
 * selection the API then refuses.
 *
 * So the procedure calls the same dispatcher the HTTP route calls, with the
 * caller's own headers attached. One implementation, two transports.
 *
 * The response is `{ organizations }` — an array of memberships, never a
 * cross-tenant directory. There is deliberately no "list every organization"
 * route anywhere in this codebase, and this namespace does not add one.
 */

import { os } from "@orpc/server";
import type { RouterBase } from "./bucket";
import { controllerRequest, jsonPayload } from "./shared";

/** The controller function this namespace delegates to. */
export interface OrganizationHandlers {
	/**
	 * `GET /api/v1/organizations` — the organizations the CALLER may switch to.
	 *
	 * Takes the incoming `Request` because the answer is a function of the
	 * session it carries, not of the organization the request is already scoped
	 * to.
	 */
	listOrganizations: (req: Request) => Promise<Response>;
}

/** Contract: route and metadata, with no implementation. */
export const organizationNamespace = {
	list: os.meta({
		method: "GET",
		path: "/api/v1/organizations",
		summary: "Organizations the caller may switch to",
	}),
};

/**
 * Bind the organization procedures to their controller delegate.
 *
 * @param base - The root builder.
 * @param handlers - The dispatcher binding.
 * @returns The bound `organization` router.
 */
export const buildOrganizationRouter = (base: RouterBase, handlers: OrganizationHandlers) =>
	base.organization.router({
		// No input, so no argument at the call site — the same shape as
		// `listBuckets`. The headers are what make the answer specific to the
		// caller.
		list: base.organization.list.handler(async ({ context }) =>
			jsonPayload(
				await handlers.listOrganizations(
					controllerRequest(context, "/api/v1/organizations", { headers: context.headers })
				)
			)
		),
	});
