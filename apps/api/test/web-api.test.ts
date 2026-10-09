import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IBucketRepository } from "../src/domain/ports/bucket-repository";

const MOCK_ORG = "org-a";

/**
 * Which user ids have a membership, and to which org.
 *
 * Keyed by user id on purpose. The resolver asks for `config.bootstrapAdminId`,
 * so the default below resolves that id to MOCK_ORG and the suite behaves as
 * before — but a test can now remove the entry (or point it elsewhere) to drive
 * the missing-membership path, which the previous `userId ? 'org-a' : null`
 * stub made impossible to reach.
 */
const MOCK_MEMBERSHIPS: Record<string, string> = {
	[process.env.BOOTSTRAP_ADMIN_ID || "bootstrap-admin"]: MOCK_ORG,
};

const mockBuckets = [
	{
		id: "uuid-1",
		name: "test-bucket",
		organizationId: MOCK_ORG,
		createdAt: new Date("2026-01-01"),
		updatedAt: new Date("2026-01-01"),
	},
];

let mockObjects: Record<string, unknown>[] = [];
let mockPrefixes: string[] = [];

vi.mock("../src/infrastructure/persistence/repositories/bucket-repository", () => ({
	DrizzleBucketRepository: class implements IBucketRepository {
		// `implements IBucketRepository` is deliberate: an untyped one-arg mock
		// drops the organization argument in JavaScript and answers for every
		// tenant, keeping the suite green while the real repository is broken.
		list = (organizationId: string) =>
			Promise.resolve(mockBuckets.filter((b) => b.organizationId === organizationId));
		findByName = (name: string, organizationId: string) =>
			Promise.resolve(
				mockBuckets.find((b) => b.name === name && b.organizationId === organizationId) || null
			);
		create = (name: string, organizationId: string) =>
			Promise.resolve({
				id: "new-uuid",
				name,
				organizationId,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
		delete = (name: string, organizationId: string) =>
			Promise.resolve(
				mockBuckets.some((b) => b.name === name && b.organizationId === organizationId)
			);
		exists = (name: string, organizationId: string) =>
			Promise.resolve(
				mockBuckets.some((b) => b.name === name && b.organizationId === organizationId)
			);
	},
}));

vi.mock("../src/infrastructure/persistence/repositories/organization-repository", () => ({
	DrizzleOrganizationRepository: class {
		// Resolves through MOCK_MEMBERSHIPS instead of answering 'org-a' for every
		// truthy user id. The old stub made the missing-membership branch
		// UNREACHABLE — which is how a deploy that 403'd every dashboard request
		// shipped behind a green suite. A test sets MOCK_MEMBERSHIPS = {} to
		// exercise the misconfiguration honestly.
		findOrganizationIdByUserId = (userId: string) =>
			Promise.resolve(MOCK_MEMBERSHIPS[userId] ?? null);
	},
}));
vi.mock("../src/infrastructure/persistence/repositories/file-repository", () => ({
	DrizzleFileRepository: class {
		findByBucketAndKey = () => Promise.resolve(null);
		listByPrefix = () => Promise.resolve({ objects: mockObjects, prefixes: mockPrefixes });
		softDelete = () => Promise.resolve(true);
		softDeleteBatch = () => Promise.resolve(0);
		countByBucket = () => Promise.resolve(0);
		findByBucket = () => Promise.resolve([]);
	},
}));

vi.mock("../src/infrastructure/telegram/bot-pool", () => ({
	botPool: {
		forwardToStorage: () =>
			Promise.resolve({
				telegramFileId: "mock-tg-id",
				telegramFileUniqueId: "mock-tg-unique",
				storageMessageId: 12345,
			}),
		getFileInfo: () =>
			Promise.resolve({
				file_size: 100,
				mime_type: "text/plain",
				file_path: "documents/file.txt",
				bot_token: "123456:ABC-DEF",
			}),
	},
}));

describe("Web API v1", () => {
	let handleWebApiV1: typeof import("../src/presentation/http/controllers/web-api-controller").handleWebApiV1;

	beforeAll(async () => {
		process.env.BOT_TOKEN = "123456:ABC-DEF";
		process.env.STORAGE_CHANNEL_ID = "-1001234567890";
		process.env.BASE_URL = "http://localhost:4000";
		process.env.DATABASE_URL = "postgresql://asephs:***@100.121.180.82:6432/test";
		const webApi = await import("../src/presentation/http/controllers/web-api-controller");
		handleWebApiV1 = webApi.handleWebApiV1;
	});

	beforeEach(() => {
		mockObjects = [];
		mockPrefixes = [];
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	it("should list buckets via GET /api/v1/buckets", async () => {
		const req = new Request("http://localhost:4000/api/v1/buckets");
		const res = await handleWebApiV1(req);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { buckets: { name: string }[] };
		expect(data).toHaveProperty("buckets");
		expect(Array.isArray(data.buckets)).toBe(true);
		expect(data.buckets[0].name).toBe("test-bucket");
	});

	it("should return 404 for unknown API path", async () => {
		const req = new Request("http://localhost:4000/api/v1/unknown");
		const res = await handleWebApiV1(req);
		expect(res.status).toBe(404);
		const data = (await res.json()) as { error: string };
		expect(data).toHaveProperty("error");
	});

	it("should return 400 for invalid bucket name on create", async () => {
		const req = new Request("http://localhost:4000/api/v1/buckets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "INVALID_NAME!" }),
		});
		const res = await handleWebApiV1(req);
		expect(res.status).toBe(400);
		const data = (await res.json()) as { error: string };
		expect(data.error).toContain("Invalid bucket name");
	});

	it("should normalize listed object sizeBytes to a number", async () => {
		mockObjects = [
			{
				s3Key: "tiny.txt",
				fileName: "tiny.txt",
				mimeType: "text/plain",
				sizeBytes: "12",
				fileType: "document",
				fileHash: "etag",
				createdAt: new Date("2026-01-01T00:00:00Z"),
				publicId: "public-id",
			},
		];

		const req = new Request("http://localhost:4000/api/v1/buckets/test-bucket/objects");
		const res = await handleWebApiV1(req);

		expect(res.status).toBe(200);
		const data = (await res.json()) as { objects: { sizeBytes: unknown }[] };
		expect(data.objects[0].sizeBytes).toBe(12);
		expect(typeof data.objects[0].sizeBytes).toBe("number");
	});
});
