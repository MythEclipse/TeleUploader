import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

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
  uploader_id: number;
  created_at: string;
};

type JsonBody = ErrorBody | FileInfoBody | Record<string, unknown>;

type MockFileRecord = Record<string, unknown>;

type MockSelectChain = {
  from: () => {
    where: () => {
      limit: () => Promise<MockFileRecord[]>;
    };
  };
};

const requestWithPublicId = (url: string, publicId: string): RequestWithParams => {
  const req = new Request(url) as RequestWithParams;
  req.params = { public_id: publicId };
  return req;
};

const responseJson = async <T extends JsonBody>(res: Response): Promise<T> => {
  return (await res.json()) as T;
};

// Mock database layer
const emptySelectChain = (): MockSelectChain => ({
  from: () => ({
    where: () => ({
      limit: () => Promise.resolve([]),
    }),
  }),
});

const mockSelect = mock(() => emptySelectChain());

mock.module('../src/db/files', () => ({
  findFileByPublicId: async () => {
    const chain = mockSelect();
    return (await chain.from().where().limit())[0] || null;
  },
}));

// Mock telegram utils
const mockGetFile = mock(() => Promise.resolve({ file_path: 'photos/file_0.jpg' }));
mock.module('../src/utils/telegram', () => ({
  getBot: () => ({
    telegram: {
      getFile: mockGetFile,
    },
  }),
}));

// Mock rateLimit
const mockCheckRateLimit = mock(() => true);
mock.module('../src/utils/rateLimit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

describe('File Route Handlers', () => {
  let handleFileRedirect: typeof import('../src/routes/files').handleFileRedirect;
  let handleFileInfo: typeof import('../src/routes/files').handleFileInfo;

  beforeEach(async () => {
    mockSelect.mockClear();
    mockGetFile.mockClear();
    mockCheckRateLimit.mockClear();

    // Set up mock token
    process.env.BOT_TOKEN = '123456:ABC-DEF';

    const filesRoute = await import('../src/routes/files');
    handleFileRedirect = filesRoute.handleFileRedirect;
    handleFileInfo = filesRoute.handleFileInfo;
  });

  describe('handleFileRedirect', () => {
    it('should return 429 if rate limit is exceeded', async () => {
      mockCheckRateLimit.mockImplementationOnce(() => false);
      const req = requestWithPublicId('http://localhost:3000/f/test-id', 'test-id');

      const res = await handleFileRedirect(req);
      expect(res.status).toBe(429);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('Rate limit exceeded');
    });

    it('should return 404 if file is not found in database', async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }));

      const req = requestWithPublicId('http://localhost:3000/f/missing-id', 'missing-id');
      const res = await handleFileRedirect(req);
      expect(res.status).toBe(404);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('File not found');
    });

    it('should redirect to telegram file url if file is found', async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'uuid-123',
                  publicId: 'test-id',
                  telegramFileId: 'tg-file-id',
                  fileName: 'test.jpg',
                },
              ]),
          }),
        }),
      }));

      const req = requestWithPublicId('http://localhost:3000/f/test-id', 'test-id');
      const res = await handleFileRedirect(req);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(
        'https://api.telegram.org/file/bot123456:ABC-DEF/photos/file_0.jpg',
      );
    });

    it('should return 500 on database or external errors', async () => {
      mockSelect.mockImplementationOnce(() => {
        throw new Error('DB Connection Error');
      });

      const req = requestWithPublicId('http://localhost:3000/f/test-id', 'test-id');
      const res = await handleFileRedirect(req);
      expect(res.status).toBe(500);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('Server error');
    });
  });

  describe('handleFileInfo', () => {
    it('should return 404 if file is not found in database', async () => {
      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }));

      const req = requestWithPublicId('http://localhost:3000/file/missing-id/info', 'missing-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(404);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('File not found');
    });

    it('should return file info JSON if file is found', async () => {
      const dbFile = {
        publicId: 'test-id',
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        fileType: 'photo',
        uploaderId: 99999,
        createdAt: new Date('2026-05-18T00:00:00.000Z'),
      };

      mockSelect.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([dbFile]),
          }),
        }),
      }));

      const req = requestWithPublicId('http://localhost:3000/file/test-id/info', 'test-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(200);
      const body = await responseJson<FileInfoBody>(res);
      expect(body).toEqual({
        public_id: 'test-id',
        file_name: 'image.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        file_type: 'photo',
        uploader_id: 99999,
        created_at: '2026-05-18T00:00:00.000Z',
      });
    });

    it('should return 500 on database or external errors', async () => {
      mockSelect.mockImplementationOnce(() => {
        throw new Error('DB Connection Error');
      });

      const req = requestWithPublicId('http://localhost:3000/file/test-id/info', 'test-id');
      const res = await handleFileInfo(req);
      expect(res.status).toBe(500);
      const body = await responseJson<ErrorBody>(res);
      expect(body.error).toBe('Server error');
    });
  });

  afterAll(() => {
    mock.restore();
  });
});
