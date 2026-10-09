import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// `File` is imported ALIASED: the global DOM `File` is in scope in a DOM-typed
// lib, so an unaliased `import type { File }` loses to it and the fixture below
// type-checks against `Blob`-ish lib types instead of the domain entity.
import type { File as FileEntity, NewFile } from '../src/domain/entities/file';
import type { IFileRepository } from '../src/domain/ports/file-repository';
import type { ITelegramService } from '../src/domain/ports/telegram-service';
import type { TelegramMediaMessage } from '../src/infrastructure/file';
import logger from '../src/infrastructure/observability/logger';

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

/**
 * A complete {@link File} entity, for tests that need `findByUniqueId` to
 * resolve something.
 *
 * COMPLETE ON PURPOSE. This fixture used to be a three-field object literal
 * (`publicId`, `telegramFileId`, `telegramFileUniqueId`) passed straight to
 * `mockResolvedValueOnce`, which is 22 fields short of the entity — and the
 * compiler was the only thing that noticed, once the surrounding mock was
 * properly typed:
 *
 *     error TS2740: Type '{ publicId: string; telegramFileId: string; … }' is
 *     missing the following properties from type 'File': id, storageChatId,
 *     storageMessageId, fileName, and 19 more.
 *
 * A short literal compiles fine whenever the mock is loosely typed, and then
 * quietly supplies `undefined` for every field a caller might read. Naming every
 * field here means adding one to the entity is a compile error in this helper —
 * which is the only place that should have to answer for it.
 *
 * @param publicId - The public identifier to expose.
 * @returns A fully-populated `File` with deterministic values.
 */
const existingFile = (publicId: string): FileEntity => ({
  id: 'file-id',
  publicId,
  telegramFileId: 'stored_file_id',
  telegramFileUniqueId: 'doc_uniq_123',
  storageChatId: -1001234567890,
  storageMessageId: 42,
  fileName: 'document.txt',
  mimeType: 'text/plain',
  sizeBytes: 100,
  fileType: 'document',
  uploaderId: 0,
  fileHash: 'abc123',
  archiveTelegramFileId: null,
  archiveStorageMessageId: null,
  archiveFileName: null,
  archiveEntryName: null,
  archiveMimeType: null,
  archiveSizeBytes: null,
  bucketId: null,
  s3Key: null,
  storageBackend: 'telegram',
  isDeleted: false,
  multipartUploadId: null,
  partCount: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
});

const infoSpy = vi.spyOn(logger, 'info');
const errorSpy = vi.spyOn(logger, 'error');

describe('Telegram Bot Handler', () => {
  /**
   * The doubles are typed by the SUBSET each test actually implements.
   *
   * They used to be declared as bare object literals —
   * `{ forwardToStorage: Mock }` and `{ findByUniqueId: Mock; create: Mock }` —
   * which is a SUBSET of `ITelegramService` / `IFileRepository`. Passing a
   * structural subset where the full port is required is a type error, so every
   * `startBot({ telegramService, fileRepo })` call failed with TS2740/TS2741:
   * "'getFileInfo' is missing" and "'findByHash', 'findByPublicId',
   * 'findByBucketAndKey', 'listByPrefix', and 4 more".
   *
   * `startBot` takes the FULL `ITelegramService` and `IFileRepository`, so a
   * partial double is a type error regardless of how it is spelled — `Pick<…>`
   * names the subset without making it assignable, which is the proof that the
   * real defect was INCOMPLETENESS rather than a loose annotation.
   *
   * So both doubles now implement every method of their port. The stubs answer
   * with values no test asserts on, and that is the point: a double that is
   * complete by construction cannot silently drop a method the code under test
   * starts calling, which is precisely how the old pair rotted unnoticed.
   */
  let mockTelegramService: ITelegramService;
  let mockFileRepo: IFileRepository;

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
      // Not exercised by any bot-handler test — the handler never resolves a
      // Telegram file. Implemented so the double satisfies the whole port: a
      // method missing here is a compile error rather than a runtime surprise if
      // the handler starts calling it.
      getFileInfo: vi.fn(() =>
        Promise.resolve({
          file_id: 'stored_file_id',
          file_size: 1,
          mime_type: 'application/octet-stream',
          file_path: 'documents/file.dat',
          bot_token: '123456:ABC-DEF',
        }),
      ),
    };

    // Every method of the port. Only `findByUniqueId` and `create` are asserted
    // on; the rest return their empty value, which is both correct for a fresh
    // double and the value a test that reached them would expect.
    mockFileRepo = {
      findByUniqueId: vi.fn(() => Promise.resolve(null)),
      findByHash: vi.fn(() => Promise.resolve(null)),
      findByPublicId: vi.fn(() => Promise.resolve(null)),
      findByBucketAndKey: vi.fn(() => Promise.resolve(null)),
      create: vi.fn((file: NewFile) =>
        Promise.resolve({
          // A stored `File` must be an echo of the input plus the fields the
          // repository fills in. Returning `undefined` (what this used to
          // resolve) made `create` unusable by any caller that read the result.
          ...file,
          id: 'file-id',
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        }),
      ),
      listByPrefix: vi.fn(() => Promise.resolve({ objects: [], prefixes: [] })),
      softDelete: vi.fn(() => Promise.resolve(false)),
      softDeleteBatch: vi.fn(() => Promise.resolve(0)),
      countByBucket: vi.fn(() => Promise.resolve(0)),
      findOrphansByBucket: vi.fn(() => Promise.resolve([])),
    };
  });

  it('should initialize and launch the bot', async () => {
    const { startBot } = await import('../src/presentation/telegram/handler');
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
    const { startBot } = await import('../src/presentation/telegram/handler');
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
    const { startBot } = await import('../src/presentation/telegram/handler');
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
    const { startBot } = await import('../src/presentation/telegram/handler');
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
    const { startBot } = await import('../src/presentation/telegram/handler');
    await startBot({
      telegramService: mockTelegramService,
      fileRepo: mockFileRepo,
    });

    const fileHandler = getFileHandler();
    const replyMock = vi.fn(() => Promise.resolve());

    // The port type erases the mock, so the call-queue API is reached through
    // `vi.mocked()` at the point of use — the mock type is not part of the
    // dependency the handler receives, which is exactly right.
    vi.mocked(mockFileRepo.findByUniqueId).mockResolvedValueOnce(
      existingFile('already_exists_abc'),
    );

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
    const { startBot } = await import('../src/presentation/telegram/handler');
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
    const { startBot } = await import('../src/presentation/telegram/handler');
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
