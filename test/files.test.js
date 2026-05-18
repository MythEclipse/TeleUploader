import { describe, it, expect, mock, spyOn, beforeEach } from "bun:test";
import logger from "../src/utils/logger.js";

// Mock database layer
const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      limit: mock(() => Promise.resolve([]))
    }))
  }))
}));

mock.module("../src/db/index.js", () => ({
  db: {
    select: mockSelect
  },
  files: {
    publicId: {
      equals: (val) => ({ type: "equals", value: val })
    }
  }
}));

// Mock telegram utils
const mockGetFile = mock(() => Promise.resolve({ file_path: "photos/file_0.jpg" }));
mock.module("../src/utils/telegram.js", () => ({
  getBot: () => ({
    api: {
      getFile: mockGetFile
    }
  })
}));

// Mock rateLimit
const mockCheckRateLimit = mock(() => true);
mock.module("../src/utils/rateLimit.js", () => ({
  checkRateLimit: mockCheckRateLimit
}));

describe("File Route Handlers", () => {
  let handleFileRedirect, handleFileInfo;

  beforeEach(async () => {
    mockSelect.mockClear();
    mockGetFile.mockClear();
    mockCheckRateLimit.mockClear();

    // Set up mock token
    process.env.BOT_TOKEN = "123456:ABC-DEF";

    const filesRoute = await import("../src/routes/files.js");
    handleFileRedirect = filesRoute.handleFileRedirect;
    handleFileInfo = filesRoute.handleFileInfo;
  });

  describe("handleFileRedirect", () => {
    it("should return 429 if rate limit is exceeded", async () => {
      mockCheckRateLimit.mockImplementationOnce(() => false);
      const req = new Request("http://localhost:3000/f/test-id");

      const res = await handleFileRedirect(req, { params: { public_id: "test-id" } });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe("Rate limit exceeded");
    });

    it("should return 404 if file is not found in database", async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([])
          })
        })
      }));

      const req = new Request("http://localhost:3000/f/missing-id");
      const res = await handleFileRedirect(req, { params: { public_id: "missing-id" } });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("File not found");
    });

    it("should redirect to telegram file url if file is found", async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              id: "uuid-123",
              publicId: "test-id",
              telegramFileId: "tg-file-id",
              fileName: "test.jpg"
            }])
          })
        })
      }));

      const req = new Request("http://localhost:3000/f/test-id");
      const res = await handleFileRedirect(req, { params: { public_id: "test-id" } });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://api.telegram.org/file/bot123456:ABC-DEF/photos/file_0.jpg");
    });

    it("should return 500 on database or external errors", async () => {
      mockSelect.mockImplementationOnce(() => {
        throw new Error("DB Connection Error");
      });

      const req = new Request("http://localhost:3000/f/test-id");
      const res = await handleFileRedirect(req, { params: { public_id: "test-id" } });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Server error");
    });
  });

  describe("handleFileInfo", () => {
    it("should return 404 if file is not found in database", async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([])
          })
        })
      }));

      const req = new Request("http://localhost:3000/file/missing-id/info");
      const res = await handleFileInfo(req, { params: { public_id: "missing-id" } });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("File not found");
    });

    it("should return file info JSON if file is found", async () => {
      const dbFile = {
        publicId: "test-id",
        fileName: "image.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        fileType: "photo",
        uploaderId: 99999,
        createdAt: new Date("2026-05-18T00:00:00.000Z")
      };

      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([dbFile])
          })
        })
      }));

      const req = new Request("http://localhost:3000/file/test-id/info");
      const res = await handleFileInfo(req, { params: { public_id: "test-id" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        public_id: "test-id",
        file_name: "image.png",
        mime_type: "image/png",
        size_bytes: 2048,
        file_type: "photo",
        uploader_id: 99999,
        created_at: "2026-05-18T00:00:00.000Z"
      });
    });

    it("should return 500 on database or external errors", async () => {
      mockSelect.mockImplementationOnce(() => {
        throw new Error("DB Connection Error");
      });

      const req = new Request("http://localhost:3000/file/test-id/info");
      const res = await handleFileInfo(req, { params: { public_id: "test-id" } });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Server error");
    });
  });
});
