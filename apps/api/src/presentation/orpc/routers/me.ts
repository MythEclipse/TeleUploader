/**
 * Session procedures: who is calling, and how to end that session.
 *
 * WHY THESE LIVE ON THE TYPED SURFACE AT ALL
 *
 * The dashboard's very first question on every load is "is there a session, and
 * what may it reach". Answering it over `/api/v1/auth/me` means the SPA hand-
 * casts the body, and a renamed field is discovered at runtime instead of at
 * compile time. Routed through oRPC, `rpc.me.getMe()` is checked against the
 * server's own type.
 *
 * WHY THE CALLER'S HEADERS ARE FORWARDED
 *
 * `handleMe` resolves the session from the incoming `cookie` (or the bearer
 * token) — it takes a `Request`, not an organization id. The cookie cannot be
 * read from `AppRouterContext` because the controller has no way to accept it,
 * so the procedure passes `context.headers` through. Without that, every
 * procedure here would answer 401 to a caller whose browser is holding a valid
 * session: the oRPC call and the REST call would disagree about identity, which
 * is the defect class this whole surface exists to close.
 *
 * Login is deliberately ABSENT. It is a Google OAuth redirect chain
 * (`/api/v1/auth/google/start` → Google → `/api/v1/auth/google/callback`), and a
 * redirect cannot cross a JSON RPC boundary — the browser has to follow it.
 */

import { os } from "@orpc/server";
import type { RouterBase } from "./bucket";
import { controllerRequest, jsonPayload } from "./shared";

/** The controller functions this namespace delegates to. */
export interface MeHandlers {
	/** `GET /api/v1/auth/me` — the session probe. */
	getMe: (req: Request) => Promise<Response>;
	/** `POST /api/v1/auth/logout` — revoke the current session. */
	logout: (req: Request) => Promise<Response>;
	/** `POST /api/v1/auth/logout-all` — revoke every session for the caller. */
	logoutAll: (req: Request) => Promise<Response>;
}

/** Contract: routes and metadata, with no implementation. */
export const meNamespace = {
	getMe: os.meta({
		method: "GET",
		path: "/api/v1/auth/me",
		summary: "Current session and the organizations it can reach",
	}),

	logout: os.meta({
		method: "POST",
		path: "/api/v1/auth/logout",
		summary: "Revoke the current session and clear the cookie",
	}),

	logoutAll: os.meta({
		method: "POST",
		path: "/api/v1/auth/logout-all",
		summary: "Revoke every session belonging to the caller",
	}),
};

/**
 * Bind the session procedures to their controller delegates.
 *
 * @param base - The root builder, so `$context<AppRouterContext>()` is applied
 *   once for the whole contract rather than once per namespace.
 * @param handlers - The auth controller functions.
 * @returns The bound `me` router.
 */
export const buildMeRouter = (base: RouterBase, handlers: MeHandlers) =>
	base.me.router({
		getMe: base.me.getMe.handler(async ({ context }) =>
			jsonPayload(
				await handlers.getMe(
					controllerRequest(context, "/api/v1/auth/me", { headers: context.headers })
				)
			)
		),

		// Neither call takes an input, so neither is called with an argument at
		// the client — the same shape as `listBuckets`. Both forward the caller's
		// headers, because the session being revoked is identified by the cookie
		// on the request, not by the organization in the context.
		logout: base.me.logout.handler(async ({ context }) =>
			jsonPayload(
				await handlers.logout(
					controllerRequest(context, "/api/v1/auth/logout", {
						method: "POST",
						headers: context.headers,
					})
				)
			)
		),

		logoutAll: base.me.logoutAll.handler(async ({ context }) =>
			jsonPayload(
				await handlers.logoutAll(
					controllerRequest(context, "/api/v1/auth/logout-all", {
						method: "POST",
						headers: context.headers,
					})
				)
			)
		),
	});
