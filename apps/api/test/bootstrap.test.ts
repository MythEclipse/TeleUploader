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
const mockHandleHealth = vi.fn();
vi.mock('../src/presentation/http/controllers/health-controller', () => ({
  handleHealth: mockHandleHealth,
}));
vi.mock('../src/presentation/http/controllers/auth-controller', () => ({
  handleLogin: vi.fn(),
  handleLogout: vi.fn(),
  handleMe: vi.fn(),
}));
// P4: `GET /` is served by spa-controller, not home-controller. app.ts never
// imported home-controller, so this mock was already a no-op that happened to
// be harmless — but a mock of an unmounted module is exactly the shape that
// let a route deletion pass unnoticed. Mock the module that IS mounted.
// Returning `null` here means "no SPA configured", which is the honest default
// for this suite: WEB_DIST_PATH is unset and there is no built dashboard.
vi.mock('../src/presentation/http/controllers/spa-controller', () => ({
  serveSpaIndex: vi.fn(() => Promise.resolve(null)),
  serveSpaFile: vi.fn(() => Promise.resolve(null)),
  resolveSpaRoot: () => null,
  contentTypeFor: () => 'application/octet-stream',
  resolveWithinRoot: () => null,
  resetSpaCache: vi.fn(),
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

// src/index.ts resolves the dashboard tenant scope at boot and refuses to start
// when the bootstrap admin has no membership (it used to 403 every request
// instead). This test drives the REAL src/index.ts, so it must declare a
// membership — otherwise the boot check reaches the database, fails, and calls
// process.exit(1), which fails the suite for a reason unrelated to bootstrapping.
vi.mock('../src/infrastructure/persistence/repositories/organization-repository', () => ({
  DrizzleOrganizationRepository: class {
    findOrganizationIdByUserId = (userId: string) => Promise.resolve(userId ? 'org-a' : null);
  },
}));

describe('Bootstrap Server', () => {
  // `src/index.ts` is import-cached, so `serve()` runs exactly ONCE per module
  // registry. `beforeEach` clears the spy, which means a second `await
  // import('../src/index')` is a no-op and `mock.calls[0]` is undefined —
  // asserted below by `bootOnce()`, which re-imports idempotently and reads the
  // captured handler rather than a per-test spy.
  let booted: ((req: Request) => Promise<Response>) | undefined;

  const bootOnce = async (): Promise<(req: Request) => Promise<Response>> => {
    if (!booted) {
      await import('../src/index');
      booted = mockServe.mock.calls[0][0].fetch as (req: Request) => Promise<Response>;
    }
    return booted;
  };

  beforeEach(() => {
    mockStartBot.mockClear();
    mockHandleUpload.mockClear();
    mockHandleHealth.mockClear();
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
    booted = fetchHandler;

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

  it('the booted app serves the P4 documentation routes', async () => {
    // Same reasoning as the test above, applied to the two routes P2b dropped
    // and P4 restored: assert them on the REAL fetch handler the Node adapter
    // was handed. Both are public and unthrottled — a 429 or a 401 here means
    // somebody wrapped them in `limited(...)`/`requireAuth(...)` by mistake.
    const fetchHandler = await bootOnce();

    const docs = await fetchHandler(new Request('http://localhost/docs'));
    expect(docs.status).toBe(200);
    expect(docs.headers.get('content-type')).toContain('text/html');
    expect(await docs.text()).toContain('/swagger.json');

    const spec = await fetchHandler(new Request('http://localhost/swagger.json'));
    expect(spec.status).toBe(200);
    const body = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.0.0');
    expect(body.paths).toHaveProperty('/api/upload');

    // The documentation routes must not be reachable only through requireAuth.
    // mockRequireAuth answers 401 to everything, so a wrapped route would show
    // up here as 401 rather than 200.
    expect(docs.status).not.toBe(401);
    expect(spec.status).not.toBe(401);
  });

  it('the booted app answers the site root from the SPA fallback, not a 500', async () => {
    // deploy.sh never shipped home.html, which is why `/` was a bare 500 in
    // production while every dev checkout returned 200 — the mismatch the SPA
    // lane fixes. With no SPA configured the root must be an honest 404, and
    // must NOT throw: env.ts runs at import time and src/index.ts imports it
    // transitively before serve(), so a throw here is a dead process.
    const fetchHandler = await bootOnce();

    const root = await fetchHandler(new Request('http://localhost/'));
    expect(root.status).toBe(404);

    // The health probe the deploy script depends on must still REACH its
    // handler. handleHealth is mocked to a bare `vi.fn()` in this suite — it
    // returns undefined, which Hono turns into a 500 — so the assertion is on
    // the ROUTE, not the status. `health.test.ts` and `live-probe.ts` are
    // where the 200 is pinned; this file only owns the wiring.
    const health = await fetchHandler(new Request('http://localhost/health'));
    expect(mockHandleHealth).toHaveBeenCalled();
    expect(health.status).not.toBe(404);
  });
});
