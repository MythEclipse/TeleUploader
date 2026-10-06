import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../src/shared/logger/index';
import type { TelegramMediaMessage } from '../src/shared/utils/file';

// Mock environment
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
process.env.STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '-1001234567890';
process.env.BASE_URL = process.env.BASE_URL || 'https://upload.asepharyana.my.id';

type BotTestContext = {
  message: TelegramMediaMessage;
  from: { id: number };
  reply: ReturnType<typeof vi.fn>;
};

type BotFileHandler = (ctx: BotTestContext) => Promise<unknown>;
type StartHandler = (ctx: { reply: ReturnType<typeof vi.fn> }) => Promise<unknown>;

const getStartHandler = (): StartHandler => {
  return mockCommand.mock.calls.find((call) => call[0] === 'start')?.[1] as StartHandler;
};

const getFileHandler = (): BotFileHandler => {
  return mockOn.mock.calls[0][1] as BotFileHandler;
};

// Mock Telegraf
const mockLaunch = vi.fn(() => Promise.resolve());
const mockCommand = vi.fn();
const mockOn = vi.fn();
const mockUse = vi.fn();

class MockTelegraf {
  token: string;
  launch = mockLaunch;
  command = mockCommand;
  on = mockOn;
  use = mockUse;

  constructor(token: string) {
    this.token = token;
  }
}

vi.mock('telegraf', () => ({
  Telegraf: MockTelegraf,
}));

const infoSpy = vi.spyOn(logger, 'info');
const errorSpy = vi.spyOn(logger, 'error');

describe('Telegram Bot Handler', () => {
  let mockTelegramService: { forwardToStorage: ReturnType<typeof vi.fn> };
  let mockFileRepo: { findByUniqueId: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockLaunch.mockClear();
    mockCommand.mockClear();
    mockOn.mockClear();
    mockUse.mockClear();
    infoSpy.mockClear();
    errorSpy.mockClear();

    mockTelegramService = {
      forwardToStorage: vi.fn(() =>
        Promise.resolve({
          telegramFileId: 'stored_file_id',
          telegramFileUniqueId: 'stored_unique_id',
          storageMessageId: 9999,
        }),
      ),
    };

    mockFileRepo = {
      findByUniqueId: vi.fn((): Promise<unknown> => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve()),
    };
  });

  it('should initialize and launch the bot', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    const bot = await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    expect(bot).toBeDefined();
    expect(mockCommand).toHaveBeenCalledWith('start', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith(
      ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note'],
      expect.any(Function),
    );
    expect(mockUse).toHaveBeenCalled();
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('should handle /start command', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const startHandler = getStartHandler();
    const replyMock = vi.fn(() => Promise.resolve());
    const ctx = {
      reply: replyMock,
    };

    await startHandler(ctx);
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Halo'));
  });

  it('should process document uploads and save to db', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 42,
        document: {
          file_id: 'doc_123',
          file_unique_id: 'doc_uniq_123',
          file_size: 1024,
          mime_type: 'application/pdf',
          file_name: 'cv.pdf',
        },
      },
      from: {
        id: 999,
      },
      reply: replyMock,
    };

    await fileHandler(ctx);
    expect(mockTelegramService.forwardToStorage).toHaveBeenCalledWith(
      'doc_123',
      'cv.pdf',
      'document',
    );
    expect(mockFileRepo.create).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  it('should reject uploads exceeding max size limit', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 42,
        photo: [
          {
            file_id: 'photo_123',
            file_unique_id: 'photo_uniq_123',
            file_size: 20 * 1024 * 1024, // 20MB exceeds 10MB limit
            mime_type: 'image/jpeg',
          },
        ],
      },
      from: {
        id: 999,
      },
      reply: replyMock,
    };

    await fileHandler(ctx);
    expect(mockTelegramService.forwardToStorage).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
  });

  it('should return existing download link for duplicates without uploading again', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());

    mockFileRepo.findByUniqueId.mockResolvedValueOnce({
      publicId: 'already_exists_abc',
      telegramFileId: 'stored_file_id',
      telegramFileUniqueId: 'doc_uniq_123',
    });

    const ctx = {
      message: {
        message_id: 42,
        document: {
          file_id: 'doc_123',
          file_unique_id: 'doc_uniq_123',
          file_size: 1024,
          mime_type: 'application/pdf',
          file_name: 'cv.pdf',
        },
      },
      from: {
        id: 999,
      },
      reply: replyMock,
    };

    await fileHandler(ctx);
    expect(mockTelegramService.forwardToStorage).not.toHaveBeenCalled();
    expect(mockFileRepo.create).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('already_exists_abc'),
      expect.any(Object),
    );
  });

  it('should process sticker uploads', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 43,
        sticker: {
          file_id: 'sticker_123',
          file_unique_id: 'sticker_uniq_123',
          file_size: 1024,
        },
      },
      from: {
        id: 999,
      },
      reply: replyMock,
    };

    await fileHandler(ctx);
    expect(mockTelegramService.forwardToStorage).toHaveBeenCalledWith(
      'sticker_123',
      'file',
      'sticker',
    );
    expect(mockFileRepo.create).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  it('should process video note uploads', async () => {
    const { startBot } = await import('../src/interfaces/bot/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());
    const ctx = {
      message: {
        message_id: 44,
        video_note: {
          file_id: 'video_note_123',
          file_unique_id: 'video_note_uniq_123',
          file_size: 1024,
        },
      },
      from: {
        id: 999,
      },
      reply: replyMock,
    };

    await fileHandler(ctx);
    expect(mockTelegramService.forwardToStorage).toHaveBeenCalledWith(
      'video_note_123',
      'file',
      'video_note',
    );
    expect(mockFileRepo.create).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });
});
