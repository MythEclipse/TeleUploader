import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MockServer = {
  port?: number;
  close: ReturnType<typeof vi.fn>;
};

// P2b: the server is now Hono's `@hono/node-server` adapter, which receives
// `{ fetch, port }` instead of the shim's `{ port, routes, fetch }`. Route
// ordering is asserted in hono-routing.test.ts against a live Hono app; here we
// only assert that the process boots and wires the adapter correctly.
const mockServe = vi.fn((options: { port?: number; fetch: unknown }): MockServer => {
  return {
    port: options.port,
    close: vi.fn(),
  };
});

vi.mock('@hono/node-server', () => ({
  serve: mockServe,
}));

type RouteHandler = (req: Request) => Response | Promise<Response>;

const mockStartBot = vi.fn(() =>
  Promise.resolve({
    stop: vi.fn(),
  }),
);
const mockHandleUpload = vi.fn((_req: Request) => Promise.resolve(Response.json({ ok: true })));
const mockRequireAuth = vi.fn(
  (_handler: RouteHandler): RouteHandler =>
    async () =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
);

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/presentation/telegram/handler', () => ({
  startBot: mockStartBot,
}));

vi.mock('../src/infrastructure/persistence/drizzle/migrate', () => ({
  runMigration: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/presentation/http/controllers/upload-controller', () => ({
  handleUpload: mockHandleUpload,
}));
vi.mock('../src/presentation/http/controllers/file-controller', () => ({
  handleFileRedirect: vi.fn(),
  handleFileInfo: vi.fn(),
}));
vi.mock('../src/presentation/http/controllers/health-controller', () => ({
  handleHealth: vi.fn(),
}));
vi.mock('../src/presentation/http/controllers/auth-controller', () => ({
  handleLogin: vi.fn(),
  handleLogout: vi.fn(),
  handleMe: vi.fn(),
}));
vi.mock('../src/presentation/http/controllers/home-controller', () => ({
  handleHome: vi.fn(() => new Response('<html>home</html>')),
}));
vi.mock('../src/presentation/http/controllers/s3-controller', () => ({
  handleS3Request: vi.fn(() => new Response('Not Found', { status: 404 })),
}));
vi.mock('../src/presentation/http/controllers/web-api-controller', () => {
  const stub = () => Response.json({ error: 'Not Found' }, { status: 404 });
  return {
    handleWebApiV1: vi.fn(stub),
    // P2c: the oRPC composition root imports these individually.
    handleListBucketsV1: vi.fn(stub),
    handleCreateBucketV1: vi.fn(stub),
    handleDeleteBucketV1: vi.fn(stub),
    handleListObjectsV1: vi.fn(stub),
    handleCopyObjectV1: vi.fn(stub),
    handleDeleteObjectV1: vi.fn(stub),
    handleDownloadObjectV1: vi.fn(stub),
  };
});

vi.mock('../src/presentation/http/middleware/auth', () => ({
  requireAuth: mockRequireAuth,
}));

vi.mock('../src/presentation/http/middleware/rate-limit', () => ({
  cleanupRateLimitCache: vi.fn(),
  clearRateLimitCache: vi.fn(),
  checkRateLimit: vi.fn(() => true),
  getRateLimitStats: vi.fn(() => ({})),
  withRateLimit: <T extends Request>(
    handler: (req: T) => Promise<Response>,
  ): ((req: T) => Promise<Response>) => handler,
}));

describe('Bootstrap Server', () => {
  beforeEach(() => {
    mockServe.mockClear();
    mockStartBot.mockClear();
    mockHandleUpload.mockClear();
    mockRequireAuth.mockClear();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should bootstrap the application successfully', async () => {
    await import('../src/index');

    expect(mockServe).toHaveBeenCalled();
    expect(mockStartBot).toHaveBeenCalled();

    const serveCallArgs = mockServe.mock.calls[0][0];
    expect(serveCallArgs).toHaveProperty('port');
    expect(typeof serveCallArgs.fetch).toBe('function');

    // Drive the real Hono app the adapter was handed, rather than reaching into a
    // route table: this is the handler the Node server actually calls.
    const fetchHandler = serveCallArgs.fetch as (req: Request) => Promise<Response>;

    const uploadRes = await fetchHandler(
      new Request('http://localhost/api/upload', { method: 'POST' }),
    );
    expect(uploadRes.status).toBe(200);
    expect(await uploadRes.json()).toEqual({ ok: true });
    expect(mockHandleUpload).toHaveBeenCalledTimes(1);

    // GET /api/v1/* is intentionally public (read endpoints need no auth) --
    // it passes through to the raw handler (stubbed here to 404).
    const publicRes = await fetchHandler(new Request('http://localhost/api/v1/files'));
    expect(publicRes.status).toBe(404);
    expect(await publicRes.json()).toEqual({ error: 'Not Found' });

    // Write endpoints are auth-guarded -- POST goes through requireAuth (401 here).
    const protectedRes = await fetchHandler(
      new Request('http://localhost/api/v1/files', { method: 'POST' }),
    );

    expect(protectedRes.status).toBe(401);
    expect(await protectedRes.json()).toEqual({ error: 'Unauthorized' });
  });
});
