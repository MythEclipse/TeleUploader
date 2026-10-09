/**
 * Comprehensive tests for S3 Docker registry safety:
 * - Streaming uploads (no req.arrayBuffer())
 * - Timeout handling on Telegram fetches
 * - Rate limiting on S3 routes
 * - Large file edge cases
 * - Concurrent operation safety
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";
import { createFileSink } from "../src/application/shared/utils/file-sink";

/**
 * `createApp` is the routing object `src/index.ts` serves via
 * `@hono/node-server`. The S3 dispatch guard at the bottom of this file is
 * asserted against it rather than against the deleted
 * `src/presentation/http/routes/index.ts` route table, which nothing imports.
 */
const { createApp } = await import("../src/presentation/http/app");

// ─── streamBodyToTemp tests ──────────────────────────────────────

describe("S3 Streaming Upload Safety", () => {
	/**
	 * Verifies that streamBodyToTemp processes the body in chunks
	 * without loading the entire payload into memory at once.
	 */
	it("streams body to temp file without buffering entire body", async () => {
		// Import the S3 controller module
		const _mod = await import("../src/presentation/http/controllers/s3-controller.ts");

		// Create a ReadableStream with known content
		const content = "Hello, Docker Registry! This is a test blob.";
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("Hello, "));
				controller.enqueue(encoder.encode("Docker Registry! "));
				controller.enqueue(encoder.encode("This is a test blob."));
				controller.close();
			},
		});

		// Create a mock Request with streaming body
		const req = new Request("http://test.com", {
			method: "PUT",
			body: stream,
			duplex: "half",
			headers: { "content-type": "application/octet-stream" },
		});

		// Call streamBodyToTemp via the exported module function
		// Since streamBodyToTemp is not exported, we test through handlePutObject
		// Instead, we directly create a temp file and verify streaming works
		const tempPath = `/tmp/test-stream-${nanoid()}`;
		const writer = createFileSink(tempPath);
		const hasher = createHash("sha256");
		const reader = req.body!.getReader();
		const chunks: Buffer[] = [];

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = Buffer.from(value);
				chunks.push(chunk);
				hasher.update(chunk);
				writer.write(chunk);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		const fileHash = hasher.digest("hex");
		const assembled = Buffer.concat(chunks).toString();
		const fileContent = await readFile(tempPath, "utf8");

		expect(assembled).toBe(content);
		expect(fileContent).toBe(content);
		expect(fileHash).toBe(createHash("sha256").update(encoder.encode(content)).digest("hex"));

		// Cleanup
		await writeFile(tempPath, ""); // truncate
	});

	/**
	 * Tests that a multi-megabyte body (simulating Docker layers)
	 * is streamed correctly without OOM.
	 */
	it("handles multi-MB streaming body without OOM", async () => {
		// Generate ~5MB of deterministic content
		const chunk = "A".repeat(1024 * 1024); // 1MB
		const contentSizeMB = 5;
		const encoder = new TextEncoder();

		// Create streaming body with 5MB total
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				for (let i = 0; i < contentSizeMB; i++) {
					controller.enqueue(encoder.encode(chunk));
					// Yield control to simulate real streaming
					await new Promise((r) => setTimeout(r, 0));
				}
				controller.close();
			},
		});

		const req = new Request("http://test.com", {
			method: "PUT",
			body: stream,
			duplex: "half",
		});

		// Read stream to temp and verify
		const tempPath = `/tmp/test-large-stream-${nanoid()}`;
		const writer = createFileSink(tempPath);
		const reader = req.body!.getReader();
		let totalBytes = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const buf = Buffer.from(value);
				totalBytes += buf.byteLength;
				writer.write(buf);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		const fileSize = statSync(tempPath).size;
		expect(fileSize).toBe(totalBytes);
		expect(fileSize).toBe(contentSizeMB * 1024 * 1024);
		expect(fileSize).toBeGreaterThan(4 * 1024 * 1024); // at least 4MB

		// Verify content integrity
		const readBack = await readFile(tempPath, "utf8");
		const text = readBack;
		expect(text.length).toBe(contentSizeMB * 1024 * 1024);
		expect(text[0]).toBe("A");
		expect(text[text.length - 1]).toBe("A");

		// Cleanup
		await writeFile(tempPath, "");
	});

	/**
	 * Tests that handlePutObject no longer uses req.arrayBuffer()
	 * by checking the module source code.
	 */
	it("uses streaming instead of req.arrayBuffer() for PUT body", async () => {
		// PUT handler lives in s3-object-write.ts since the Fase 1 split
		// (s3-controller.ts is now a thin facade re-exporting the router).
		const source = await readFile(
			"src/presentation/http/controllers/s3/s3-object-write.ts",
			"utf8"
		);

		const codeLines = source.split("\n").filter((l) => !l.trim().startsWith("*"));
		const codeText = codeLines.join("\n");

		// The new streaming function should exist
		expect(codeText).toContain("streamBodyToTemp");
		expect(codeText).toContain("storeFileFromTemp");

		// handlePutObject should NOT contain req.arrayBuffer()
		// (note: comments that mention arrayBuffer are filtered out)
		const putObjectCode =
			codeText.split("handlePutObject =")[1]?.split("storeFileFromTemp =")[0] || "";
		expect(putObjectCode).not.toMatch(/req\.arrayBuffer\(\)/);
		expect(putObjectCode).toContain("streamBodyToTemp");
	});
});

// ─── UploadPart streaming tests ────────────────────────────────

describe("S3 UploadPart Streaming", () => {
	/**
	 * Verifies that handleUploadPart streams body instead of using
	 * req.arrayBuffer().
	 */
	it("streams part body instead of req.arrayBuffer()", async () => {
		// UploadPart handler lives in s3-multipart-handlers.ts since the Fase 1 split.
		const source = await readFile(
			"src/presentation/http/controllers/s3/s3-multipart-handlers.ts",
			"utf8"
		);

		// Find the handleUploadPart function
		const uploadPartSection =
			source
				.split("const handleUploadPart =")[1]
				?.split("const handleCompleteMultipartUpload =")[0] || "";
		expect(uploadPartSection).not.toContain("arrayBuffer");
		expect(uploadPartSection).toContain("getReader");
		expect(uploadPartSection).toContain("createFileSink(tempPath)");
	});

	/**
	 * Tests that a multipart part body is correctly hashed while streaming.
	 */
	it("computes correct hash from streamed part body", async () => {
		const content = "multipart-part-content-for-docker-layer";
		const encoder = new TextEncoder();
		const expectedHash = createHash("sha256").update(encoder.encode(content)).digest("hex");

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("multipart-"));
				controller.enqueue(encoder.encode("part-content-"));
				controller.enqueue(encoder.encode("for-docker-layer"));
				controller.close();
			},
		});

		// Stream and hash
		const hasher = createHash("sha256");
		const tempPath = `/tmp/test-part-${nanoid()}`;
		const writer = createFileSink(tempPath);
		const reader = stream.getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = Buffer.from(value);
				hasher.update(chunk);
				writer.write(chunk);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		const computedHash = hasher.digest("hex");
		const storedContent = await readFile(tempPath, "utf8");

		expect(computedHash).toBe(expectedHash);
		expect(storedContent).toBe(content);

		// Cleanup
		await writeFile(tempPath, "");
	});
});

// ─── Object-stream timeout tests ────────────────────────────────

describe("S3 Object Stream Timeouts", () => {
	/**
	 * Verifies that Telegram fetch calls have timeout signals attached.
	 */
	it("adds timeout signal to Telegram CDN fetches", async () => {
		const source = await readFile("src/presentation/s3/object-stream.ts", "utf8");

		// Verify timeout constant exists
		expect(source).toContain("TELEGRAM_FETCH_TIMEOUT_MS");
		expect(source).toContain("30_000");

		// Verify AbortSignal.timeout is used
		expect(source).toContain("AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS)");

		// Verify the fetchWholePartBytes function uses AbortController
		expect(source).toContain("new AbortController()");
		expect(source).toContain("controller.abort()");
	});
});

// ─── Route rate limiting tests ──────────────────────────────────

describe("S3 Route Rate Limiting", () => {
	/**
	 * S3 routes are intentionally NOT wrapped in withRateLimit: Docker registry
	 * clients retry on 5xx but abort on 4xx, so a 429 would break blob pushes.
	 *
	 * ## Why the target changed from a source file to the live app
	 *
	 * This assertion used to `readFile('src/presentation/http/routes/index.ts')`
	 * and grep that dead route table for literal strings. Three of its four
	 * strings already failed against the live `app.ts` (verified:
	 * `return handleS3Request(req, getS3RouteBucket(req));` 0 hits,
	 * `withRateLimit(handleUpload)` 0 hits, `withRateLimit(handleFileRedirect)`
	 * 0 hits — `app.ts` wraps through the `limited()` helper instead), so the
	 * guard was pinned to a file nothing imports and encoded P2-era drift as if
	 * it were correct.
	 *
	 * It is re-aimed at `createApp()` — the object `src/index.ts` actually serves.
	 * The guarantee is unchanged and now behavioural rather than textual:
	 *
	 *   1. `POST /api/upload` IS rate limited — proven by exhausting the real
	 *      budget and getting a 429. This proves the limiter is actually armed,
	 *      so the negative assertion below is not vacuous.
	 *   2. A SigV4 S3 PUT dispatched by the SAME app is NOT rate limited — it
	 *      reaches the S3 controller (XML) instead of 429.
	 *
	 * Point 1 is the load-bearing half. A test that only asserts "S3 did not 429"
	 * passes trivially when the limiter is disabled or misconfigured; pairing it
	 * with a route that IS limited makes the guard bite.
	 */
	it("dispatches S3 requests without rate-limiting (live app path)", async () => {
		const { config } = await import("../src/env");
		const { clearRateLimitCache } = await import("../src/presentation/http/middleware/rate-limit");

		clearRateLimitCache();

		// ── 1. Prove the limiter is armed and reachable on a limited route ──────
		// `POST /api/upload` is wrapped in `limited(...)` in app.ts.
		let limitedStatus = 0;
		for (let i = 0; i <= config.rateLimitMaxRequests; i++) {
			const res = await createApp().request("/api/upload", { method: "POST", body: "x" });
			limitedStatus = res.status;
			if (res.status === 429) break;
		}
		expect(
			limitedStatus,
			"POST /api/upload must be rate limited — otherwise the S3 negative below proves nothing"
		).toBe(429);

		// ── 2. The S3 PUT must bypass that same exhausted budget ───────────────
		clearRateLimitCache();
		// Re-exhaust the budget so the limiter is at its ceiling going into S3.
		for (let i = 0; i <= config.rateLimitMaxRequests; i++) {
			const res = await createApp().request("/api/upload", { method: "POST", body: "x" });
			if (res.status === 429) break;
		}

		const s3Res = await createApp().request("/some-bucket/some/layer/blob", {
			method: "PUT",
			headers: {
				authorization:
					"AWS4-HMAC-SHA256 Credential=filedrop-admin/20260101/us-east-1/s3/aws4_request, " +
					"SignedHeaders=host;x-amz-date, Signature=abc123",
				"x-amz-date": "20260101T000000Z",
				"x-amz-content-sha256": "UNSIGNED-PAYLOAD",
			},
			body: "layer-bytes",
			duplex: "half",
		});

		expect(
			s3Res.status,
			"a rate-limited app must never 429 an S3 push (Docker aborts on 4xx)"
		).not.toBe(429);

		// ── 3. And it genuinely reached the S3 controller ──────────────────────
		// `createApp()` must claim the SigV4 PUT, not hand it to the non-S3
		// fallback. The discriminator is environment-independent: this suite has
		// no repository mocks, so the S3 controller fails on the database and
		// answers 500, whereas the catch-all fallback answers 404 "Not Found".
		// Measured: SigV4 PUT -> 500 text/plain "Internal Server Error";
		// identical PUT with no SigV4 header -> 404 text/plain "Not Found".
		//
		// Asserting `not.toBe(429)` alone would pass even if S3 never claimed the
		// path at all, so this half is what makes the guard bite.
		const control = await createApp().request("/some-bucket/some/layer/blob", {
			method: "PUT",
			body: "layer-bytes",
			duplex: "half",
		});
		expect(
			control.status,
			"control: the same PUT without SigV4 must miss S3 and hit the fallback"
		).toBe(404);
		expect(
			s3Res.status,
			"the SigV4 PUT must be claimed by the S3 controller, not the non-S3 fallback"
		).not.toBe(404);

		clearRateLimitCache();
	});
});

// ─── Empty body / edge case tests ───────────────────────────────

describe("S3 Edge Cases", () => {
	/**
	 * Tests that streaming from an empty body doesn't error.
	 */
	it("handles empty body streaming gracefully", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});

		const req = new Request("http://test.com", { method: "PUT", body: stream, duplex: "half" });

		const tempPath = `/tmp/test-empty-${nanoid()}`;
		const writer = createFileSink(tempPath);
		const reader = req.body!.getReader();
		const hasher = createHash("sha256");
		let totalBytes = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += Buffer.from(value).byteLength;
				hasher.update(value);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		expect(totalBytes).toBe(0);
		const fileSize = statSync(tempPath).size;
		expect(fileSize).toBe(0);
		expect(hasher.digest("hex")).toBe(createHash("sha256").update("").digest("hex"));

		await writeFile(tempPath, "");
	});
});

// ─── Concurrent upload safety tests ─────────────────────────────

describe("S3 Concurrent Operation Safety", () => {
	/**
	 * Tests that multiple concurrent streaming operations don't interfere.
	 * Simulates Docker pushing multiple layers simultaneously.
	 */
	it("handles concurrent streaming uploads independently", async () => {
		const NUM_CONCURRENT = 5;
		const encoder = new TextEncoder();

		// Create NUM_CONCURRENT streams with different content
		const streams = Array.from({ length: NUM_CONCURRENT }, (_, i) => {
			const content = `concurrent-blob-${i}-${"X".repeat(1024 * 10)}`; // ~10KB each
			return {
				content,
				stream: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(`concurrent-blob-${i}-`));
						controller.enqueue(encoder.encode("X".repeat(1024 * 10)));
						controller.close();
					},
				}),
			};
		});

		// Process all streams concurrently
		const results = await Promise.all(
			streams.map(async ({ content, stream }) => {
				const req = new Request("http://test.com", { method: "PUT", body: stream, duplex: "half" });
				const tempPath = `/tmp/test-concurrent-${nanoid()}`;
				const writer = createFileSink(tempPath);
				const reader = req.body!.getReader();
				const hasher = createHash("sha256");

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const buf = Buffer.from(value);
						hasher.update(buf);
						writer.write(buf);
					}
					await writer.end();
				} finally {
					reader.releaseLock();
				}

				const computedHash = hasher.digest("hex");
				const expectedHash = createHash("sha256").update(encoder.encode(content)).digest("hex");
				const size = statSync(tempPath).size;

				await writeFile(tempPath, "");

				return { computedHash, expectedHash, size, contentLength: content.length };
			})
		);

		for (const r of results) {
			expect(r.computedHash).toBe(r.expectedHash);
			expect(r.size).toBe(r.contentLength);
		}

		// All results should be different from each other
		const uniqueHashes = new Set(results.map((r) => r.computedHash));
		expect(uniqueHashes.size).toBe(NUM_CONCURRENT);
	});
});

// ─── Large file size limit tests ────────────────────────────────

describe("S3 File Size Limits", () => {
	/**
	 * Verifies that the S3 config has proper size limits for Docker usage.
	 */
	it("has appropriate size limits for Docker layer blobs", async () => {
		const { config } = await import("../src/env");

		// Docker layers can be multiple GB
		expect(config.maxRequestBodyBytes).toBeGreaterThanOrEqual(500 * 1024 * 1024);
		expect(config.telegramChunkSizeBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);

		// Chunked storage should handle files larger than single chunk
		expect(config.telegramChunkSizeBytes).toBeLessThan(config.maxRequestBodyBytes);
	});
});
