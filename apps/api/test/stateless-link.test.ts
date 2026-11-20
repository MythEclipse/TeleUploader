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
