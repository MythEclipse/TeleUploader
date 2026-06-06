import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { TelegramMediaMessage } from '../src/utils/file';
import logger from '../src/utils/logger';

// Mock environment
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
process.env.STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '-1001234567890';
process.env.BASE_URL = process.env.BASE_URL || 'https://tele.asepharyana.my.id';

type BotTestContext = {
  message: TelegramMediaMessage;
  from: { id: number };
  reply: ReturnType<typeof mock>;
};

type BotFileHandler = (ctx: BotTestContext) => Promise<unknown>;
type StartHandler = (ctx: { reply: ReturnType<typeof mock> }) => Promise<unknown>;

const getStartHandler = (): StartHandler => {
  return mockCommand.mock.calls.find((call) => call[0] === 'start')?.[1] as StartHandler;
};

const getFileHandler = (): BotFileHandler => {
  return mockOn.mock.calls[0][1] as BotFileHandler;
};

// Mock Telegraf
const mockLaunch = mock(() => Promise.resolve());
const mockCommand = mock();
const mockOn = mock();
const mockUse = mock();

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

mock.module('telegraf', () => ({
  Telegraf: MockTelegraf,
}));

// Mock database
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));
type ExistingFile = {
  publicId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
};

const mockFindFileByUniqueId = mock((): Promise<ExistingFile | null> => Promise.resolve(null));

mock.module('../src/db/index', () => ({
  db: {
    insert: mockInsert,
  },
  files: {},
}));

mock.module('../src/db/files', () => ({
  findFileByUniqueId: mockFindFileByUniqueId,
}));

// Mock forwardToStorage
const mockForwardToStorage = mock(() =>
  Promise.resolve({
    telegramFileId: 'stored_file_id',
    telegramFileUniqueId: 'stored_unique_id',
    storageMessageId: 9999,
  }),
);
mock.module('../src/utils/telegram', () => ({
  forwardToStorage: mockForwardToStorage,
}));

const infoSpy = spyOn(logger, 'info');
const errorSpy = spyOn(logger, 'error');

describe('Telegram Bot Handler', () => {
  beforeEach(() => {
    mockLaunch.mockClear();
    mockCommand.mockClear();
    mockOn.mockClear();
    mockUse.mockClear();
    mockInsert.mockClear();
    mockFindFileByUniqueId.mockClear();
    mockFindFileByUniqueId.mockResolvedValue(null);
    mockForwardToStorage.mockClear();
    infoSpy.mockClear();
    errorSpy.mockClear();
  });

  it('should initialize and launch the bot', async () => {
    const { startBot } = await import('../src/bot');
    const bot = await startBot();

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
    const { startBot } = await import('../src/bot');
    await startBot();

    const startHandler = getStartHandler();
    const replyMock = mock(() => Promise.resolve());
    const ctx = {
      reply: replyMock,
    };

    await startHandler(ctx);
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Halo'));
  });

  it('should process document uploads and save to db', async () => {
    const { startBot } = await import('../src/bot');
    await startBot();

    const fileHandler = getFileHandler();
    const replyMock = mock(() => Promise.resolve());
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
    expect(mockForwardToStorage).toHaveBeenCalledWith('doc_123', 'cv.pdf', 'document');
    expect(mockInsert).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  it('should reject uploads exceeding max size limit', async () => {
    const { startBot } = await import('../src/bot');
    await startBot();

    const fileHandler = getFileHandler();
    const replyMock = mock(() => Promise.resolve());
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
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
  });

  it('should return existing download link for duplicates without uploading again', async () => {
    const { startBot } = await import('../src/bot');
    await startBot();

    const fileHandler = getFileHandler();
    const replyMock = mock(() => Promise.resolve());

    mockFindFileByUniqueId.mockResolvedValueOnce({
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
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('already_exists_abc'),
      expect.any(Object),
    );
  });

  it('should process sticker uploads', async () => {
    const { startBot } = await import('../src/bot');
    await startBot();

    const fileHandler = getFileHandler();
    const replyMock = mock(() => Promise.resolve());
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
    expect(mockForwardToStorage).toHaveBeenCalledWith('sticker_123', 'file', 'sticker');
    expect(mockInsert).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  it('should process video note uploads', async () => {
    const { startBot } = await import('../src/bot');
    await startBot();

    const fileHandler = getFileHandler();
    const replyMock = mock(() => Promise.resolve());
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
    expect(mockForwardToStorage).toHaveBeenCalledWith('video_note_123', 'file', 'video_note');
    expect(mockInsert).toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('File berhasil diupload'),
      expect.any(Object),
    );
  });

  afterAll(() => {
    mock.restore();
  });
});
