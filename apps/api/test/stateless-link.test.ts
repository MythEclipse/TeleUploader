import { describe, expect, it } from "vitest";
import {
	buildStatelessDownloadUrl,
	decodeStatelessLink,
	encodeStatelessLink,
	type StatelessPayload,
	splitStatelessToken,
} from "../src/application/shared/utils/stateless-link";

/**
 * These tests pin the properties that make a URL safe to serve WITHOUT a
 * database lookup. Every one of them corresponds to a way the feature could fail
 * open, so they are written against behaviour rather than against the byte layout
 * (which is free to change behind the version byte).
 */

const SECRET = "test-secret";

const payload = (overrides: Partial<StatelessPayload> = {}): StatelessPayload => ({
	parts: [
		{
			telegramFileId: "BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF8wMDE",
			sizeBytes: 1024,
			compressionAlgorithm: null,
		},
	],
	sizeBytes: 1024,
	fileName: "report.pdf",
	mimeType: "application/pdf",
	createdAt: 1_700_000_000,
	...overrides,
});

describe("stateless link round-trip", () => {
	it("returns exactly what was encoded", () => {
		const encoded = encodeStatelessLink(payload(), SECRET);
		const decoded = decodeStatelessLink(encoded, SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded?.fileName).toBe("report.pdf");
		expect(decoded?.mimeType).toBe("application/pdf");
		expect(decoded?.sizeBytes).toBe(1024);
		expect(decoded?.createdAt).toBe(1_700_000_000);
		expect(decoded?.parts).toHaveLength(1);
		expect(decoded?.parts[0]?.telegramFileId).toBe("BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF8wMDE");
	});

	it("round-trips a multi-part file, preserving order and per-part metadata", () => {
		const encoded = encodeStatelessLink(
			payload({
				parts: [
					{ telegramFileId: "part-one", sizeBytes: 19 * 1024 * 1024, compressionAlgorithm: "gzip" },
					{ telegramFileId: "part-two", sizeBytes: 5 * 1024 * 1024, compressionAlgorithm: null },
				],
				sizeBytes: 24 * 1024 * 1024,
			}),
			SECRET
		);

		const decoded = decodeStatelessLink(encoded, SECRET);
		expect(decoded?.parts.map((p) => p.telegramFileId)).toEqual(["part-one", "part-two"]);
		// Compression is per part, and must survive: a part that was gzipped and is
		// served without inflating is a corrupt download.
		expect(decoded?.parts[0]?.compressionAlgorithm).toBe("gzip");
		expect(decoded?.parts[1]?.compressionAlgorithm).toBeNull();
	});

	it("produces a URL-safe token with no characters that need escaping", () => {
		const encoded = encodeStatelessLink(payload(), SECRET);
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("handles non-ASCII file names", () => {
		const encoded = encodeStatelessLink(payload({ fileName: "laporan keuangan 日本.pdf" }), SECRET);
		expect(decodeStatelessLink(encoded, SECRET)?.fileName).toBe("laporan keuangan 日本.pdf");
	});

	it("stays short enough to paste for a realistic 2-part file", () => {
		// A Telegram file_id is ~90 characters. Two of them plus metadata is the
		// worst case at the default 30 MB threshold, and it must stay well inside
		// what chat clients and proxies carry.
		const id = "B".repeat(90);
		const encoded = encodeStatelessLink(
			payload({
				parts: [
					{ telegramFileId: id, sizeBytes: 19 * 1024 * 1024, compressionAlgorithm: null },
					{ telegramFileId: id, sizeBytes: 11 * 1024 * 1024, compressionAlgorithm: null },
				],
				sizeBytes: 30 * 1024 * 1024,
			}),
			SECRET
		);
		expect(encoded.length).toBeLessThan(450);
	});
});

describe("stateless link rejects anything not signed by us", () => {
	it("rejects a token signed with a different secret", () => {
		const encoded = encodeStatelessLink(payload(), "other-secret");
		expect(decodeStatelessLink(encoded, SECRET)).toBeNull();
	});

	it("rejects a tampered payload", () => {
		const encoded = encodeStatelessLink(payload(), SECRET);
		const raw = Buffer.from(encoded, "base64url");
		// Flip a byte in the middle of the body, leaving the MAC intact.
		raw[Math.floor(raw.length / 2)] ^= 0xff;
		expect(decodeStatelessLink(raw.toString("base64url"), SECRET)).toBeNull();
	});

	it("rejects a truncated token", () => {
		const encoded = encodeStatelessLink(payload(), SECRET);
		expect(decodeStatelessLink(encoded.slice(0, encoded.length - 8), SECRET)).toBeNull();
	});

	it("rejects an empty token", () => {
		expect(decodeStatelessLink("", SECRET)).toBeNull();
	});

	it("rejects junk that is not base64url", () => {
		// `null` is the contract for "not a stateless link", which is what lets the
		// controller fall through to the database for legacy nanoid public_ids.
		expect(decodeStatelessLink("not a token!!", SECRET)).toBeNull();
	});

	it("returns null rather than throwing on a legacy nanoid public_id", () => {
		// This is the discriminator the controller depends on: a real 21-char
		// nanoid must not raise, or every old link would 500.
		expect(decodeStatelessLink("V1StGXR8_Z5jdHi6B-myT", SECRET)).toBeNull();
	});

	it("rejects a body whose version byte is from the future", () => {
		// Sign a body with version 2 so the MAC is valid but the version is not.
		// Old links must fail closed rather than be misparsed by new code.
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
		const body = Buffer.from([2, 0]);
		const mac = createHmac("sha256", SECRET).update(body).digest().subarray(0, 12);
		const token = Buffer.concat([body, mac]).toString("base64url");
		expect(decodeStatelessLink(token, SECRET)).toBeNull();
	});

	it("rejects a payload with trailing bytes", () => {
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
		const body = Buffer.from([
			1, 1, 3, 0x61, 0x62, 0x63, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0xff,
		]);
		const mac = createHmac("sha256", SECRET).update(body).digest().subarray(0, 12);
		expect(
			decodeStatelessLink(Buffer.concat([body, mac]).toString("base64url"), SECRET)
		).toBeNull();
	});
});

describe("stateless link encoding guards", () => {
	it("refuses an empty part list", () => {
		expect(() => encodeStatelessLink(payload({ parts: [] }), SECRET)).toThrow();
	});
});

/**
 * Version 2 stores the file_id decoded to binary. A Telegram file_id is already
 * base64url, so v1 was encoding the dominant field twice.
 */
describe("binary file_id (version 2)", () => {
	/** A realistic file_id: base64url, 84 chars, decodes to 63 bytes. */
	const REAL_FILE_ID =
		"BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF9mb3JfZTJlX3Rlc3RpbmdfbG9uZ19pZF8wMDEyMzQ1Njc4";

	it("round-trips the file_id exactly", () => {
		const decoded = decodeStatelessLink(
			encodeStatelessLink(
				payload({
					parts: [{ telegramFileId: REAL_FILE_ID, sizeBytes: 10, compressionAlgorithm: null }],
				}),
				SECRET
			),
			SECRET
		);
		expect(decoded?.parts[0]?.telegramFileId).toBe(REAL_FILE_ID);
	});

	it("shrinks the token versus storing the file_id as text", () => {
		// The whole point of v2. Measured against the v1 layout by encoding the
		// same payload with a file_id that is deliberately NOT base64url, which
		// forces the text path.
		const binaryToken = encodeStatelessLink(
			payload({
				parts: [{ telegramFileId: REAL_FILE_ID, sizeBytes: 10, compressionAlgorithm: null }],
				sizeBytes: 10,
			}),
			SECRET
		);
		// Same length, but not valid base64url, so it is stored as text.
		const textFileId = `${REAL_FILE_ID.slice(0, -1)}!`;
		const textToken = encodeStatelessLink(
			payload({
				parts: [{ telegramFileId: textFileId, sizeBytes: 10, compressionAlgorithm: null }],
				sizeBytes: 10,
			}),
			SECRET
		);
		expect(binaryToken.length).toBeLessThan(textToken.length);
	});

	it("falls back to text for a file_id that is not clean base64url", () => {
		// Telegram could change the format. Guessing would produce a file_id that
		// looks valid and fails at download time, so the encoder must not guess.
		for (const odd of ["has spaces here", "has!bang", "has.dot", "üñïçø∂é"]) {
			const token = encodeStatelessLink(
				payload({ parts: [{ telegramFileId: odd, sizeBytes: 5, compressionAlgorithm: null }] }),
				SECRET
			);
			expect(decodeStatelessLink(token, SECRET)?.parts[0]?.telegramFileId).toBe(odd);
		}
	});

	it("preserves the MIME type through the payload", () => {
		// MIME is deliberately NOT dropped in favour of the URL extension: a wrong
		// Content-Type stops the browser from inline-playing the file.
		for (const mime of ["application/pdf", "video/mp4", "application/octet-stream"]) {
			const decoded = decodeStatelessLink(
				encodeStatelessLink(payload({ mimeType: mime }), SECRET),
				SECRET
			);
			expect(decoded?.mimeType).toBe(mime);
		}
	});

	it("keeps per-part compression and binary flags independent", () => {
		const decoded = decodeStatelessLink(
			encodeStatelessLink(
				payload({
					parts: [
						{ telegramFileId: REAL_FILE_ID, sizeBytes: 1, compressionAlgorithm: "gzip" },
						{ telegramFileId: "plain-text-id!", sizeBytes: 2, compressionAlgorithm: null },
						{ telegramFileId: REAL_FILE_ID, sizeBytes: 3, compressionAlgorithm: null },
					],
				}),
				SECRET
			),
			SECRET
		);
		expect(decoded?.parts.map((p) => p.compressionAlgorithm)).toEqual(["gzip", null, null]);
		expect(decoded?.parts.map((p) => p.telegramFileId)).toEqual([
			REAL_FILE_ID,
			"plain-text-id!",
			REAL_FILE_ID,
		]);
	});
});

/**
 * A v1 link may already be pasted into a chat. Deploying v2 must not break it.
 */
describe("version 1 links still decode", () => {
	/** Hand-builds a v1 body, exactly as the v1 encoder would have. */
	const buildV1 = (fileId: string, secret: string): string => {
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
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

		const out: Buffer[] = [Buffer.from([1])];
		pushVarint(out, 1);
		pushStr(out, fileId);
		pushVarint(out, 1024);
		out.push(Buffer.from([0]));
		pushVarint(out, 1024);
		pushStr(out, "old.txt");
		pushStr(out, "text/plain");
		const created = Buffer.alloc(4);
		created.writeUInt32BE(1_700_000_000, 0);
		out.push(created);

		const body = Buffer.concat(out);
		const mac = createHmac("sha256", secret).update(body).digest().subarray(0, 12);
		return Buffer.concat([body, mac]).toString("base64url");
	};

	it("decodes a v1 payload, including its text file_id", () => {
		const token = buildV1("BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF8wMDE", SECRET);
		const decoded = decodeStatelessLink(token, SECRET);
		expect(decoded).not.toBeNull();
		expect(decoded?.fileName).toBe("old.txt");
		expect(decoded?.mimeType).toBe("text/plain");
		expect(decoded?.parts[0]?.telegramFileId).toBe("BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF8wMDE");
	});

	it("rejects a version that is neither 1 nor 2", () => {
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
		for (const v of [0, 3, 255]) {
			const body = Buffer.from([v, 0]);
			const mac = createHmac("sha256", SECRET).update(body).digest().subarray(0, 12);
			expect(
				decodeStatelessLink(Buffer.concat([body, mac]).toString("base64url"), SECRET)
			).toBeNull();
		}
	});
});

describe("splitStatelessToken", () => {
	it("splits on the first dot so multi-dot names keep their full token", () => {
		// `archive.tar.gz` must yield extension `tar.gz`, not `gz`, or a
		// base64url token containing no dots would lose part of itself.
		expect(splitStatelessToken("abc123.tar.gz")).toEqual({ token: "abc123", extension: "tar.gz" });
	});

	it("returns an empty extension when there is no dot", () => {
		expect(splitStatelessToken("abc123")).toEqual({ token: "abc123", extension: "" });
	});

	it("lowercases the extension", () => {
		expect(splitStatelessToken("abc.PDF").extension).toBe("pdf");
	});
});

describe("buildStatelessDownloadUrl", () => {
	it("appends the extension at the end of the link", () => {
		expect(buildStatelessDownloadUrl("https://example.com", "tok", "photo.PNG")).toBe(
			"https://example.com/f/tok.png"
		);
	});

	it("does not double the slash when baseUrl ends with one", () => {
		expect(buildStatelessDownloadUrl("https://example.com/", "tok", "a.txt")).toBe(
			"https://example.com/f/tok.txt"
		);
	});

	it("omits the extension when the file has none", () => {
		expect(buildStatelessDownloadUrl("https://example.com", "tok", "Makefile")).toBe(
			"https://example.com/f/tok"
		);
	});

	it("drops an extension that could alter the URL", () => {
		// The extension comes from a user-supplied file name. `?` or `#` would
		// change which query/fragment the client sends; `/` would change the path.
		for (const name of ["x.a?b=c", "x.a#frag", "x.a/b", "x." + "a".repeat(40)]) {
			const url = buildStatelessDownloadUrl("https://example.com", "tok", name);
			expect(url).toBe("https://example.com/f/tok");
		}
	});
});
