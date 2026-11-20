import { describe, expect, it } from "vitest";
import { parseS3Path } from "../src/presentation/http/controllers/s3/s3-router";
import { readJsonBody } from "../src/presentation/http/json-body";
import { decodeUriComponentSafe } from "../src/presentation/s3/uri";

/**
 * Malformed-input hardening: a bad escape or a bad body must be a 4xx.
 *
 * Three separate handlers used to turn client input into a 500, all for the
 * same reason — a parsing helper that THROWS was called on a value the client
 * controls, with no catch anywhere between it and Hono:
 *
 *   GET  /{bucket}/%ZZ              → 500  (decodeURIComponent → URIError)
 *   verifySignature(…/%ZZ)          → threw out of the auth path
 *   POST /api/v1/buckets  {not json → 500  (req.json() → SyntaxError)
 *   POST /api/v1/buckets/b/copy     → 500  (same)
 *
 * A 500 is wrong twice over: it is a lie about who caused the failure, and
 * aws-cli/rclone/Docker retry it, so one mistyped key becomes a retry storm
 * against a request that can never succeed.
 */

describe("decodeUriComponentSafe", () => {
	it("decodes a well-formed value", () => {
		expect(decodeUriComponentSafe("a%20b")).toBe("a b");
		expect(decodeUriComponentSafe("%E6%96%87%E4%BB%B6")).toBe("文件");
		expect(decodeUriComponentSafe("plain")).toBe("plain");
	});

	it("returns null instead of throwing on a malformed escape", () => {
		// The regression test. Each of these makes `decodeURIComponent` throw
		// `URIError: URI malformed`, which used to escape the handler as a 500.
		for (const bad of ["%ZZ", "%", "%E0%A4", "%GG", "a%2", "%C3"]) {
			expect(() => decodeUriComponentSafe(bad), bad).not.toThrow();
			expect(decodeUriComponentSafe(bad), bad).toBeNull();
		}
	});

	it("rejects a NUL byte, which truncates at the syscall layer", () => {
		expect(decodeUriComponentSafe("a%00b")).toBeNull();
		expect(decodeUriComponentSafe("a\0b")).toBeNull();
	});
});

describe("parseS3Path", () => {
	it("parses path-style addresses", () => {
		expect(parseS3Path("/gitea/key.txt")).toEqual({
			bucket: "gitea",
			key: "key.txt",
			malformed: false,
		});
		expect(parseS3Path("/gitea/a/b/c.txt")).toEqual({
			bucket: "gitea",
			key: "a/b/c.txt",
			malformed: false,
		});
	});

	it("reports a malformed segment instead of throwing", () => {
		// This is what made `GET /{bucket}/%ZZ` a 500.
		expect(() => parseS3Path("/gitea/%ZZ")).not.toThrow();
		expect(parseS3Path("/gitea/%ZZ").malformed).toBe(true);
		expect(parseS3Path("/gitea/a/%E0%A4").malformed).toBe(true);
	});

	it("keeps an encoded slash inside the key rather than splitting on it", () => {
		// Decoding per-segment is load-bearing: decoding the whole path first
		// would turn `a%2Fb` into a two-segment key and address a different
		// object than the client named — a write to the wrong key on PUT.
		expect(parseS3Path("/gitea/a%2Fb")).toEqual({
			bucket: "gitea",
			key: "a/b",
			malformed: false,
		});
	});
});

describe("readJsonBody", () => {
	it("parses a valid body", async () => {
		const result = await readJsonBody(
			new Request("http://localhost/", { method: "POST", body: '{"name":"x"}' })
		);
		expect(result).toEqual({ ok: true, value: { name: "x" } });
	});

	it("reports a malformed body instead of throwing", async () => {
		// The regression test for the 500 on `POST /api/v1/buckets`.
		for (const body of ["{not json", "}{", '{"a":}', "undefined"]) {
			const result = await readJsonBody(new Request("http://localhost/", { method: "POST", body }));
			expect(result.ok, body).toBe(false);
		}
	});

	it("treats an empty or whitespace body as absent, not as malformed", async () => {
		// Endpoints that take no body must not 400. `req.json()` throws the same
		// SyntaxError for an empty stream, so this distinction cannot be made by
		// catching alone.
		for (const body of [undefined, "", "   \n\t "]) {
			const result = await readJsonBody(new Request("http://localhost/", { method: "POST", body }));
			expect(result, String(body)).toEqual({ ok: true, value: undefined });
		}
	});

	it("distinguishes a JSON `null` from a malformed body", async () => {
		// `null` is valid JSON. Collapsing it into the failure case would let a
		// handler treat a malformed body as the empty one — a silent wrong answer
		// instead of a rejection.
		const result = await readJsonBody(
			new Request("http://localhost/", { method: "POST", body: "null" })
		);
		expect(result).toEqual({ ok: true, value: null });
	});
});
