import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * SPA static serving + the mount-order guard (P4, API lane).
 *
 * The assertion this file exists for is the LAST one. P2b already shipped the
 * bug once: a catch-all registered above the S3 route stole `GET /{bucket}/{key}`
 * from aws-cli, rclone and the Docker registry client. The SPA adds two new
 * catch-alls of its own, so the same mistake is available twice more.
 *
 * `WEB_DIST_PATH` is read from `config`, which is frozen at import time, so the
 * whole suite mutates `config.webDistPath` and clears the controller's boot
 * cache between cases rather than re-importing modules.
 */

const loadApp = async () => {
  const { createApp } = await import('../src/presentation/http/app');
  return createApp();
};

let tmpRoot: string;

const buildFakeSpa = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'spa-probe-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'export const x = 1;');
  writeFileSync(join(root, 'assets', 'index-abc123.css'), 'body{color:red}');
  return root;
};

const setWebDistPath = async (value: string) => {
  const { config } = await import('../src/env');
  config.webDistPath = value;
  const spa = await import('../src/presentation/http/controllers/spa-controller');
  spa.resetSpaCache();
};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'spa-tests-'));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setWebDistPath('');
});

describe('WEB_DIST_PATH unset — behaviour is unchanged from before P4', () => {
  it('resolves no SPA root', async () => {
    await setWebDistPath('');
    const { resolveSpaRoot } = await import('../src/presentation/http/controllers/spa-controller');
    expect(resolveSpaRoot()).toBeNull();
  });

  it('GET / is a 404, not a crash and not a stale home.html', async () => {
    await setWebDistPath('');
    const app = await loadApp();
    const res = await app.request('/');
    expect(res.status).toBe(404);
  });

  it('GET /assets/anything is a 404', async () => {
    await setWebDistPath('');
    const app = await loadApp();
    expect((await app.request('/assets/index-abc123.js')).status).toBe(404);
  });
});

describe('WEB_DIST_PATH set but the directory is missing', () => {
  it('never throws and still serves the API', async () => {
    await setWebDistPath(join(tmpRoot, 'does-not-exist'));
    const app = await loadApp();
    // /health reaches its handler (JSON) rather than throwing on a missing SPA.
    expect((await app.request('/health')).headers.get('content-type')).toContain(
      'application/json',
    );
    expect((await app.request('/')).status).toBe(404);
  });
});

describe('WEB_DIST_PATH set and present', () => {
  it('serves index.html at /', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('SPA');
  });

  it('serves a hashed asset with the right content-type', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toContain('export const x = 1;');
  });

  it('serves CSS as text/css', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/assets/index-abc123.css');
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves the SPA shell for a client-side deep link', async () => {
    // WHY THIS NOW SENDS BROWSER HEADERS — the single most important thing to
    // understand about the catch-all, and a change in what this test MEANS.
    //
    // This test used to send NO headers and assert 200 for `/acme/logs`. That is
    // the exact request an S3 client sends before signing: two path segments, no
    // Sec-Fetch-*, no Accept. It cannot be satisfied at the same time as
    // `an unsigned /{bucket}/{key} is a 404` — both are `/{a}/{b}` with identical
    // headers, so no path-based rule can separate them. The P4 contract's own
    // planned routes make the collision permanent: `/$orgSlug/dashboard` and
    // `/$orgSlug/$bucketName` (P4-CONTRACT.md §1) are two-segment paths too.
    //
    // The discriminator is therefore the REQUEST, not the path. A client-side
    // deep link is a browser DOCUMENT NAVIGATION, and that is what this test now
    // says: a request carrying the `Sec-Fetch-Mode: navigate` a browser sets
    // automatically. The assertion's intent — a deep link renders the shell — is
    // unchanged and still load-bearing; what changed is that it is now expressed
    // as the thing it is instead of as an anonymous probe indistinguishable from S3.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/acme/logs', {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPA');
  });

  it('404s a missing asset instead of returning the HTML shell', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/assets/index-missing.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SPA');
  });

  it('serves a root-level file with its OWN content-type, not the HTML shell', async () => {
    // `apps/web/public/*` is copied by Vite into the dist ROOT, not into
    // /assets/*. Before the catch-all consulted serveSpaFile, the first
    // favicon.ico or robots.txt anyone added would have been answered with
    // index.html at 200 text/html — a robots.txt that silently became a web page,
    // and a favicon that became a MIME error. That is precisely the failure
    // "404s a missing asset" above exists to prevent, one directory up.
    const root = buildFakeSpa();
    writeFileSync(join(root, 'robots.txt'), 'User-agent: *\nDisallow:\n');
    writeFileSync(join(root, 'favicon.ico'), 'ICON');
    await setWebDistPath(root);
    const app = await loadApp();

    const robots = await app.request('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toContain('text/plain');
    expect(await robots.text()).toContain('User-agent');

    const icon = await app.request('/favicon.ico');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/x-icon');
  });

  it('never caches index.html but caches hashed assets', async () => {
    const root = buildFakeSpa();
    await setWebDistPath(root);
    const app = await loadApp();
    expect((await app.request('/')).headers.get('cache-control')).toBe('no-cache');
    expect((await app.request('/assets/index-abc123.js')).headers.get('cache-control')).toContain(
      'immutable',
    );
  });
});

describe('path traversal is refused', () => {
  // The invariant is "no file outside the SPA root is ever served", NOT
  // "the status is 404".
  //
  // Attribution matters here, because the previous comment said "Hono normalises
  // `/assets/../../x` before the handler runs" and that is WRONG: Hono's own
  // router matches `/assets/*` on the raw traversal path. The normaliser is
  // @hono/node-server's buildUrl, which runs the request target through WHATWG
  // URL *before* Hono's router sees it. So:
  //
  //   - `/assets/../../src/env.ts` collapses to `/src/env.ts`, which leaves the
  //     `/assets/*` route and lands on the SPA fallback, which answers with the
  //     shell. Correct outcome — the shell is inside the root — but for a
  //     different reason than "Hono normalised it", and via a DIFFERENT route.
  //   - WHATWG URL does NOT collapse %2f, so `/assets/..%2f..%2f..%2fetc/passwd`
  //     reaches the `/assets/*` route intact and is stopped ONLY by
  //     resolveWithinRoot().
  //
  // Both layers are load-bearing and neither may be removed, so these assert on
  // CONTENT rather than status.
  //
  // NOTE: the two HTTP-level tests below are weak for a third, independent reason —
  // a mkdtemp root's `../../package.json` resolves to a non-existent `/package.json`,
  // so they would still pass with the guard deleted. The two below them, which
  // target a real sibling file and call resolveWithinRoot directly, are the ones
  // that actually fail without the guard.
  it('GET /assets/../../package.json never returns a file outside the root', async () => {
    // Built against a REAL sibling target, not a path that happens not to exist.
    // The old version pointed at `../../package.json`, which from a mkdtemp root
    // resolves to a non-existent `/package.json` and passes even with the guard
    // deleted — vacuously green. This one plants a marker file one level ABOVE
    // the SPA root, so it can only stay green while the guard holds.
    const parent = mkdtempSync(join(tmpRoot, 'spa-parent-'));
    const root = buildFakeSpa();
    const siblingSecret = join(parent, 'outside-secret.json');
    writeFileSync(siblingSecret, '{"marker":"OUTSIDE-THE-SPA-ROOT"}');
    // Re-root the fake SPA inside `parent` so `../outside-secret.json` is a real,
    // resolvable, ESCAPING path.
    const rooted = join(parent, 'web');
    mkdirSync(rooted, { recursive: true });
    writeFileSync(join(rooted, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
    await setWebDistPath(rooted);
    const app = await loadApp();

    // The encoding matters: WHATWG URL (which @hono/node-server's buildUrl runs
    // the request target through) collapses `..` AND `%2e%2e`, so a plain
    // `/assets/../x` never reaches the `/assets/*` route at all — it becomes `/x`
    // and lands on the SPA fallback. It cannot observe this guard either way.
    // `%2f` is the encoding that SURVIVES that parse, so this is the only form
    // that actually exercises resolveWithinRoot through HTTP.
    const res = await app.request(`/assets/..%2f..%2foutside-secret.json`);
    expect(await res.text()).not.toContain('OUTSIDE-THE-SPA-ROOT');
    // And the guard itself, called directly with the escaping path.
    const { serveSpaFile } = await import('../src/presentation/http/controllers/spa-controller');
    expect(await serveSpaFile('/assets/../outside-secret.json')).toBeNull();
    expect(await serveSpaFile('/../outside-secret.json')).toBeNull();
  });

  it('GET /assets/%2e%2e/%2e%2e/package.json is refused after decoding', async () => {
    // %2e%2e decodes to `..` AFTER decodeURIComponent, so this is the path that
    // actually reaches resolveWithinRoot's prefix assertion. Asserted against the
    // same real sibling marker as above rather than a package.json that does not
    // exist from a temp root.
    const parent = mkdtempSync(join(tmpRoot, 'spa-parent-encoded-'));
    const rooted = join(parent, 'web');
    mkdirSync(join(rooted, 'assets'), { recursive: true });
    writeFileSync(join(rooted, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
    writeFileSync(join(parent, 'outside-secret.json'), '{"marker":"ENCODED-ESCAPE"}');
    await setWebDistPath(rooted);
    const app = await loadApp();

    const res = await app.request('/assets/%2e%2e%2f..%2foutside-secret.json');
    expect(await res.text()).not.toContain('ENCODED-ESCAPE');
  });

  it('serveSpaFile returns null for a path that escapes the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'spa-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-VALUE');
    await setWebDistPath(buildFakeSpa());
    const { serveSpaFile } = await import('../src/presentation/http/controllers/spa-controller');
    expect(await serveSpaFile(`/../${outside.split('/').pop()}/secret.txt`)).toBeNull();
    expect(await serveSpaFile('/assets/../../../../etc/passwd')).toBeNull();
  });

  it('resolveWithinRoot refuses a bare traversal string', async () => {
    const { resolveWithinRoot } = await import(
      '../src/presentation/http/controllers/spa-controller'
    );
    expect(resolveWithinRoot('/srv/web', '/../secrets')).toBeNull();
    expect(resolveWithinRoot('/srv/web', '/a/../../secrets')).toBeNull();
    expect(resolveWithinRoot('/srv/web', '/index.html')).toBe('/srv/web/index.html');
  });
});

describe('MOUNT ORDER — the SPA must never steal S3 traffic', () => {
  // This is the P2b defect class. `shouldHandleS3` is the arbiter: an
  // Authorization header, an X-Amz-Signature query param, or a vhost bucket all
  // mark a request as S3, and s3Or() must defer BEFORE any SPA handler runs.
  const sigv4Headers = (host = 'localhost') => ({
    host,
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123',
    'x-amz-date': '20260101T000000Z',
  });

  it('a SigV4 GET /{bucket}/{key} reaches S3, not the SPA fallback', async () => {
    await setWebDistPath(buildFakeSpa());
    const { shouldHandleS3 } = await import('../src/presentation/http/s3-detection');
    // The arbiter the mount order depends on.
    const probe = new Request('http://localhost/my-bucket/photo.png', {
      headers: sigv4Headers(),
    });
    expect(shouldHandleS3(probe, Object.fromEntries(probe.headers))).toBe(true);

    const app = await loadApp();
    const res = await app.request('/my-bucket/photo.png', { headers: sigv4Headers() });
    // Whatever S3 decides (auth failure, NoSuchBucket), it is never the SPA shell.
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
  });

  it('a SigV4 request to an /assets/ path reaches S3, not the SPA asset route', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/assets/index-abc123.js', { headers: sigv4Headers() });
    expect(await res.text()).not.toContain('export const x = 1;');
  });

  it('a SigV4 GET / reaches S3 ListBuckets, not index.html', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/', { headers: sigv4Headers() });
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
  });

  it('an unsigned /{bucket}/{key} is a 404, not the SPA shell', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that was the defect. It read
    // "an unsigned /{bucket}/{key} still falls back to the SPA shell" and pinned
    // `status === 200` + body containing 'SPA' — locking in the regression as
    // intended behaviour, so any correct fix turned it red and a well-meaning CI
    // run reverted the fix.
    //
    // What makes 404 the correct answer: before P4 the `node:http` shim answered
    // every unsigned GET /{bucket}/{key} with a bare 404. Hard constraint (i)
    // requires the S3 wire protocol to stay byte-compatible for aws-cli, rclone,
    // s3cmd and the Docker registry client — a client that probes a path before
    // signing must still get an S3-shaped answer, never a 200 HTML dashboard.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/my-bucket/photo.png');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).not.toContain('SPA');
  });

  it('an unsigned GET /{bucket} (the bucket-listing probe) is a 404 too', async () => {
    // The single-segment `/{bucket}` shape: what makes "does this bucket exist?"
    // unanswerable from the status code alone when it answers 200 HTML.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/my-bucket');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).not.toContain('SPA');
  });

  it('the Docker registry v2 ping is never the SPA shell', async () => {
    // `GET /v2/` is one segment, so it is NOT caught by the two-segment rule and
    // is named explicitly. A registry client that treats a non-401/404 ping as
    // "this endpoint is a registry" would mis-handle a 200 HTML dashboard.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    for (const path of ['/v2', '/v2/']) {
      const res = await app.request(path);
      expect(res.status, `${path} must not answer 200`).toBe(404);
      expect(await res.text()).not.toContain('SPA');
    }
  });

  it('a browser navigating to a deep link still gets the shell', async () => {
    // The inverse guard that matters now: the discriminator is the REQUEST, not
    // the path, because a dashboard deep link and an S3 path-style address are
    // the same shape. Browsers set Sec-Fetch-Mode: navigate automatically.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/acme/logs', {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPA');
  });

  it('a curl-shaped probe (Accept: */*) is a 404, not the shell', async () => {
    // The negative control for the Accept fallback: `*/*` is not a document
    // request, so curl / a CDN / a scanner sweep keeps the S3-shaped 404.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/acme/logs', { headers: { accept: '*/*' } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SPA');
  });

  it('a SigV4 request to /docs and /swagger.json reaches S3, never the docs page', async () => {
    // `/docs` and `/swagger.json` are registered ABOVE the `/*` catch-all, and
    // Hono matches on registration order — which means being registered first
    // makes them CLAIM the path before S3 ever sees it. Unwrapped, a SigV4
    // request to a bucket named `docs` got HTML and to `swagger.json` got the
    // OpenAPI document. s3Or() is what prevents that.
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    for (const path of ['/docs', '/swagger.json']) {
      const res = await app.request(path, { headers: sigv4Headers() });
      expect(res.headers.get('content-type')).not.toContain('text/html');
      expect(res.headers.get('content-type')).not.toContain('application/json');
      expect(await res.text()).not.toContain('<!DOCTYPE html>');
    }
  });
});

describe('the public data plane and health are untouched by the SPA', () => {
  // `/health` runs `SELECT 1`, so its status depends on a live database and is
  // not assertable here (the suite runs with a placeholder DATABASE_URL). What
  // matters for THIS lane is that the request reaches health-controller at all,
  // so assert the handler's own JSON shape rather than the status code.
  it('GET /health reaches health-controller, never the shell', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/health');
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('POST /api/upload is routed to upload, never the shell', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/api/upload', { method: 'POST' });
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
  });

  it('GET /f/:public_id is routed to the file controller, never the shell', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/f/somePublicId');
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
  });

  it('GET /file/:public_id/info is routed to the file controller, never the shell', async () => {
    await setWebDistPath(buildFakeSpa());
    const app = await loadApp();
    const res = await app.request('/file/somePublicId/info');
    expect(await res.text()).not.toContain('<!DOCTYPE html><html><body>SPA');
  });
});

describe('documentation endpoints', () => {
  it('GET /docs serves Swagger UI pointing at /swagger.json', async () => {
    await setWebDistPath('');
    const app = await loadApp();
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/swagger.json');
    expect(html).toContain('swagger-ui');
  });

  it('GET /swagger.json serves the generated document', async () => {
    await setWebDistPath('');
    const app = await loadApp();
    const res = await app.request('/swagger.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths).length).toBeGreaterThan(10);
  });

  it('the spec carries the router-generated bucket paths, not a hand-written literal', async () => {
    await setWebDistPath('');
    const app = await loadApp();
    const body = (await (await app.request('/swagger.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    expect(body.paths['/api/v1/buckets/{bucket}/objects']).toHaveProperty('get');
    expect(body.paths['/api/v1/buckets/{bucket}/copy']).toHaveProperty('post');
    // The requestBody proves a real schema was generated, not a placeholder.
    const copy = body.paths['/api/v1/buckets/{bucket}/copy']['post'];
    expect(copy?.requestBody).toBeDefined();
  });
});
