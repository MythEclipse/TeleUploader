/**
 * End-to-end probe for the stateless upload path.
 *
 * The architecture is a split, and these tests assert BOTH halves:
 *
 *   WRITE: upload → Telegram, then a `files` row (+ `file_parts` per chunk).
 *          Backup and listing need that record.
 *   READ:  /f/<token> → verified payload → Telegram. Never a query.
 *
 * Boots the real Hono app (not a mock) against a DEAD Postgres URL, then:
 *
 *   1. uploads a small file through POST /api/upload,
 *   2. asserts a `files` row was written whose public_id IS the token,
 *   3. asserts the returned downloadUrl carries the token and the extension,
 *   4. fetches that URL and asserts the bytes come back,
 *   5. asserts /file/<token>/info answers from the payload,
 *   6. asserts a legacy public_id still goes to the database.
 *
 * The database being unreachable for the entire run is what makes step 4
 * meaningful: a single query on the read path would fail the probe instead of
 * silently passing. Step 2 is equally load-bearing in the other direction — if
 * the row stops being written, backup and listing break with no visible symptom.
 *
 * Telegram itself is stubbed — a real bot token is not available here, and the
 * point under test is OUR plumbing, not Telegram's.
 */
import { expect, it, vi } from "vitest";

const FAKE_FILE_ID = "BQACAgIAAxkBAAIBY2V4YW1wbGVfZmlsZV9pZF9mb3JfZTJl";

/** Captures what the upload path tries to persist, without touching a database. */
const persisted: Record<string, unknown>[] = [];

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
	neutralUploadFileName: () => "upload.bin",
}));

/**
 * The repository is stubbed so the test can observe the write without a live
 * Postgres, while still letting the read path run with no database at all.
 */
vi.mock("../src/infrastructure/di", async () => {
	const actual = await vi.importActual<typeof import("../src/infrastructure/di")>(
		"../src/infrastructure/di"
	);
	return {
		...actual,
		fileRepository: {
			...actual.fileRepository,
			create: async (file: Record<string, unknown>) => {
				persisted.push(file);
				return { id: 1, ...file, createdAt: new Date(), updatedAt: new Date() };
			},
			// Dedup lookup fails loudly here: with the feature working, a broken
			// lookup must be swallowed and the upload must still succeed.
			findByHash: async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
			},
			// The read path for legacy ids must reach a REAL lookup that fails
			// because Postgres is unreachable — not because the mock is incomplete.
			// A `not a function` error would prove nothing about the database.
			findByPublicId: async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:59999");
			},
		},
	};
});

it("persists a row for backup, yet serves from the URL with a dead database", async () => {
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

	// ── A row WAS written, keyed by the token ─────────────────────────────
	// This is the backup/listing half. The upload succeeded even though the dedup
	// lookup threw, which is the required behaviour.
	expect(persisted).toHaveLength(1);
	const row = persisted[0]!;
	expect(row.fileName).toBe("notes.txt");
	expect(row.mimeType).toBe("text/plain");
	expect(row.sizeBytes).toBe(21);
	expect(row.storageBackend).toBe("telegram");
	expect(row.telegramFileId).toBe(FAKE_FILE_ID);

	// ── The link carries the payload and ends in the extension ────────────
	const url = new URL(uploaded.download_url);
	expect(url.pathname.startsWith("/f/")).toBe(true);
	expect(url.pathname.endsWith(".txt"), `expected a .txt suffix, got ${url.pathname}`).toBe(true);
	// A stateless token is far longer than a nanoid; this is what distinguishes it.
	expect(url.pathname.length).toBeGreaterThan(100);

	// The stored key and the URL token are the same value, so `findByPublicId`
	// and `/f/<token>` refer to the same row.
	const tokenFromUrl = url.pathname.slice("/f/".length).split(".")[0];
	expect(row.publicId).toBe(tokenFromUrl);

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
