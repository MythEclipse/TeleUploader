import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Self-contained download links, so small uploads need no database row.
 *
 * ## Why this exists
 *
 * `handleFileRedirect` used to begin with `fileRepository.findByPublicId(publicId)`,
 * which makes every download depend on Postgres. For a file host that is a poor
 * trade: the overwhelming majority of uploads are small files, and each one pays
 * for a row, a lookup, and a migration path just to remember a single opaque
 * string — `telegram_file_id`.
 *
 * `telegram_file_id` is the ONLY field that cannot be recomputed at request time.
 * Everything else (`mime_type`, `file_name`, `size_bytes`) is already known when
 * the upload completes. So instead of storing that string, this module puts it in
 * the URL and signs it. The URL becomes the capability token.
 *
 * ## What this deliberately does NOT do
 *
 * - **No encryption.** The payload is signed, not encrypted. `telegram_file_id`
 *   is visible to anyone holding the link, which is acceptable because a file_id
 *   is useless without the bot token — and the bot token never leaves the server
 *   (see `buildTelegramFileUrl`). Encrypting would add a key that has to be
 *   rotated without adding a real boundary, since the link is the secret either
 *   way.
 * - **No dedup, no listing, no soft-delete** for stateless uploads. All three are
 *   queries over rows that no longer exist. Large files keep the DB path, so the
 *   features still exist for the uploads that actually benefit from them.
 *
 * ## The signature shares a lifetime with the payload, on purpose
 *
 * The signing key is derived from the bot tokens by default (see `env.ts`). That
 * looks fragile until you notice the payload already depends on those tokens:
 * a Telegram `file_id` is only resolvable by the bot that created it, so rotating
 * the bot pool breaks the `file_id`s inside the URL regardless of how they are
 * signed. Deriving the key from the same tokens therefore adds no NEW failure
 * mode. `STATELESS_LINK_SECRET` exists to decouple the two when that matters.
 *
 * ## Wire format
 *
 * Compact binary, not JSON: this string is pasted into chat windows, so every
 * byte is a character the user has to look at. A 2-part payload is ~254 bytes,
 * which is ~339 base64url characters — under a third of the practical URL limit.
 *
 * ```
 * byte    version
 * varint  part count
 *   varint  file_id byte length
 *   bytes   file_id            (ASCII, ~90 chars)
 *   varint  original part size (bytes)
 *   byte    compression         (0 = none, 1 = gzip)
 * varint  total size (bytes)
 * varint  file name byte length
 * bytes   file name            (UTF-8)
 * varint  MIME type byte length
 * bytes   MIME type            (ASCII)
 * uint32  created-at, unix seconds
 * 12 bytes HMAC-SHA256(secret, everything above), truncated
 * ```
 *
 * The MAC covers every byte before it. Truncating to 96 bits is safe for this
 * purpose: a forgery attempt gets one shot per request, and the value being
 * protected is a public download, not a credential.
 */

/** Payload format version. Bump when the layout changes; old links then fall
 * through to the database path instead of being misparsed. */
const VERSION = 1;

/** Truncated HMAC length. 96 bits. */
const MAC_BYTES = 12;

/**
 * Upper bound on parts in one payload.
 *
 * The largest stateless file is `STATELESS_LINK_MAX_BYTES` (30 MB by default) and
 * the largest Telegram chunk is 19 MiB, so two parts is the real ceiling. The cap
 * exists to bound a hostile payload's part loop, not to describe normal traffic.
 */
const MAX_PARTS = 64;

/** Upper bound on any length-prefixed string, to bound hostile allocations. */
const MAX_STRING_BYTES = 512;

/** One stored chunk of a stateless file. */
export interface StatelessPart {
	/** Telegram file_id for this chunk. */
	telegramFileId: string;
	/** Original (pre-compression) size of this chunk in bytes. */
	sizeBytes: number;
	/** Compression applied to this chunk, or null. */
	compressionAlgorithm: "gzip" | null;
}

/** Everything needed to serve a file without touching the database. */
export interface StatelessPayload {
	/** Ordered chunks; a single-part file has exactly one. */
	parts: StatelessPart[];
	/** Total size in bytes of the reassembled file. */
	sizeBytes: number;
	/** Original file name, used for `Content-Disposition`. */
	fileName: string;
	/** MIME type, used for `Content-Type`. */
	mimeType: string;
	/** Creation time, unix seconds — drives `Last-Modified`. */
	createdAt: number;
}

/** Thrown internally when a payload cannot be parsed; never escapes this module. */
class MalformedPayload extends Error {}

/** Sequential reader with bounds checks on every access. */
class Cursor {
	private offset = 0;

	constructor(private readonly buf: Buffer) {}

	private get remaining(): number {
		return this.buf.length - this.offset;
	}

	byte(): number {
		if (this.remaining < 1) throw new MalformedPayload("truncated: byte");
		return this.buf[this.offset++];
	}

	/** LEB128 unsigned integer. */
	varint(): number {
		let result = 0;
		let shift = 0;
		// 8 bytes covers Number.MAX_SAFE_INTEGER; anything longer is hostile.
		for (let i = 0; i < 8; i++) {
			const b = this.byte();
			result += (b & 0x7f) * 2 ** shift;
			if ((b & 0x80) === 0) {
				if (!Number.isSafeInteger(result)) {
					throw new MalformedPayload("varint overflows a safe integer");
				}
				return result;
			}
			shift += 7;
		}
		throw new MalformedPayload("varint longer than 8 bytes");
	}

	bytes(length: number): Buffer {
		if (length < 0 || length > this.remaining) {
			throw new MalformedPayload(`truncated: wanted ${length} of ${this.remaining}`);
		}
		const out = this.buf.subarray(this.offset, this.offset + length);
		this.offset += length;
		return out;
	}

	string(): string {
		const length = this.varint();
		if (length > MAX_STRING_BYTES) {
			throw new MalformedPayload(`string of ${length} bytes exceeds ${MAX_STRING_BYTES}`);
		}
		return this.bytes(length).toString("utf8");
	}

	uint32(): number {
		const b = this.bytes(4);
		return b.readUInt32BE(0);
	}

	/** True when every byte has been consumed — trailing junk means tampering. */
	get exhausted(): boolean {
		return this.offset === this.buf.length;
	}
}

/** Appends a LEB128 unsigned integer. */
const pushVarint = (out: Buffer[], value: number): void => {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`cannot encode ${value} as a varint`);
	}
	let v = value;
	while (v >= 0x80) {
		out.push(Buffer.from([(v & 0x7f) | 0x80]));
		v = Math.floor(v / 128);
	}
	out.push(Buffer.from([v]));
};

/** Appends a length-prefixed UTF-8 string. */
const pushString = (out: Buffer[], value: string): void => {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length > MAX_STRING_BYTES) {
		throw new Error(`string of ${bytes.length} bytes exceeds ${MAX_STRING_BYTES}`);
	}
	pushVarint(out, bytes.length);
	out.push(bytes);
};

/**
 * Computes the truncated MAC over a payload body.
 *
 * @param body - Every encoded byte before the MAC.
 * @param secret - Signing key.
 * @returns The first {@link MAC_BYTES} bytes of the HMAC.
 */
const mac = (body: Buffer, secret: string): Buffer =>
	createHmac("sha256", secret).update(body).digest().subarray(0, MAC_BYTES);

/**
 * Encodes a payload into a URL-safe token.
 *
 * @param payload - The file's parts and metadata.
 * @param secret - Signing key; must be the same value used to decode.
 * @returns base64url token, without extension.
 * @throws {Error} When the payload cannot be represented (too many parts, empty
 *   part list, oversized strings).
 */
export const encodeStatelessLink = (payload: StatelessPayload, secret: string): string => {
	if (payload.parts.length === 0) {
		throw new Error("cannot encode a stateless link with no parts");
	}
	if (payload.parts.length > MAX_PARTS) {
		throw new Error(`stateless link supports at most ${MAX_PARTS} parts`);
	}

	const out: Buffer[] = [Buffer.from([VERSION])];
	pushVarint(out, payload.parts.length);
	for (const part of payload.parts) {
		pushString(out, part.telegramFileId);
		pushVarint(out, part.sizeBytes);
		out.push(Buffer.from([part.compressionAlgorithm === "gzip" ? 1 : 0]));
	}
	pushVarint(out, payload.sizeBytes);
	pushString(out, payload.fileName);
	pushString(out, payload.mimeType);
	const created = Buffer.alloc(4);
	created.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.floor(payload.createdAt))), 0);
	out.push(created);

	const body = Buffer.concat(out);
	return Buffer.concat([body, mac(body, secret)]).toString("base64url");
};

/**
 * Decodes and verifies a token.
 *
 * Returns `null` for ANY failure — bad base64, wrong version, bad MAC, truncated
 * body, trailing junk. That is deliberate: the caller uses `null` to mean "this is
 * not a stateless link, look it up in the database", so a legacy `/f/<nanoid>`
 * must not raise. Distinguishing "forged" from "not ours" would only give an
 * attacker a probe, and the operator cannot act on the difference anyway.
 *
 * @param token - base64url token, extension already stripped.
 * @param secret - Signing key.
 * @returns The payload, or `null` when the token is not a valid stateless link.
 */
export const decodeStatelessLink = (token: string, secret: string): StatelessPayload | null => {
	// Reject early on characters base64url never contains, so a legacy nanoid
	// costs a regex instead of a decode + MAC.
	if (token.length === 0 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;

	let raw: Buffer;
	try {
		raw = Buffer.from(token, "base64url");
	} catch {
		return null;
	}
	if (raw.length <= MAC_BYTES) return null;

	const body = raw.subarray(0, raw.length - MAC_BYTES);
	const provided = raw.subarray(raw.length - MAC_BYTES);
	const expected = mac(body, secret);
	// Lengths are equal by construction, but guard anyway: timingSafeEqual throws
	// on a mismatch, and a throw here would escape as a 500.
	if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

	try {
		const cursor = new Cursor(body);
		if (cursor.byte() !== VERSION) return null;

		const partCount = cursor.varint();
		if (partCount === 0 || partCount > MAX_PARTS) return null;

		const parts: StatelessPart[] = [];
		for (let i = 0; i < partCount; i++) {
			const telegramFileId = cursor.string();
			const sizeBytes = cursor.varint();
			const flag = cursor.byte();
			if (flag !== 0 && flag !== 1) return null;
			// An empty file_id would produce a URL that can never resolve; treat it
			// as malformed rather than letting it reach `getFileInfo`.
			if (telegramFileId.length === 0) return null;
			parts.push({
				telegramFileId,
				sizeBytes,
				compressionAlgorithm: flag === 1 ? "gzip" : null,
			});
		}

		const sizeBytes = cursor.varint();
		const fileName = cursor.string();
		const mimeType = cursor.string();
		const createdAt = cursor.uint32();

		// Trailing bytes mean the body was not produced by `encodeStatelessLink`.
		if (!cursor.exhausted) return null;

		return { parts, sizeBytes, fileName, mimeType, createdAt };
	} catch (error: unknown) {
		// Only the parse failures this module raises are expected here; anything
		// else is a genuine bug and should surface as a 500, not as a silent 404.
		if (error instanceof MalformedPayload) return null;
		throw error;
	}
};

/**
 * Builds the public download URL for a stateless file.
 *
 * The extension is appended so the link reads as a file rather than a wall of
 * base64 — that is the entire reason it is there. `Content-Type` and
 * `Content-Disposition` both come from the signed payload, so a link whose
 * extension was stripped or renamed still serves correctly; nothing depends on it.
 *
 * The extension is sanitised to `[a-z0-9]{1,16}`: it is derived from a user-supplied
 * file name, and an unchecked value could inject `?`, `#`, or `/` into the URL and
 * change which path or query the client actually requests.
 *
 * @param baseUrl - Server origin, with or without a trailing slash.
 * @param token - The encoded payload.
 * @param fileName - File name to derive the extension from.
 * @returns Absolute URL of the form `${baseUrl}/f/<token>.<ext>`.
 */
export const buildStatelessDownloadUrl = (
	baseUrl: string,
	token: string,
	fileName: string
): string => {
	const origin = baseUrl.replace(/\/+$/, "");
	const dot = fileName.lastIndexOf(".");
	const raw = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
	const extension = /^[a-z0-9]{1,16}$/.test(raw) ? raw : "";
	return extension ? `${origin}/f/${token}.${extension}` : `${origin}/f/${token}`;
};

/**
 * Splits a `/f/<token>.<ext>` route parameter into token and extension.
 *
 * The token is base64url, which never contains `.`, so the FIRST dot is the
 * separator. Splitting on the first rather than the last keeps `archive.tar.gz`
 * from being read as token `...archive.tar`.
 *
 * The extension is cosmetic — `Content-Type` and `Content-Disposition` both come
 * from the payload — so it is not validated against the file name. It exists so a
 * pasted link reads as a file rather than as a wall of base64.
 *
 * @param publicId - The raw `:public_id` route parameter.
 * @returns The token and the (possibly empty) extension, lowercased.
 */
export const splitStatelessToken = (publicId: string): { token: string; extension: string } => {
	const dot = publicId.indexOf(".");
	if (dot === -1) return { token: publicId, extension: "" };
	return {
		token: publicId.slice(0, dot),
		extension: publicId.slice(dot + 1).toLowerCase(),
	};
};
