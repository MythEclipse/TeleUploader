import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import logger from "../src/utils/logger.js";
import { config } from "../src/env.js";

// Mock Telegraf and fetch
mock.module("telegraf", () => {
  return {
    Telegraf: class {
      constructor(token) {
        this.token = token;
        this.api = {
          sendPhoto: mock(() => Promise.resolve({
            message_id: 12345,
            photo: [
              { file_id: "photo_id_low", file_unique_id: "unique_id_low" },
              { file_id: "photo_id_high", file_unique_id: "unique_id_high" }
            ]
          }))
        };
      }
    }
  };
});

const infoSpy = spyOn(logger, "info");
const errorSpy = spyOn(logger, "error");

describe("Telegram API Utilities", () => {
  let forwardToStorage, getFileInfo, getBot;

  beforeEach(async () => {
    infoSpy.mockClear();
    errorSpy.mockClear();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));

    // Import dynamically so mocking is applied first
    const telegramUtils = await import("../src/utils/telegram.js");
    forwardToStorage = telegramUtils.forwardToStorage;
    getFileInfo = telegramUtils.getFileInfo;
    getBot = telegramUtils.getBot;
  });

  afterEach(() => {
    delete global.fetch;
  });

  describe("getBot", () => {
    it("should return the telegraf bot instance", () => {
      const bot = getBot();
      expect(bot).toBeDefined();
      expect(bot.api).toBeDefined();
    });
  });

  describe("forwardToStorage", () => {
    it("should forward photo to storage chat and return file details", async () => {
      const chunk = Buffer.from("fake photo data");
      const fileName = "test_photo.jpg";
      const result = await forwardToStorage(chunk, fileName, false);

      expect(result).toEqual({
        telegramFileId: "photo_id_high",
        telegramFileUniqueId: "unique_id_high",
        storageMessageId: 12345
      });
      expect(infoSpy).toHaveBeenCalledWith("File forwarded to storage", {
        fileName,
        message: 12345
      });
    });

    it("should handle error when forwarding fails", async () => {
      const bot = getBot();
      bot.api.sendPhoto = mock(() => Promise.reject(new Error("Telegram send failed")));

      const chunk = Buffer.from("fake photo data");
      const fileName = "test_photo.jpg";

      await expect(forwardToStorage(chunk, fileName, false)).rejects.toThrow("Telegram send failed");
      expect(errorSpy).toHaveBeenCalledWith("Failed to forward file to storage", {
        fileName,
        error: "Telegram send failed"
      });
    });
  });

  describe("getFileInfo", () => {
    it("should fetch file details successfully", async () => {
      global.fetch = mock((url, init) => {
        if (url.endsWith("getFile")) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            result: { file_id: "some_file_id" }
          })));
        } else if (url.endsWith("getInfo")) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            result: {
              file_size: 98765,
              mime_type: "image/jpeg",
              file_path: "photos/file_0.jpg"
            }
          })));
        }
        return Promise.reject(new Error("Unknown URL"));
      });

      const result = await getFileInfo("some_file_id", "some_unique_id");

      expect(result).toEqual({
        file_size: 98765,
        mime_type: "image/jpeg",
        file_path: "photos/file_0.jpg"
      });
    });

    it("should handle error when getFile fails", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        ok: false,
        description: "Bad Request: file_id invalid"
      }))));

      await expect(getFileInfo("invalid_file_id", "invalid_unique_id")).rejects.toThrow("Bad Request: file_id invalid");
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
