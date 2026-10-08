import type { Context, Handler } from 'hono';
import { Hono } from 'hono';
import { handleLogin, handleLogout, handleMe } from './controllers/auth-controller';
import { handleFileInfo, handleFileRedirect } from './controllers/file-controller';
import { handleHealth } from './controllers/health-controller';
import { handleHome } from './controllers/home-controller';
import { handleS3Request } from './controllers/s3-controller';
import { handleUpload } from './controllers/upload-controller';
import { handleWebApiV1 } from './controllers/web-api-controller';
import { requireAuth } from './middleware/auth';
import { withRateLimit } from './middleware/rate-limit';
import { getS3RouteBucket, shouldHandleS3 } from './s3-detection';

/**
 * Hono application for the TeleUploader API (P2b).
 *
 * Replaces `infrastructure/http/serve.ts` — a hand-written `node:http` shim that
 * emulated Bun's `serve({ routes, fetch })`. Nothing about the handlers changed:
 * every controller already takes a Web `Request` and returns a `Response`, so this
 * is a change of mount order, not a rewrite.
 *
 * ROUTE ORDER IS LOAD-BEARING
 *
 * The old shim scored routes for specificity (static > :param > wildcard), so
 * `/api/v1/auth/login` beat both `/api/v1/*` and `/*`. Hono matches on
 * REGISTRATION ORDER, first match wins. Registering the dashboard routes after
 * the S3 catch-all would hand every S3 request to the dashboard; registering
 * `/api/v1/*` before `/api/v1/auth/login` would swallow the auth endpoints. The
 * order below is therefore: health, auth, public data plane, dashboard API, site
 * root, and the S3 catch-all LAST so it only sees what nothing else claims.
 *
 * S3 stays OUTSIDE oRPC. oRPC owns JSON serialization and its own error shapes;
 * S3 needs raw XML bodies, path-style `/{bucket}/{key}` addressing, and SigV4
 * headers passed through untouched. Routing S3 through oRPC would put ~2,900
 * lines at risk that must stay byte-compatible for aws-cli, rclone, and the
 * Docker registry client.
 */

/** A controller in the shape every handler in this codebase already has. */
type RawHandler = (req: Request) => Response | Promise<Response>;

/**
 * Adapt a `Request -> Response` handler to a Hono handler.
 *
 * Controllers read only `req.url`, `req.headers` and `req.params`. Hono keeps
 * path params on its own context, so `c.req.param()` is copied onto the raw
 * Request to preserve the contract the old shim provided — file-controller reads
 * `req.params?.public_id` and would otherwise always 404.
 */
const adapt =
  (handler: RawHandler): Handler =>
  async (c: Context) => {
    const req = c.req.raw as Request & { params?: Record<string, string> };
    req.params = { ...req.params, ...c.req.param() };
    return handler(req);
  };

/** Rate-limited handler. Never applied to S3 — see routes/index.ts on why. */
const limited = (handler: RawHandler): Handler =>
  adapt(withRateLimit(handler as (req: Request) => Promise<Response>));

/** Handler behind the admin-token auth check. */
const authenticated = (handler: RawHandler): Handler =>
  adapt(requireAuth(handler as (req: Request) => Promise<Response>));

/**
 * Generic CORS preflight for non-S3 API requests. S3 preflights are answered by
 * the S3 controller with its own XML CORS headers.
 */
const apiOptionsResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, HEAD, DELETE, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, X-Amz-Date, X-Amz-Content-Sha256',
    },
  });

/** Dispatch an S3 request, bypassing rate limiting (Docker registry pushes). */
const handleS3Direct = (req: Request): Promise<Response> =>
  handleS3Request(req, getS3RouteBucket(req));

const isS3 = (req: Request): boolean => shouldHandleS3(req, Object.fromEntries(req.headers));

/** Dispatch to S3 when the request is SigV4-authenticated, else return `fallback`. */
const s3Or =
  (fallback: () => Response | Promise<Response>): Handler =>
  (c: Context) =>
    isS3(c.req.raw) ? handleS3Direct(c.req.raw) : fallback();

const notFound = () => new Response('Not Found', { status: 404 });

export const createApp = (): Hono => {
  const app = new Hono();

  // ── Health (public, unthrottled — the deploy probe hits this) ───────────
  app.get('/health', adapt(handleHealth));
  app.get('/healthz', adapt(handleHealth));

  // ── Dashboard auth ───────────────────────────────────────────────────────
  app.post('/api/v1/auth/login', limited(handleLogin));
  app.post('/api/v1/auth/logout', adapt(handleLogout));
  app.get('/api/v1/auth/me', adapt(handleMe));

  // ── Public data plane — unauthenticated by decision ─────────────────────
  app.post('/api/upload', limited(handleUpload));
  app.get('/f/:public_id', adapt(handleFileRedirect));
  app.get('/file/:public_id/info', adapt(handleFileInfo));

  // ── Dashboard JSON API. GET public; writes require admin auth. ──────────
  app.get('/api/v1/*', adapt(handleWebApiV1));
  app.post('/api/v1/*', authenticated(handleWebApiV1));
  app.delete('/api/v1/*', authenticated(handleWebApiV1));
  app.put('/api/v1/*', authenticated(handleWebApiV1));

  // ── Site root: S3 ListBuckets when SigV4-authenticated, else the SPA ────
  app.get(
    '/',
    s3Or(() => handleHome()),
  );
  app.put(
    '/',
    s3Or(() => new Response('Not Allowed', { status: 405 })),
  );
  app.on(['HEAD', 'DELETE', 'POST'], '/', s3Or(notFound));
  app.options('/', s3Or(apiOptionsResponse));

  // ── S3 catch-all — registered LAST so it only sees unclaimed paths ──────
  app.get('/*', s3Or(notFound));
  app.put('/*', s3Or(notFound));
  app.patch('/*', s3Or(notFound));
  app.delete('/*', s3Or(notFound));
  app.post('/*', s3Or(notFound));
  app.on('HEAD', '/*', s3Or(notFound));
  app.options('/*', s3Or(apiOptionsResponse));

  return app;
};
