// @ts-nocheck
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// Mock db
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve())
}));

mock.module("../src/db/index", () => ({
  db: {
    insert: mockInsert
  },
  files: {}
}));

// Mock nanoid
mock.module("nanoid", () => ({
  nanoid: () => "mocked-nanoid-id"
}));

// Mock telegram utils
mock.module("../src/utils/telegram", () => ({
  forwardToStorage: mock(() => Promise.resolve({
    telegramFileId: "tg-file-id-123",
    telegramFileUniqueId: "tg-unique-id-abc",
    storageMessageId: 98765
  })),
  getBot: () => ({
    telegram: {
      getFile: mock(() => Promise.resolve({
        file_id: "tg-file-id-123",
        file_size: 1000,
        mime_type: "image/jpeg"
      }))
    }
  })
}));

describe("Upload Route Handler", () => {
  let handleUpload;

  beforeEach(async () => {
    mockInsert.mockClear();
    const uploadRoute = await import("../src/routes/upload");
    handleUpload = uploadRoute.handleUpload;
  });

  it("should reject unsupported content types with 400 status", async () => {
    const req = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: {
        "content-type": "text/plain"
      },
      body: "plain text data"
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unsupported content type");
  });

  it("should process JSON upload (base64) successfully", async () => {
    const req = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        file: Buffer.from("hello world").toString("base64"),
        fileName: "test.txt"
      })
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.public_id).toBe("mocked-nanoid-id");
    expect(body.telegram_file_id).toBe("tg-file-id-123");
    expect(body.telegram_file_unique_id).toBe("tg-unique-id-abc");
    expect(body.file_name).toBe("test.txt");
    expect(body.file_type).toBe("document");
  });

  it("should reject JSON upload without file key", async () => {
    const req = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        fileName: "test.txt"
      })
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid JSON");
  });

  it("should process multipart upload successfully", async () => {
    const formData = new FormData();
    const fileBlob = new Blob([Buffer.from("multipart hello")], { type: "text/plain" });
    formData.append("file", fileBlob, "test_multi.txt");

    const req = new Request("http://localhost:3000/api/upload", {
      method: "POST",
      body: formData
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.public_id).toBe("mocked-nanoid-id");
    expect(body.file_name).toBe("test_multi.txt");
  });

  afterAll(() => {
    mock.restore();
  });
});
