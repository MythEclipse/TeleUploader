import { describe, expect, it } from 'vitest';

/**
 * P2b — the `/api/v1` auth POLICY, asserted against the real application.
 *
 * ## Why this file was rewritten rather than deleted
 *
 * It used to import the `{ routes }` table from
 * `src/presentation/http/routes/index.ts` and compare function identity:
 *
 *     expect(routes['/api/v1/*'].GET).toBe(handleWebApiV1);
 *     expect(routes['/api/v1/*'].POST).not.toBe(handleWebApiV1);
 *
 * That table is dead code — nothing imports it at runtime — so both assertions
 * proved properties of an object the server never consults. The file was
 * slated for deletion as redundant with `hono-routing.test.ts`.
 *
 * **It is not redundant.** `hono-routing.test.ts` mocks `requireAuth` as the
 * IDENTITY function:
 *
 *     requireAuth: vi.fn((handler) => handler),
 *
 * so `expect(authWrappedHandlers()).toContain(handlers.webApi)` is satisfied
 * whether `handleWebApiV1` was wrapped on GET, POST, or all four verbs — the
 * assertion cannot tell them apart. PROVEN, not assumed: mutating the live
 * `app.ts` registration
 *
 *     app.get('/api/v1/*', adapt(handleWebApiV1));   →   authenticated(...)
 *
 * leaves `hono-routing.test.ts` green at 15/15. Under that mock, "GET is
 * public" is untestable by construction.
 *
 * So the guarantee is kept by making it testable HERE, against `createApp()`
 * with the REAL `requireAuth`. A regression that auth-wraps GET now fails in
 * this file.
 *
 * ## The credential this relies on
 *
 * `requireAuth` is a no-op when `ADMIN_API_TOKEN` is empty (`isAuthEnabled`,
 * middleware/auth.ts:56) — with auth disabled, `POST /api/v1/buckets` succeeds
 * for an anonymous caller, which is the documented `auth-disabled` state. The
 * policy is therefore only observable when a token IS configured, so this file
 * sets one before importing anything that reads `config`. That is why the
 * env seeding and the dynamic `import()` below are load-bearing and ordered:
 * `src/env.ts` snapshots these at first import.
 */
const defaultEnv = (key: string, value: string) => {
  process.env[key] ||= value;
};
const setEnv = (key: string, value: string) => {
  process.env[key] = value;
};

defaultEnv('BOT_TOKENS', '123456:ABC-DEF');
defaultEnv('STORAGE_CHANNEL_ID', '-1001234567890');
defaultEnv('BASE_URL', 'https://example.com');
defaultEnv('DATABASE_URL', 'postgresql://asephs:***@100.121.180.82:6432/test');
defaultEnv('PORT', '4000');
defaultEnv('NODE_ENV', 'test');
setEnv('ADMIN_API_TOKEN', 'route-secret-token');
setEnv('SESSION_COOKIE_NAME', 'route_session');
setEnv('SESSION_COOKIE_MAX_AGE_SECONDS', '3600');

// `handleWebApiV1` is deliberately NOT mocked: the point is which routes reach
// it unauthenticated, and a stub would answer the same 401 either way.
const { createApp } = await import('../src/presentation/http/app');

const req = () => createApp().request;

describe('public read-only API routing', () => {
  it('requires auth on GET /api/v1/* (item 11 — reads are no longer public)', async () => {
    // This file used to assert the opposite — that GET was public — which was the
    // item 11 question. The decision taken was to wrap GET as well, so the
    // assertion is inverted here and the reasoning lives in
    // `api-v1-read-auth.test.ts`, which covers the whole surface.
    //
    // A 401 is the auth refusal. The controller reaches the database, which is
    // not provisioned in the unit suite, so a 500 would be the pass-through
    // signature — and asserting "not 401" here is precisely what let the public
    // read surface exist unnoticed until item 11 measured it against production.
    const res = await req()('/api/v1/buckets');
    expect(res.status).toBe(401);
  });

  it('protects write endpoints with auth (POST/DELETE/PUT)', async () => {
    for (const method of ['POST', 'DELETE', 'PUT'] as const) {
      const res = await req()('/api/v1/buckets', { method });
      expect(res.status, `${method} /api/v1/buckets must require auth`).toBe(401);
    }
  });

  it('keeps the auth/me endpoint accessible (frontend uses it to detect admin state)', async () => {
    // 401 here is a legitimate ANSWER (it is the not-authenticated probe state),
    // so the assertion is that the route exists and speaks JSON — not that it
    // returns 200. An unauthenticated `GET /api/v1/auth/me` must not fall
    // through to the `/api/v1/*` wildcard handler.
    const res = await req()('/api/v1/auth/me');
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
