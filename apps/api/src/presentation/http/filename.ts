/**
 * Builds the `Content-Disposition` header value for a file download.
 *
 * ## Why this is not just `filename="<name>"`
 *
 * Fetch `Response` header values are ByteStrings: every character must be
 * ≤ 0xFF. A file name is user-controlled — it arrives as `File.name` on the
 * upload and is stored verbatim — so any non-Latin-1 name (`文件.txt`,
 * `файл.txt`, `cat😀.png`) makes `new Response(..., { headers })` THROW
 * `TypeError: Cannot convert argument to a ByteString`. The throw happens
 * inside the handler, so the client gets a 500 and the file is undownloadable
 * purely because of what it was named. Reproduced against this codebase with
 * the real app: `GET /f/<token>` → 500 for each of those names.
 *
 * The fix is the standard one from RFC 6266 §4.3 / RFC 5987: send an
 * ASCII-only `filename="…"` for every client that only understands that form,
 * and add `filename*=UTF-8''<percent-encoded>` carrying the real name. Clients
 * that understand `filename*` (every current browser and curl) prefer it; the
 * others still get a usable, honest approximation rather than an error.
 *
 * ## Why one function instead of a sanitizer per call site
 *
 * The previous `sanitizeFilenameHeader` returned a bare name and four call
 * sites each wrapped it in their own `inline; filename="…"` /
 * `attachment; filename="…"` template. That is how the ByteString crash
 * survived: the sanitizer looked like the safety net, but it only removed
 * quotes, backslashes and newlines — it never made the value ASCII, and it
 * could not, because the quoting was the caller's job. Owning the whole header
 * value here means the ASCII guarantee is made in the one place that emits it.
 */

/** A file name safe to place inside a quoted header parameter. */
export const sanitizeFilenameHeader = (fileName: string): string =>
	fileName
		// Quotes and backslashes would terminate or escape the quoted string.
		.replace(/[\\"]/g, "")
		// CR/LF are header injection; NUL and the rest of the C0 range plus DEL
		// are rejected by intermediaries and confuse every HTTP layer. `\p{Cc}`
		// is exactly that set (U+0000–U+001F and U+007F), written as a property
		// escape so the rule is readable rather than a pair of magic bounds.
		.replace(/\p{Cc}/gu, "");

/**
 * Reduces a name to characters that are legal in a header AND readable.
 *
 * Only reached for a non-ASCII name, where there is no faithful ASCII
 * representation. Non-ASCII runs collapse to a single `_` so `文件.txt` becomes
 * `_.txt` — the extension survives, which is what the fallback is for: a client
 * that ignores `filename*` should still save a file it can open.
 *
 * @param fileName - An already-sanitized file name.
 * @returns A printable-ASCII approximation.
 */
const asciiFallback = (fileName: string): string =>
	fileName
		// eslint-disable-next-line no-control-regex
		.replace(/[^\u0020-\u007e]+/g, "_")
		// `%` and `;` are not special inside a quoted string, but a bare `%` in a
		// fallback invites a client to try to percent-decode it.
		.replace(/[%;]/g, "_")
		.replace(/_{2,}/g, "_")
		.trim();

/**
 * Percent-encodes a name per RFC 5987 `attr-char`.
 *
 * Deliberately encodes MORE than the minimum: `attr-char` permits `!#$&+-.^_\`|~`
 * and alphanumerics, but leaving `&`, `'` or `*` raw makes the value fragile to
 * copy-paste and to any intermediary that re-parses it. Encoding everything
 * outside `A-Za-z0-9._-` is valid, unambiguous, and produces a value that
 * survives every transport.
 *
 * @param fileName - The real, sanitized file name.
 * @returns The `filename*` parameter body (without the `UTF-8''` prefix).
 */
const encodeRfc5987 = (fileName: string): string => {
	// `TextEncoder` first so a non-BMP character (an emoji) is encoded as its
	// UTF-8 bytes rather than as two lone surrogates, which `encodeURIComponent`
	// rejects outright.
	const bytes = new TextEncoder().encode(fileName);
	let out = "";
	for (const byte of bytes) {
		const char = String.fromCharCode(byte);
		out += /[A-Za-z0-9._-]/.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
};

/** Header value used when a name sanitizes away to nothing. */
const FALLBACK_NAME = "download";

/**
 * Builds a complete, transport-safe `Content-Disposition` value.
 *
 * @param type - `inline` to let the browser render, `attachment` to save.
 * @param fileName - The raw file name from the database or signed payload.
 * @returns A header value that is guaranteed to be a valid ByteString.
 */
export const contentDisposition = (type: "inline" | "attachment", fileName: string): string => {
	const sanitized = sanitizeFilenameHeader(fileName).trim();
	const name = sanitized.length > 0 ? sanitized : FALLBACK_NAME;

	// The common case: a name that is already printable ASCII. Emitting only
	// `filename=` keeps the header identical to what every client has always
	// received, and keeps `filename*` out of logs where it is just noise.
	// eslint-disable-next-line no-control-regex
	if (/^[\u0020-\u007e]*$/.test(name)) {
		return `${type}; filename="${name}"`;
	}

	// Non-ASCII: BOTH parameters. The fallback is what a client that does not
	// understand `filename*` will use, and it must never be empty.
	const fallback = asciiFallback(name);
	return `${type}; filename="${fallback.length > 0 ? fallback : FALLBACK_NAME}"; filename*=UTF-8''${encodeRfc5987(name)}`;
};
