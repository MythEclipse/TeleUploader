import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MockServer = {
  port?: number;
  routes?: Record<string, unknown>;
  stop: ReturnType<typeof vi.fn>;
};

const mockServe = vi.fn(
  (options: { port?: number; routes?: Record<string, unknown> }): MockServer => {
    return {
      port: options.port,
      routes: options.routes,
      stop: vi.fn(),
    };
  },
);

vi.mock('../src/infrastructure/http/serve', () => ({
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
vi.mock('../src/presentation/http/controllers/web-api-controller', () => ({
  handleWebApiV1: vi.fn(() => Response.json({ error: 'Not Found' }, { status: 404 })),
}));

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
    expect(serveCallArgs).toHaveProperty('routes');
    expect(serveCallArgs.routes).toBeDefined();
    expect(serveCallArgs.routes).toHaveProperty('/api/upload');
    expect(serveCallArgs.routes).toHaveProperty('/f/:public_id');
    expect(serveCallArgs.routes).toHaveProperty('/file/:public_id/info');
    expect(serveCallArgs.routes).toHaveProperty('/health');
    expect(serveCallArgs.routes).toHaveProperty('/docs');
    expect(serveCallArgs.routes).toHaveProperty(['/swagger.json']);
    expect(serveCallArgs.routes).toHaveProperty('/');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/login');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/logout');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/auth/me');
    expect(serveCallArgs.routes).toHaveProperty('/api/v1/*');

    const uploadRoute = serveCallArgs.routes?.['/api/upload'] as { POST: RouteHandler };
    const res = await uploadRoute.POST(
      new Request('http://localhost/api/upload', { method: 'POST' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockHandleUpload).toHaveBeenCalledTimes(1);

    // GET /api/v1/* is intentionally public (read endpoints need no auth) —
    // it passes through to the raw handler (stubbed here to 404).
    const webApiRoute = serveCallArgs.routes?.['/api/v1/*'] as {
      GET: RouteHandler;
      POST: RouteHandler;
    };
    const publicRes = await webApiRoute.GET(new Request('http://localhost/api/v1/files'));

    expect(publicRes.status).toBe(404);
    expect(await publicRes.json()).toEqual({ error: 'Not Found' });

    // Write endpoints are auth-guarded — POST goes through requireAuth (401 here).
    const protectedRes = await webApiRoute.POST(
      new Request('http://localhost/api/v1/files', { method: 'POST' }),
    );

    expect(protectedRes.status).toBe(401);
    expect(await protectedRes.json()).toEqual({ error: 'Unauthorized' });
  });
});
