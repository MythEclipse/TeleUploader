/**
 * End-to-end probe for the stateless download path.
 *
 * Boots the real Hono app (not a mock) against a DEAD Postgres URL, then:
 *
 *   1. uploads a small file through POST /api/upload,
 *   2. asserts the returned downloadUrl carries the token and the extension,
 *   3. fetches that URL and asserts the bytes come back,
 *   4. asserts /file/<token>/info answers from the payload,
 *   5. asserts a legacy public_id still 404s through the database path.
 *
 * Step 2 is the whole feature. Step 3 is the only honest proof that the URL
 * carries everything needed: the database is unreachable for the entire run, so a
 * single query on the read path would fail the probe instead of silently passing.
 *
 * Telegram itself is stubbed — a real bot token is not available here, and the
 * point under test is OUR plumbing, not Telegram's.
 */
import { expect, it, vi } from "vitest";

const FAKE_FILE_ID = "BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF9mb3JfZTJl";

// Stub the bot pool before the app imports it. `getFileInfo` returns a fake CDN
// path; the CDN fetch itself is stubbed per-test.
vi.mock("../src/infrastructure/telegram/bot-pool", () => ({
	botPool: {
		size: 1,
		getEffectiveConcurrency: () => 1,
		getFileInfo: async () => ({
			file_size: 21,
			mime_type: "text/plain",
			file_path: "documents/file_0.txt",
			bot_token: "123456:FAKE",
		}),
		forwardToStorage: async () => ({
			telegramFileId: FAKE_FILE_ID,
			telegramFileUniqueId: "unique-1",
			storageMessageId: 1,
		}),
	},
}));

it("serves a small upload from its URL alone, with a dead database", async () => {
	const { createApp } = await import("../src/presentation/http/app");
	const app = createApp();

	// The Telegram CDN is the only network call allowed on the read path.
	const cdn = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("api.telegram.org/file/")) {
				return new Response("hello stateless world", {
					status: 200,
					headers: { "content-type": "text/plain", "content-length": "21" },
				});
			}
			throw new Error(`unexpected outbound fetch: ${url}`);
		});

	// ── Upload ────────────────────────────────────────────────────────────
	const body = new FormData();
	body.set("file", new File(["hello stateless world"], "notes.txt", { type: "text/plain" }));
	const uploadRes = await app.fetch(
		new Request("http://localhost/api/upload", { method: "POST", body })
	);
	expect(uploadRes.status, await uploadRes.clone().text()).toBe(200);

	const uploaded = (await uploadRes.json()) as { download_url: string; file_name: string };
	expect(uploaded.file_name).toBe("notes.txt");

	// ── The link carries the payload and ends in the extension ────────────
	const url = new URL(uploaded.download_url);
	expect(url.pathname.startsWith("/f/")).toBe(true);
	expect(url.pathname.endsWith(".txt"), `expected a .txt suffix, got ${url.pathname}`).toBe(true);
	// A stateless token is far longer than a nanoid; this is what distinguishes it.
	expect(url.pathname.length).toBeGreaterThan(100);

	// ── Download, with Postgres unreachable ───────────────────────────────
	const downloadRes = await app.fetch(new Request(uploaded.download_url));
	expect(downloadRes.status).toBe(200);
	expect(await downloadRes.text()).toBe("hello stateless world");
	expect(downloadRes.headers.get("content-type")).toBe("text/plain");
	expect(downloadRes.headers.get("content-disposition")).toContain('filename="notes.txt"');

	// ── Info endpoint, also from the payload ──────────────────────────────
	const tokenWithExt = url.pathname.slice("/f/".length);
	const infoRes = await app.fetch(new Request(`http://localhost/file/${tokenWithExt}/info`));
	expect(infoRes.status).toBe(200);
	const info = (await infoRes.json()) as {
		file_name: string;
		mime_type: string;
		size_bytes: number;
	};
	expect(info.file_name).toBe("notes.txt");
	expect(info.mime_type).toBe("text/plain");
	expect(info.size_bytes).toBe(21);

	// ── A legacy public_id still goes to the database (and fails here) ────
	// This asserts the discriminator: the stateless check must not swallow the
	// old path. With Postgres dead, a legacy id surfaces as a 500 — the point is
	// that it did NOT come back 200 from a payload.
	const legacyRes = await app.fetch(new Request("http://localhost/f/V1StGXR8_Z5jdHi6B-myT"));
	expect(legacyRes.status).not.toBe(200);

	cdn.mockRestore();
});
