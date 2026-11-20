/**
 * Percent-decoding that cannot throw.
 *
 * ## Why every S3 entry point needs this
 *
 * `decodeURIComponent` throws `URIError: URI malformed` on a lone `%`, an
 * incomplete escape (`%E0%A4`), or an invalid UTF-8 sequence — and a URL path is
 * entirely attacker-controlled. Every one of those throws used to escape as an
 * unhandled exception and surface as a 500:
 *
 *   GET /{bucket}/%ZZ          → 500 Internal Server Error
 *   GET /{bucket}/a/%E0%A4%A   → 500 Internal Server Error
 *   verifySignature(…/%ZZ)     → throws before any signature work
 *
 * A malformed escape is a CLIENT error and must be answered as one. It also
 * matters beyond the status code: aws-cli, rclone and the Docker registry
 * client each retry a 500, so a single mistyped key turns into a retry storm
 * against a request that can never succeed.
 *
 * ## Why `null` rather than a replacement character
 *
 * Substituting `\uFFFD` (what `decodeURI` would do) silently changes the object
 * key: the request would then address a DIFFERENT key than the client named, and
 * for a PUT or DELETE that is a write to the wrong object. Returning `null` makes
 * the caller reject the request, which is the only safe answer.
 */

/**
 * Percent-decodes a path segment, or returns `null` when the escape is malformed.
 *
 * @param value - Raw (still-encoded) path segment or URI.
 * @returns The decoded string, or `null` when it cannot be decoded losslessly.
 */
export const decodeUriComponentSafe = (value: string): string | null => {
	// A literal NUL byte truncates the value at the syscall layer on some
	// platforms, and no legitimate S3 key contains one.
	if (value.includes("\0")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return null;
	}
	// The check must be on the DECODED value as well: `%00` is a perfectly valid
	// escape that decodes to a NUL, so testing the input alone lets it through.
	if (decoded.includes("\0")) return null;
	return decoded;
};
