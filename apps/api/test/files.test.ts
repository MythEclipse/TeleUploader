import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeStatelessLink } from "../src/application/shared/utils/stateless-link";

type RequestWithParams = Request & {
	params?: {
		public_id?: string;
	};
};

type ErrorBody = {
	error: string;
};

type FileInfoBody = {
	public_id: string;
	file_name: string;
	mime_type: string;
	size_bytes: number;
	file_type: string;
	created_at: string;
};

type JsonBody = ErrorBody | FileInfoBody | Record<string, unknown>;

type MockFileRecord = {
	publicId: string;
	fileName: string;
	mimeType: string;
	sizeBytes: number;
	fileType: string;
	uploaderId?: number;
	createdAt?: Date;
	telegramFileId?: string;
	storageBackend?: string | null;
	archiveEntryName?: string | null;
	fileHash?: string | null;
	archiveTelegramFileId?: string | null;
};

const requestWithPublicId = (url: string, publicId: string): RequestWithParams => {
	const req = new Request(url) as RequestWithParams;
	req.params = { public_id: publicId };
	return req;
};

const responseJson = async <T extends JsonBody>(res: Response): Promise<T> => {
	return (await res.json()) as T;
};

// Mock the DI module — file-controller imports fileRepository + chunkedStorage from here
const mockFindByPublicId = vi.fn(
	(_publicId: string): Promise<MockFileRecord | null> => Promise.resolve(null)
);

const mockGetFileInfo = vi.fn(async (_telegramFileId: string) => ({
	file_size: 98765,
	mime_type: "image/jpeg",
	file_path: "photos/file_0.jpg",
	bot_token: "123456:ABC-DEF",
}));

const mockCreateChunkedObjectResponse = vi.fn(async () => new Response(null, { status: 200 }));

vi.mock("../src/infrastructure/di", () => ({
	fileRepository: {
		findByPublicId: mockFindByPublicId,
		findByHash: async () => null,
		findByUniqueId: async () => null,
		findByBucketAndKey: async () => null,
		create: async (data: Record<string, unknown>) => ({
			...data,
			id: "mock-id",
			createdAt: new Date(),
		}),
		softDelete: async () => true,
		softDeleteBatch: async () => 1,
		countByBucket: async () => 0,
		listByPrefix: async () => ({ objects: [], prefixes: [] }),
		findOrphansByBucket: async () => [],
	},
	chunkedStorage: {
		createChunkedObjectResponse: mockCreateChunkedObjectResponse,
		buildChunkedObjectSources: async () => [],
		uploadFileInTelegramChunks: async () => ({ parts: [], fileHash: "", totalSizeBytes: 0 }),
		storeFileInTelegramChunks: async () => ({
			id: "mock-id",
			publicId: "mock-public",
			telegramFileId: "mock-tg",
			telegramFileUniqueId: "mock-tg-unique",
			storageChatId: 0,
			storageMessageId: 0,
			fileName: "mock",
			mimeType: "application/octet-stream",
			sizeBytes: 0,
			fileType: "document",
			uploaderId: 0,
			fileHash: null,
			archiveTelegramFileId: null,
			archiveStorageMessageId: null,
			archiveFileName: null,
			archiveEntryName: null,
			archiveMimeType: null,
			archiveSizeBytes: null,
			bucketId: null,
			s3Key: null,
			storageBackend: "telegram",
			isDeleted: false,
			multipartUploadId: null,
			partCount: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}),
	},
}));

// Mock botPool.getFileInfo used in file redirect
vi.mock("../src/infrastructure/telegram/bot-pool", () => ({
	botPool: {
		getFileInfo: mockGetFileInfo,
		forwardToStorage: async () => ({
			telegramFileId: "mock-tg-id",
			telegramFileUniqueId: "mock-tg-unique",
			storageMessageId: 12345,
		}),
		size: 1,
		getEffectiveConcurrency: () => 1,
	},
}));

describe("File Route Handlers", () => {
	let handleFileRedirect: typeof import("../src/presentation/http/controllers/file-controller").handleFileRedirect;
	let handleFileInfo: typeof import("../src/presentation/http/controllers/file-controller").handleFileInfo;

	beforeEach(async () => {
		mockFindByPublicId.mockClear();
		mockGetFileInfo.mockClear();
		mockCreateChunkedObjectResponse.mockClear();

		// Set up mock token
		process.env.BOT_TOKEN = "123456:ABC-DEF";

		const filesRoute = await import("../src/presentation/http/controllers/file-controller");
		handleFileRedirect = filesRoute.handleFileRedirect;
		handleFileInfo = filesRoute.handleFileInfo;
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	describe("handleFileRedirect", () => {
		it("should return 404 if file is not found in database", async () => {
			mockFindByPublicId.mockImplementationOnce(async () => null);

			const req = requestWithPublicId("http://localhost:4000/f/missing-id", "missing-id");
			const res = await handleFileRedirect(req);
			expect(res.status).toBe(404);
			const body = await responseJson<ErrorBody>(res);
			expect(body.error).toBe("File not found");
		});

		it("should proxy the telegram file body with 200 (no token leak)", async () => {
			mockFindByPublicId.mockImplementationOnce(async () => ({
				publicId: "test-id",
				telegramFileId: "tg-file-id",
				telegramFileUniqueId: "tg-unique",
				storageChatId: -100123,
				storageMessageId: 42,
				fileName: "test.jpg",
				mimeType: "image/jpeg",
				sizeBytes: 100,
				fileType: "photo",
				uploaderId: 0,
				fileHash: "abc123",
				archiveTelegramFileId: null,
				archiveStorageMessageId: null,
				archiveFileName: null,
				archiveEntryName: null,
				archiveMimeType: null,
				archiveSizeBytes: null,
				bucketId: null,
				s3Key: null,
				storageBackend: "telegram",
				isDeleted: false,
				multipartUploadId: null,
				partCount: null,
				createdAt: new Date("2026-05-18T00:00:00.000Z"),
				updatedAt: new Date("2026-05-18T00:00:00.000Z"),
			}));

			const fetchCalls: string[] = [];
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (url: string | URL | Request) => {
				fetchCalls.push(String(url));
				return new Response("fake-image-bytes", {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}) as typeof fetch;
			try {
				const req = requestWithPublicId("http://localhost:4000/f/test-id", "test-id");
				const res = await handleFileRedirect(req);

				expect(res.status).toBe(200);
				expect(res.headers.get("Location")).toBeNull();
				expect(res.headers.get("Content-Type")).toContain("image/jpeg");
				expect(await res.text()).toBe("fake-image-bytes");
				// The bot token must only go to Telegram server-side, never to the client.
				expect(fetchCalls).toHaveLength(1);
				expect(fetchCalls[0]).toBe(
					"https://api.telegram.org/file/bot123456:ABC-DEF/photos/file_0.jpg"
				);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("should send the upstream Content-Length, not the DB size, when Telegram re-encodes", async () => {
			// Regression: Telegram converts an uploaded GIF to MP4, so the body is
			// much smaller than the bytes the user uploaded. Advertising the DB size
			// made every such download truncate and the client report a network error.
			mockFindByPublicId.mockImplementationOnce(async () => ({
				publicId: "anim-id",
				telegramFileId: "tg-anim-id",
				telegramFileUniqueId: "tg-anim-unique",
				storageChatId: -100123,
				storageMessageId: 43,
				fileName: "nyocot.gif",
				mimeType: "image/gif",
				sizeBytes: 506904, // what the user uploaded
				fileType: "animation",
				uploaderId: 0,
				fileHash: null,
				archiveTelegramFileId: null,
				archiveStorageMessageId: null,
				archiveFileName: null,
				archiveEntryName: null,
				archiveMimeType: null,
				archiveSizeBytes: null,
				bucketId: null,
				s3Key: null,
				storageBackend: "telegram",
				isDeleted: false,
				multipartUploadId: null,
				partCount: null,
				createdAt: new Date("2026-05-18T00:00:00.000Z"),
				updatedAt: new Date("2026-05-18T00:00:00.000Z"),
			}));

			const reencoded = new Uint8Array(86765); // what Telegram actually serves
			// Telegram serves the re-encoded file as octet-stream; only the path
			// reveals the real container.
			mockGetFileInfo.mockImplementationOnce(async () => ({
				file_size: reencoded.byteLength,
				mime_type: "application/octet-stream",
				file_path: "animations/file_11892.mp4",
				bot_token: "123456:ABC-DEF",
			}));

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async () =>
				new Response(reencoded, {
					status: 200,
					headers: {
						"content-type": "application/octet-stream",
						"content-length": String(reencoded.byteLength),
					},
				})) as typeof fetch;
			try {
				const req = requestWithPublicId("http://localhost:4000/f/anim-id", "anim-id");
				const res = await handleFileRedirect(req);

				expect(res.status).toBe(200);
				// The declared length must match the bytes actually streamed, or the
				// client stops early and reports a truncated transfer.
				expect(res.headers.get("Content-Length")).toBe(String(reencoded.byteLength));
				expect(res.headers.get("Content-Length")).not.toBe("506904");
				// The type must describe the MP4 that arrives, not the uploaded GIF and
				// not the opaque octet-stream the CDN sends.
				expect(res.headers.get("Content-Type")).toBe("video/mp4");

				const body = await res.arrayBuffer();
				expect(body.byteLength).toBe(Number(res.headers.get("Content-Length")));
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("should return 500 on database or external errors", async () => {
			mockFindByPublicId.mockImplementationOnce(async () => {
				throw new Error("DB Connection Error");
			});

			const req = requestWithPublicId("http://localhost:4000/f/test-id", "test-id");
			const res = await handleFileRedirect(req);
			expect(res.status).toBe(500);
			const body = await responseJson<ErrorBody>(res);
			expect(body.error).toBe("Server error");
		});
	});

	describe("handleFileInfo", () => {
		it("should return 404 if file is not found in database", async () => {
			mockFindByPublicId.mockImplementationOnce(async () => null);

			const req = requestWithPublicId("http://localhost:4000/file/missing-id/info", "missing-id");
			const res = await handleFileInfo(req);
			expect(res.status).toBe(404);
			const body = await responseJson<ErrorBody>(res);
			expect(body.error).toBe("File not found");
		});

		it("should return file info JSON without internal fields", async () => {
			const dbFile = {
				publicId: "test-id",
				telegramFileId: "tg-file-id",
				telegramFileUniqueId: "tg-unique",
				storageChatId: -100123,
				storageMessageId: 42,
				fileName: "image.png",
				mimeType: "image/png",
				sizeBytes: 2048,
				fileType: "photo",
				uploaderId: 99999,
				fileHash: null,
				archiveTelegramFileId: null,
				archiveStorageMessageId: null,
				archiveFileName: null,
				archiveEntryName: null,
				archiveMimeType: null,
				archiveSizeBytes: null,
				bucketId: null,
				s3Key: null,
				storageBackend: "telegram",
				isDeleted: false,
				multipartUploadId: null,
				partCount: null,
				createdAt: new Date("2026-05-18T00:00:00.000Z"),
				updatedAt: new Date("2026-05-18T00:00:00.000Z"),
			};

			mockFindByPublicId.mockImplementationOnce(async () => dbFile);

			const req = requestWithPublicId("http://localhost:4000/file/test-id/info", "test-id");
			const res = await handleFileInfo(req);
			expect(res.status).toBe(200);
			const body = await responseJson<FileInfoBody>(res);
			expect(body).toEqual({
				public_id: "test-id",
				file_name: "image.png",
				mime_type: "image/png",
				size_bytes: 2048,
				file_type: "photo",
				created_at: "2026-05-18T00:00:00.000Z",
			});
			// No internal fields
			expect(body).not.toHaveProperty("uploader_id");
			expect(body).not.toHaveProperty("telegram_file_id");
		});

		it("should return 500 on database or external errors", async () => {
			mockFindByPublicId.mockImplementationOnce(async () => {
				throw new Error("DB Connection Error");
			});

			const req = requestWithPublicId("http://localhost:4000/file/test-id/info", "test-id");
			const res = await handleFileInfo(req);
			expect(res.status).toBe(500);
			const body = await responseJson<ErrorBody>(res);
			expect(body.error).toBe("Server error");
		});
	});

	/**
	 * The whole point of stateless links is that they do not touch Postgres.
	 *
	 * These tests assert the ABSENCE of a query, which is the property that would
	 * silently regress: if a future change reintroduces `findByPublicId` on this
	 * path, every assertion about served bytes would still pass while the feature
	 * quietly stopped being stateless.
	 */
	describe("stateless links bypass the database", () => {
		const SECRET = "test-secret";
		const buildToken = (): string =>
			encodeStatelessLink(
				{
					parts: [{ telegramFileId: "tg-file-id", sizeBytes: 11, compressionAlgorithm: null }],
					sizeBytes: 11,
					fileName: "notes.txt",
					mimeType: "text/plain",
					createdAt: 1_700_000_000,
				},
				SECRET
			);

		beforeEach(() => {
			// The controller reads the secret from `config`, which is imported from
			// env.ts at module load. Pin it so the token built here verifies.
			vi.stubEnv("STATELESS_LINK_SECRET", SECRET);
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("serves the file without calling findByPublicId", async () => {
			const token = buildToken();
			vi.resetModules();
			// Re-import after stubbing so `config.statelessLinkSecret` sees the value.
			const { handleFileRedirect: redirect } = await import(
				"../src/presentation/http/controllers/file-controller"
			);

			// The upstream fetch is the only external call this path may make.
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("hello world", {
					status: 200,
					headers: { "content-type": "text/plain", "content-length": "11" },
				})
			);

			const req = requestWithPublicId(`http://localhost:4000/f/${token}.txt`, `${token}.txt`);
			const res = await redirect(req);

			expect(res.status).toBe(200);
			expect(await res.text()).toBe("hello world");
			// THE ASSERTION THAT MATTERS.
			expect(mockFindByPublicId).not.toHaveBeenCalled();
			// Content type comes from the signed payload, not from a row.
			expect(res.headers.get("content-type")).toBe("text/plain");
			// The extension is cosmetic but must not leak into the file name.
			expect(res.headers.get("content-disposition")).toContain('filename="notes.txt"');

			fetchSpy.mockRestore();
		});

		it("answers file info from the payload without a query", async () => {
			const token = buildToken();
			vi.resetModules();
			const { handleFileInfo: info } = await import(
				"../src/presentation/http/controllers/file-controller"
			);

			const req = requestWithPublicId(
				`http://localhost:4000/file/${token}.txt/info`,
				`${token}.txt`
			);
			const res = await info(req);

			expect(res.status).toBe(200);
			const body = await responseJson<FileInfoBody>(res);
			expect(body.file_name).toBe("notes.txt");
			expect(body.mime_type).toBe("text/plain");
			expect(body.size_bytes).toBe(11);
			expect(mockFindByPublicId).not.toHaveBeenCalled();
		});

		it("still falls through to the database for a legacy public_id", async () => {
			// The discriminator: a real nanoid is not a valid token, so the old path
			// must keep working untouched.
			mockFindByPublicId.mockImplementationOnce(async () => null);
			const req = requestWithPublicId(
				"http://localhost:4000/f/V1StGXR8_Z5jdHi6B-myT",
				"V1StGXR8_Z5jdHi6B-myT"
			);
			const res = await handleFileRedirect(req);
			expect(res.status).toBe(404);
			expect(mockFindByPublicId).toHaveBeenCalledWith("V1StGXR8_Z5jdHi6B-myT");
		});

		it("does NOT serve a token signed with another secret", async () => {
			// A forged link must 404 — never be served from the payload.
			//
			// It must ALSO not fall through to the database. Falling through was
			// the old behaviour, and it was wrong for two reasons: it gives an
			// attacker a different response ("reached the DB") than a valid token,
			// and it offers a downgrade attempt a second chance against the legacy
			// parser. A token-shaped value that fails verification is simply not
			// ours.
			const forged = encodeStatelessLink(
				{
					parts: [{ telegramFileId: "attacker", sizeBytes: 5, compressionAlgorithm: null }],
					sizeBytes: 5,
					fileName: "evil.txt",
					mimeType: "text/plain",
					createdAt: 1_700_000_000,
				},
				"not-our-secret"
			);
			mockFindByPublicId.mockImplementationOnce(async () => null);
			const req = requestWithPublicId(`http://localhost:4000/f/${forged}.txt`, `${forged}.txt`);
			const res = await handleFileRedirect(req);
			expect(res.status).toBe(404);
			expect(mockFindByPublicId).not.toHaveBeenCalled();
		});

		it("still lets a legacy nanoid reach the database", async () => {
			// The guard above must not swallow the old path. A 21-character nanoid
			// is not token-shaped, so it must still be looked up.
			mockFindByPublicId.mockImplementationOnce(async () => null);
			const req = requestWithPublicId(
				"http://localhost:4000/f/V1StGXR8_Z5jdHi6B-myT",
				"V1StGXR8_Z5jdHi6B-myT"
			);
			const res = await handleFileRedirect(req);
			expect(res.status).toBe(404);
			expect(mockFindByPublicId).toHaveBeenCalled();
		});
	});
});
