/**
 * Adapters shared by every oRPC namespace.
 *
 * Two things every procedure needs and none of them should re-derive: how to
 * turn a controller's `Response` into an RPC payload, and how to build the
 * `Request` the `Request`-taking controllers expect. Both live here rather than
 * in `bucket.ts` because five namespaces now depend on them, and a second copy
 * of either would be a second place for the JSON contract to drift.
 */

import type { AppRouterContext } from "../context";

/**
 * Convert a controller's JSON `Response` into an RPC payload.
 *
 * The procedures return the controller response directly, which is wrong: oRPC
 * serialises the returned VALUE, and a `Response` serialises to `{}`. Verified —
 * the client received `{"json":{}}` before this adapter existed. So the body is
 * parsed here and the HTTP status is preserved by throwing on a non-2xx, which
 * oRPC maps to an error rather than a success carrying an error payload.
 *
 * WHY THE MESSAGE IS THE SERVER'S OWN TEXT
 *
 * The dashboard renders `error.message`, so the thrown message must be the
 * sentence the controller authored ("This workspace already holds 25
 * credentials…") rather than a status code the UI would have to translate. The
 * status still appears in the fallback message for a body that carries no
 * `error` field, so a malformed error response stays diagnosable.
 *
 * WHY NOT UPLOAD OR DOWNLOAD
 *
 * Those two cannot pass through here: `res.json()` destroys a binary body, and
 * chunked downloads are streamed rather than buffered. They stay on their
 * hand-written routes — `POST /api/v1/buckets/{bucket}/upload` and
 * `GET /api/v1/buckets/{bucket}/download/{key}` — and are reachable from the
 * same client through `lib/client.ts`.
 *
 * @param res - The controller's response.
 * @returns The parsed body when the response is 2xx.
 * @throws When the response is not 2xx, carrying the controller's error text.
 */
export const jsonPayload = async <T>(res: Response): Promise<T> => {
	if (!res.ok) {
		const body = await res.json().catch(() => undefined);
		throw new Error(errorMessageOf(res.status, body));
	}
	return (await res.json()) as T;
};

/**
 * Pick the most useful message out of a non-2xx controller body.
 *
 * A controller answers with `{ error }` on every documented failure path, so
 * that field is preferred. Everything else is a fallback rather than an error:
 * a body of the wrong shape must not hide which status was rejected.
 *
 * @param status - The HTTP status the controller responded with.
 * @param body - The parsed body, or `undefined` when it was not JSON.
 * @returns A message suitable for `Error`.
 */
const errorMessageOf = (status: number, body: unknown): string => {
	if (typeof body === "string" && body.length > 0) return body;
	if (body !== null && typeof body === "object" && "error" in body) {
		const { error } = body as { error?: unknown };
		if (typeof error === "string" && error.length > 0) return error;
	}
	return `controller responded ${status}: ${JSON.stringify(body ?? {})}`;
};

/**
 * Build the Web `Request` a controller expects.
 *
 * The controllers take a Request rather than typed arguments, so this adapts.
 * `baseUrl` comes from BASE_URL so that relative asset URLs inside responses
 * resolve exactly as they did over HTTP.
 *
 * WHERE `init.headers` MATTERS
 *
 * The session-scoped controllers (`handleMe`, `logout`, `logoutAll`, and the
 * organizations branch of the `/api/v1/*` dispatcher) read the caller's cookie
 * off `req.headers`. They cannot read it from `context` — that is not their
 * signature — so a procedure delegating to one of them must forward
 * `context.headers` here. Verified: a `Headers` instance survives `new
 * Request(…, { headers })` intact for both `cookie` and `authorization`.
 *
 * @param context - The procedure context, for `baseUrl`.
 * @param path - The `/api/v1/…` path the matching HTTP route uses.
 * @param init - Method, headers and body, when the controller reads them.
 * @returns A Request the controller can be called with.
 */
export const controllerRequest = (
	context: AppRouterContext,
	path: string,
	init?: RequestInit
): Request => new Request(new URL(path, context.baseUrl).href, init);
