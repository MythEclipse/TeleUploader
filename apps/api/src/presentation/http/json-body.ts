/**
 * Request-body JSON parsing that reports "unparseable" instead of throwing.
 *
 * ## Why
 *
 * `await req.json()` throws `SyntaxError` on a malformed body. Two handlers in
 * `web-api-controller.ts` called it unguarded, so `POST /api/v1/buckets` with
 * the body `{not json` escaped the handler as an unhandled exception:
 *
 *   POST /api/v1/buckets          → 500 Internal Server Error
 *   POST /api/v1/buckets/b/copy   → 500 Internal Server Error
 *
 * A malformed body is a 400, not a server fault. It is also trivially reachable
 * by anything that speaks HTTP, so a 500 here is both wrong and noisy: it pages
 * whoever watches the error rate for a request that carries no credentials at
 * all.
 *
 * ## Why `{ ok: false }` rather than a nullable value
 *
 * `null` is a VALID JSON body. Returning `null` for both `null` and `{not json`
 * would let a handler that checks `body?.name` treat a malformed body as the
 * empty one — a silent wrong answer rather than a rejection. The discriminant
 * forces the caller to distinguish them.
 */

/** Outcome of parsing a JSON request body. */
export type JsonBodyResult = { ok: true; value: unknown } | { ok: false };

/**
 * Reads and parses a JSON request body without throwing.
 *
 * An EMPTY body is reported as `{ ok: true, value: undefined }`, not as a
 * failure: several endpoints accept no body at all, and `req.json()` on an
 * empty stream throws the same `SyntaxError` a malformed body does. Callers that
 * require a body reject `undefined` through their own schema.
 *
 * @param req - The incoming request.
 * @returns The parsed value, or `{ ok: false }` when the body is not JSON.
 */
export const readJsonBody = async (req: Request): Promise<JsonBodyResult> => {
	// Read as text first so "empty" and "malformed" can be told apart, and so a
	// body that is only whitespace is treated as empty rather than as an error.
	let raw: string;
	try {
		raw = await req.text();
	} catch {
		return { ok: false };
	}
	if (raw.trim().length === 0) return { ok: true, value: undefined };

	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false };
	}
};
