import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodeStatelessLink,
	encodeStatelessLink,
	type StatelessPayload,
} from "../src/application/shared/utils/stateless-link";

/**
 * Version 3: the payload is ENCRYPTED, not merely signed.
 *
 * ## What this change is and is not for
 *
 * v1 and v2 verified an HMAC before parsing, so tampering was already impossible.
 * Encrypting therefore buys exactly one thing: the contents stop being readable by
 * whoever holds the link. Measured before this change, `base64 -d` on a production
 * token yielded `verify.gif`, `image/gif`, and the full `telegram_file_id`.
 *
 * The tests below are split accordingly:
 *
 *   - confidentiality: the fields must NOT appear in the token
 *   - integrity:       tampering must still fail (this is not new, but v3 must
 *                      not REGRESS it while moving to a different primitive)
 *   - compatibility:   v1 and v2 links must keep working, because they are already
 *                      pasted into chats and cannot be re-issued
 */

const SECRET = "test-secret";

const FILE_ID = "BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF9mb3JfZTJlX3Rlc3Rpbmc";

const payload = (overrides: Partial<StatelessPayload> = {}): StatelessPayload => ({
	parts: [{ telegramFileId: FILE_ID, sizeBytes: 1024, compressionAlgorithm: null }],
	sizeBytes: 1024,
	fileName: "laporan-rahasia.pdf",
	mimeType: "application/pdf",
	createdAt: 1_700_000_000,
	...overrides,
});

/** Base64url-decodes a token and returns the raw bytes. */
const rawBytes = (token: string): Buffer => Buffer.from(token, "base64url") as unknown as Buffer;

describe("v3 encrypts the payload", () => {
	it("writes version 3 as the first byte", () => {
		const token = encodeStatelessLink(payload(), SECRET);
		expect(rawBytes(token)[0]).toBe(3);
	});

	it("hides the file name, MIME type and file_id from anyone with the link", () => {
		// THE POINT OF THE WHOLE CHANGE. Before v3 this failed for all three.
		const token = encodeStatelessLink(payload(), SECRET);
		const raw = rawBytes(token);
		// Search the raw bytes, not the base64 text: a match in either would mean
		// the field is recoverable without the key.
		for (const secret of ["laporan-rahasia.pdf", "application/pdf", FILE_ID]) {
			expect(raw.includes(Buffer.from(secret, "utf8")), `leaked: ${secret}`).toBe(false);
		}
	});

	it("does not leak a long run of the file_id either", () => {
		// A field could survive in fragments if the encoding were, say, a naive
		// XOR. Assert no 12-byte window of the file_id appears.
		const raw = rawBytes(encodeStatelessLink(payload(), SECRET));
		const needle = Buffer.from(FILE_ID, "utf8");
		for (let i = 0; i + 12 <= needle.length; i++) {
			expect(raw.includes(needle.subarray(i, i + 12))).toBe(false);
		}
	});

	it("still round-trips every field", () => {
		const decoded = decodeStatelessLink(encodeStatelessLink(payload(), SECRET), SECRET);
		expect(decoded?.fileName).toBe("laporan-rahasia.pdf");
		expect(decoded?.mimeType).toBe("application/pdf");
		expect(decoded?.sizeBytes).toBe(1024);
		expect(decoded?.createdAt).toBe(1_700_000_000);
		expect(decoded?.parts[0]?.telegramFileId).toBe(FILE_ID);
	});

	it("produces a DIFFERENT token for the same payload every time", () => {
		// A random nonce per token. If this ever fails, the nonce is fixed or
		// derived from the payload — which under GCM is catastrophic: two messages
		// under one key/nonce pair leak the XOR of their plaintexts AND allow
		// forgery of arbitrary ciphertexts.
		const a = encodeStatelessLink(payload(), SECRET);
		const b = encodeStatelessLink(payload(), SECRET);
		expect(a).not.toBe(b);
		// Both must still decode to the same thing.
		expect(decodeStatelessLink(a, SECRET)?.fileName).toBe("laporan-rahasia.pdf");
		expect(decodeStatelessLink(b, SECRET)?.fileName).toBe("laporan-rahasia.pdf");
	});
});

describe("v3 rejects tampering and wrong keys", () => {
	const flipBit = (buf: Buffer, index: number): Buffer => {
		const copy = Buffer.from(buf);
		copy[index] ^= 0x01;
		return copy;
	};

	it("rejects a flipped bit anywhere in the ciphertext", () => {
		const raw = rawBytes(encodeStatelessLink(payload(), SECRET));
		// Walk the sealed body; every single-bit change must fail the GCM tag.
		for (let i = 1 + 12 + 16; i < raw.length; i++) {
			expect(
				decodeStatelessLink(flipBit(raw, i).toString("base64url"), SECRET),
				`byte ${i} was not authenticated`
			).toBeNull();
		}
	});

	it("rejects a flipped bit in the nonce or the tag", () => {
		const raw = rawBytes(encodeStatelessLink(payload(), SECRET));
		for (const i of [1, 5, 12, 1 + 12, 1 + 12 + 15]) {
			expect(decodeStatelessLink(flipBit(raw, i).toString("base64url"), SECRET)).toBeNull();
		}
	});

	it("rejects a token encrypted with a different secret", () => {
		const token = encodeStatelessLink(payload(), "some-other-secret");
		expect(decodeStatelessLink(token, SECRET)).toBeNull();
	});

	it("rejects a truncated v3 token", () => {
		const raw = rawBytes(encodeStatelessLink(payload(), SECRET));
		for (const cut of [2, 1 + 12, 1 + 12 + 16, raw.length - 1]) {
			expect(decodeStatelessLink(raw.subarray(0, cut).toString("base64url"), SECRET)).toBeNull();
		}
	});

	it("rejects a v3 token with trailing junk appended", () => {
		// GCM authenticates length too, so extra bytes cannot be ignored.
		const raw = rawBytes(encodeStatelessLink(payload(), SECRET));
		const extended = Buffer.concat([raw, Buffer.from([0x00])]);
		expect(decodeStatelessLink(extended.toString("base64url"), SECRET)).toBeNull();
	});
});

/**
 * A v2 link is already sitting in a chat window somewhere. Deploying v3 must not
 * break it, and it must not be "upgraded" into something unreadable.
 *
 * Built by hand rather than through `encodeStatelessLink`, which now emits v3 —
 * using the encoder here would test the encoder against itself and prove nothing.
 */
describe("version 2 links still decode", () => {
	const pushVarint = (out: Buffer[], v: number): void => {
		let n = v;
		while (n >= 0x80) {
			out.push(Buffer.from([(n & 0x7f) | 0x80]));
			n = Math.floor(n / 128);
		}
		out.push(Buffer.from([n]));
	};
	const pushStr = (out: Buffer[], s: string): void => {
		const b = Buffer.from(s, "utf8");
		pushVarint(out, b.length);
		out.push(b);
	};

	/** Hand-builds a v2 token exactly as the v2 encoder would have. */
	const buildV2 = (secret: string, binaryFileId = true): string => {
		const out: Buffer[] = [Buffer.from([2])];
		pushVarint(out, 1);
		// flags: bit1 = file_id stored as binary
		out.push(Buffer.from([binaryFileId ? 2 : 0]));
		if (binaryFileId) {
			const fid = Buffer.from(FILE_ID, "base64url");
			pushVarint(out, fid.length);
			out.push(fid);
		} else {
			pushStr(out, FILE_ID);
		}
		pushVarint(out, 1024);
		pushVarint(out, 1024);
		pushStr(out, "old-v2.pdf");
		pushStr(out, "application/pdf");
		const created = Buffer.alloc(4);
		created.writeUInt32BE(1_700_000_000, 0);
		out.push(created);

		const body = Buffer.concat(out);
		// v2 signed the WHOLE body including the version byte.
		const mac = createHmac("sha256", secret).update(body).digest().subarray(0, 12);
		return Buffer.concat([body, mac]).toString("base64url");
	};

	it("decodes a v2 payload with a binary file_id", () => {
		const decoded = decodeStatelessLink(buildV2(SECRET), SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded?.fileName).toBe("old-v2.pdf");
		expect(decoded?.parts[0]?.telegramFileId).toBe(FILE_ID);
	});

	it("decodes a v2 payload with a text file_id", () => {
		const decoded = decodeStatelessLink(buildV2(SECRET, false), SECRET);
		expect(decoded?.parts[0]?.telegramFileId).toBe(FILE_ID);
	});

	it("still rejects a v2 token whose MAC does not match", () => {
		const token = buildV2(SECRET);
		const raw = rawBytes(token);
		raw[raw.length - 1] ^= 0x01;
		expect(decodeStatelessLink(raw.toString("base64url"), SECRET)).toBeNull();
	});

	it("v2 tokens remain readable in the clear, and that is expected", () => {
		// Documenting the honest limitation: v2 links CANNOT be made confidential
		// retroactively. Their payload is in the URL. Anyone who wants the metadata
		// hidden must re-upload to get a v3 link.
		const raw = rawBytes(buildV2(SECRET, false));
		expect(raw.includes(Buffer.from("old-v2.pdf", "utf8"))).toBe(true);
	});
});
