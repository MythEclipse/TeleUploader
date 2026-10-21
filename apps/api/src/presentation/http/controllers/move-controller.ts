import { z } from "zod";
import { DestinationExistsError } from "../../../application/shared/utils/credentials";
import { bucketRepository, fileManagementRepository } from "../../../infrastructure/di";
import { getErrorMessage } from "../../../infrastructure/file";
import logger from "../../../infrastructure/observability/logger";

/**
 * Move and rename — the operations that turn a listing into a file manager.
 *
 * ## Why one handler serves single objects and folders
 *
 * A folder is not a stored entity. Keys like `photos/a.jpg` are flat rows whose
 * key happens to contain a slash, so "rename the folder" and "rename the file"
 * are the same operation over one row or over a prefix. Splitting them into two
 * routes would duplicate the destination validation, the collision handling and
 * the tenant check — three places to get the same thing wrong.
 *
 * ## Destination keys are validated, not trusted
 *
 * `toKey` arrives from the client and becomes a database value that the listing,
 * the S3 surface and the share-link route all read back. Length and control
 * characters are constrained here; a key that is empty, absolute-looking or
 * contains a NUL would either break the SQL or produce an object no client can
 * address.
 */

/** Longest S3 object key this API accepts. Matches the S3 limit. */
const MAX_KEY_LENGTH = 1024;

/**
 * Body of `POST /api/v1/buckets/{bucket}/move`.
 *
 * `toKey` naming a prefix (trailing `/`) moves the whole folder; naming a plain
 * key moves one object. `fromKey` is the same, so a caller renames a folder by
 * sending `photos/` -> `pics/`.
 */
const MoveSchema = z.object({
	fromKey: z.string().min(1).max(MAX_KEY_LENGTH),
	toKey: z.string().min(1).max(MAX_KEY_LENGTH),
});

/**
 * Returns a successful JSON Response.
 *
 * @param data - The JSON-serialisable body.
 * @param status - HTTP status code (default 200).
 * @returns A JSON Response.
 */
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/**
 * Returns a JSON error Response.
 *
 * @param error - The error message.
 * @param status - HTTP status code.
 * @returns A JSON error Response.
 */
const jsonError = (error: string, status: number): Response => Response.json({ error }, { status });

/** Route parameters for the move handler. */
type RouteParams = { bucket?: string };

/**
 * Whether a key contains characters that must never reach a database value or a
 * URL path.
 *
 * NUL and the C0 control range are excluded because they terminate strings in
 * PostgreSQL and confuse every HTTP layer between here and the client. A
 * backslash is excluded because Windows clients treat it as a separator, so a
 * key containing one addresses different objects in different tools.
 *
 * A leading `/` is refused separately: S3 keys have no root, and accepting it
 * would create a key whose listing prefix never matches.
 *
 * The control range is tested numerically rather than with a regex character
 * class, because `noControlCharactersInRegex` is right that a literal control
 * character in a pattern is almost always a mistake — here the check IS the
 * point, and comparing code points says so without ambiguity.
 *
 * @param key - The candidate key.
 * @returns `true` when the key is safe to store.
 */
const isStorableKey = (key: string): boolean => {
	if (key.startsWith("/") || key.includes("\\")) return false;
	return ![...key].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	});
};

/**
 * `POST /api/v1/buckets/{bucket}/move` — rename an object or a folder.
 *
 * @param req - The incoming request with `{ fromKey, toKey }`.
 * @param params - Route parameters containing the bucket name.
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with what moved, or an error.
 */
export const handleMoveObjectV1 = async (
	req: Request,
	params: RouteParams,
	organizationId: string
): Promise<Response> => {
	const bucket = await bucketRepository.findByName(params.bucket!, organizationId);
	if (!bucket) return jsonError("Bucket not found", 404);

	let rawBody: unknown;
	try {
		rawBody = await req.json();
	} catch {
		return jsonError("Expected a JSON body with fromKey and toKey", 400);
	}

	const parsed = MoveSchema.safeParse(rawBody);
	if (!parsed.success) {
		return jsonError(
			`Invalid move: fromKey and toKey are required, at most ${MAX_KEY_LENGTH} characters`,
			400
		);
	}

	const { fromKey, toKey } = parsed.data;
	if (!isStorableKey(fromKey) || !isStorableKey(toKey)) {
		return jsonError("Invalid key: no leading slash, control characters or backslashes", 400);
	}
	if (fromKey === toKey) {
		// A no-op move is not an error worth failing, but it must not be reported
		// as a change that happened — the UI re-reads the listing after a move and
		// would otherwise animate a row that never moved.
		return json({ moved: 0, fromKey, toKey, kind: "none" });
	}
	if (toKey.startsWith(fromKey.endsWith("/") ? fromKey : `${fromKey}/`)) {
		return jsonError("Cannot move a folder into itself", 400);
	}

	try {
		const isFolderMove = fromKey.endsWith("/") || toKey.endsWith("/");
		if (isFolderMove) {
			const moved = await fileManagementRepository.movePrefix(bucket.id, fromKey, toKey);
			if (moved === 0) return jsonError("Nothing found at that prefix", 404);
			return json({ moved, fromKey, toKey, kind: "folder" });
		}

		const result = await fileManagementRepository.moveObject(bucket.id, fromKey, toKey);
		if (result === "missing") return jsonError("Object not found", 404);
		if (result === "destination-exists") {
			return jsonError(`"${toKey}" already exists in this bucket`, 409);
		}
		return json({ moved: 1, fromKey, toKey, kind: "object" });
	} catch (error: unknown) {
		if (error instanceof DestinationExistsError) {
			return jsonError(error.message, 409);
		}
		logger.error("Move failed", {
			bucket: bucket.name,
			fromKey,
			toKey,
			error: getErrorMessage(error),
		});
		return jsonError("Move failed", 500);
	}
};
