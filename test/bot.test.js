import { describe, it, expect, mock, spyOn, beforeEach } from "bun:test";
import logger from "../src/utils/logger.js";

// Mock environment
process.env.BOT_TOKEN = "8605908810:AAFpUzlIBktfd_7wpEj7zMJob2CFxvG-ZGY";
process.env.STORAGE_CHANNEL_ID = "-1003996572954";
process.env.BASE_URL = "https://tele.asepharyana.tech";

// Mock Telegraf
const mockLaunch = mock(() => Promise.resolve());
const mockCommand = mock();
const mockOn = mock();
const mockUse = mock();

mock.module("telegraf", () => {
  return {
    Telegraf: class {
      constructor(token) {
        this.token = token;
        this.launch = mockLaunch;
        this.command = mockCommand;
        this.on = mockOn;
        this.use = mockUse;
      }
    }
  };
});

// Mock database
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve())
}));
mock.module("../src/db/index.js", () => ({
  db: {
    insert: mockInsert
  },
  files: {}
}));

// Mock forwardToStorage
const mockForwardToStorage = mock(() => Promise.resolve({
  telegramFileId: "stored_file_id",
  telegramFileUniqueId: "stored_unique_id",
  storageMessageId: 9999
}));
mock.module("../src/utils/telegram.js", () => ({
  forwardToStorage: mockForwardToStorage
}));

const infoSpy = spyOn(logger, "info");
const errorSpy = spyOn(logger, "error");

describe("Telegram Bot Handler", () => {
  beforeEach(() => {
    mockLaunch.mockClear();
    mockCommand.mockClear();
    mockOn.mockClear();
    mockUse.mockClear();
    mockInsert.mockClear();
    mockForwardToStorage.mockClear();
    infoSpy.mockClear();
    errorSpy.mockClear();
  });

  it("should initialize and launch the bot", async () => {
    const { startBot } = await import("../src/bot.js");
    const bot = await startBot();

    expect(bot).toBeDefined();
    expect(mockCommand).toHaveBeenCalledWith("start", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(
      ["document", "photo", "video", "audio", "voice", "animation"],
      expect.any(Function)
    );
    expect(mockUse).toHaveBeenCalled();
    expect(mockLaunch).toHaveBeenCalled();
  });

  it("should handle /start command", async () => {
    const { startBot } = await import("../src/bot.js");
    await startBot();

    const startHandler = mockCommand.mock.calls.find(call => call[0] === "start")[1];
    const replyMock = mock(() => Promise.resolve());
    const ctx = {
      reply: replyMock
    };

    await startHandler(ctx);
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining("Halo"));
  });

  it("should process document uploads and save to db", async () => {
    const { startBot } = await import("../src/bot.js");
    await startBot();

    const fileHandler = mockOn.mock.calls[0][1];
    const replyMock = mock(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 42,
        document: {
          file_id: "doc_123",
          file_unique_id: "doc_uniq_123",
          file_size: 1024,
          mime_type: "application/pdf",
          file_name: "cv.pdf"
        }
      },
      from: {
        id: 999
      },
      reply: replyMock
    };

    await fileHandler(ctx);
    expect(mockForwardToStorage).toHaveBeenCalledWith("doc_123", "cv.pdf");
    expect(mockInsert).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining("File berhasil diupload"), expect.any(Object));
  });

  it("should reject uploads exceeding max size limit", async () => {
    const { startBot } = await import("../src/bot.js");
    await startBot();

    const fileHandler = mockOn.mock.calls[0][1];
    const replyMock = mock(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 42,
        photo: [{
          file_id: "photo_123",
          file_unique_id: "photo_uniq_123",
          file_size: 20 * 1024 * 1024, // 20MB exceeds 10MB limit
          mime_type: "image/jpeg"
        }]
      },
      from: {
        id: 999
      },
      reply: replyMock
    };

    await fileHandler(ctx);
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining("exceeds"));
  });
});
