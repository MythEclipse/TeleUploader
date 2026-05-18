// @ts-nocheck
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock db
let mockSelectResult: any[] = [];

const mockLimit = mock(() => Promise.resolve(mockSelectResult));
const mockWhere = mock(() => ({
  limit: mockLimit,
}));
const mockFrom = mock(() => ({
  where: mockWhere,
}));
const mockSelect = mock(() => ({
  from: mockFrom,
}));

const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));

mock.module('../src/db/index', () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
  },
  files: {},
}));

// Mock nanoid
mock.module('nanoid', () => ({
  nanoid: () => 'mocked-nanoid-id',
}));

// Mock telegram utils
const mockForwardToStorage = mock(() =>
  Promise.resolve({
    telegramFileId: 'tg-file-id-123',
    telegramFileUniqueId: 'tg-unique-id-abc',
    storageMessageId: 98765,
  }),
);

const mockGetFile = mock(() =>
  Promise.resolve({
    file_id: 'tg-file-id-123',
    file_size: 1000,
    mime_type: 'image/jpeg',
  }),
);

mock.module('../src/utils/telegram', () => ({
  forwardToStorage: mockForwardToStorage,
  getBot: () => ({
    telegram: {
      getFile: mockGetFile,
    },
  }),
}));

describe('Upload Route Handler', () => {
  let handleUpload: any;

  beforeEach(async () => {
    mockInsert.mockClear();
    mockSelect.mockClear();
    mockFrom.mockClear();
    mockWhere.mockClear();
    mockLimit.mockClear();
    mockForwardToStorage.mockClear();
    mockGetFile.mockClear();
    mockSelectResult = [];
    const uploadRoute = await import('../src/routes/upload');
    handleUpload = uploadRoute.handleUpload;
  });

  it('should reject unsupported content types with 400 status', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'plain text data',
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported content type');
  });

  it('should process JSON upload (base64) successfully', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        file: Buffer.from('hello world').toString('base64'),
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.public_id).toBe('mocked-nanoid-id');
    expect(body.telegram_file_id).toBe('tg-file-id-123');
    expect(body.telegram_file_unique_id).toBe('tg-unique-id-abc');
    expect(body.file_name).toBe('test.txt');
    expect(body.file_type).toBe('document');
  });

  it('should reject JSON upload without file key', async () => {
    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid JSON');
  });

  it('should process multipart upload successfully', async () => {
    const formData = new FormData();
    const fileBlob = new Blob([Buffer.from('multipart hello')], { type: 'text/plain' });
    formData.append('file', fileBlob, 'test_multi.txt');

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData,
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.public_id).toBe('mocked-nanoid-id');
    expect(body.file_name).toBe('test_multi.txt');
  });

  it('should deduplicate multipart upload if hash exists', async () => {
    mockSelectResult = [
      {
        publicId: 'existing-id-123',
        telegramFileId: 'existing-tg-id',
        telegramFileUniqueId: 'existing-tg-unique',
        storageChatId: 12345,
        storageMessageId: 67890,
        fileName: 'existing_name.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
        fileType: 'document',
        uploaderId: 0,
        createdAt: new Date('2026-05-18T00:00:00.000Z'),
        updatedAt: new Date('2026-05-18T00:00:00.000Z'),
      },
    ];

    const formData = new FormData();
    const fileBlob = new Blob([Buffer.from('multipart hello')], { type: 'text/plain' });
    formData.append('file', fileBlob, 'test_multi.txt');

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      body: formData,
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.public_id).toBe('existing-id-123');
    expect(body.telegram_file_id).toBe('existing-tg-id');
    expect(body.telegram_file_unique_id).toBe('existing-tg-unique');
    expect(body.file_name).toBe('existing_name.txt');
    expect(body.download_url).toContain('/f/existing-id-123');

    // DB query happened
    expect(mockSelect).toHaveBeenCalled();
    // No telegram upload happened
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    // No db insertion happened
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should deduplicate JSON upload if hash exists', async () => {
    mockSelectResult = [
      {
        publicId: 'existing-json-id',
        telegramFileId: 'existing-tg-json-id',
        telegramFileUniqueId: 'existing-tg-json-unique',
        storageChatId: 12345,
        storageMessageId: 67890,
        fileName: 'existing_json.txt',
        mimeType: 'text/plain',
        sizeBytes: 200,
        fileType: 'document',
        uploaderId: 0,
        createdAt: new Date('2026-05-18T00:00:00.000Z'),
        updatedAt: new Date('2026-05-18T00:00:00.000Z'),
      },
    ];

    const req = new Request('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        file: Buffer.from('hello world').toString('base64'),
        fileName: 'test.txt',
      }),
    });

    const res = await handleUpload(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.public_id).toBe('existing-json-id');
    expect(body.telegram_file_id).toBe('existing-tg-json-id');
    expect(body.file_name).toBe('existing_json.txt');
    expect(body.download_url).toContain('/f/existing-json-id');

    // DB query happened
    expect(mockSelect).toHaveBeenCalled();
    // No telegram upload happened
    expect(mockForwardToStorage).not.toHaveBeenCalled();
    // No db insertion happened
    expect(mockInsert).not.toHaveBeenCalled();
  });

  afterAll(() => {
    mock.restore();
  });
});
