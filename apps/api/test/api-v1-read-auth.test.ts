import { describe, expect, it } from 'vitest';

/**
 * Item 11 — `GET /api/v1/*` must require auth, while `/f/:public_id` stays public.
 *
 * ## The decision being encoded
 *
 * `GET /api/v1/*` used to be registered bare:
 *
 *     app.get('/api/v1/*', adapt(handleWebApiV1));   // anyone
 *
 * on the reasoning that "reads are public, writes are protected". Measured
 * against LIVE production before the change, an unauthenticated caller could:
 *
 *   - list buckets                    -> {"buckets":[{"name":"gitea","objectCount":170}]}
 *   - walk every object key           -> packages/02/c5/02c5f04…
 *   - read the CONTENT of every object, because each listing entry carries a
 *     `downloadUrl` (/f/<public_id>) and those return 200 anonymously.
 *
 * That last point is the reason the decision went the way it did. A share link
 * is meant to let a holder read ONE object; a public listing turns that into
 * "read everything", so the public listing silently subsumes the share-link
 * decision. The product decision recorded for item 11 is therefore:
 *
 *   - `/api/v1/buckets` and `/api/v1/buckets/:bucket/objects` require auth
 *   - `/f/:public_id` and `/file/:public_id/info` REMAIN public, so any link
 *     already handed out keeps working.
 *
 * Writes were already wrapped (POST/DELETE/PUT) and must stay that way; they are
 * re-asserted here so a future refactor cannot quietly widen the hole.
 *
 * ## Why these assertions are possible at all
 *
 * Asserted against `createApp()` with the REAL `requireAuth`, not against the
 * route table — see the header of `public-readonly-routes.test.ts` for why a
 * table-level assertion proved nothing (`hono-routing.test.ts` mocks `requireAuth`
 * as the identity function, so "GET is public" was untestable by construction
 * there).
 *
 * `ADMIN_API_TOKEN` is set before importing anything that reads `config`:
 * `src/env.ts` snapshots it at first import, and `requireAuth` is a no-op while
 * it is empty — which is the documented auth-disabled state, where an anonymous
 * POST succeeds and none of this is observable.
 */
const setEnv = (key: string, value: string) => {
  process.env[key] = value;
};

setEnv('BOT_TOKENS', '123456:ABC-DEF');
setEnv('STORAGE_CHANNEL_ID', '-1001234567890');
setEnv('BASE_URL', 'https://example.com');
// The offline placeholder, imported rather than repeated: `src/env.ts` requires
// DATABASE_URL and throws at import without one, and a real host here would make
// this suite's outcome depend on the network it runs on.
const { OFFLINE_DATABASE_URL } = await import('./helpers/setup-env');
setEnv('DATABASE_URL', OFFLINE_DATABASE_URL);
setEnv('PORT', '4000');
setEnv('NODE_ENV', 'test');
setEnv('ADMIN_API_TOKEN', 'item11-secret-token');
setEnv('SESSION_COOKIE_NAME', 'item11_session');
setEnv('SESSION_COOKIE_MAX_AGE_SECONDS', '3600');

const { createApp } = await import('../src/presentation/http/app');

const req = () => createApp().request;
const withToken = (headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${'item11-secret-token'}`,
  ...headers,
});

describe('item 11: /api/v1 reads require auth', () => {
  it('refuses an unauthenticated bucket listing', async () => {
    const res = await req()('/api/v1/buckets');
    expect(res.status, 'GET /api/v1/buckets must not be world-readable').toBe(401);
  });

  it('refuses an unauthenticated object listing', async () => {
    const res = await req()('/api/v1/buckets/gitea/objects');
    expect(res.status, 'GET /api/v1/buckets/:bucket/objects must not be world-readable').toBe(401);
  });

  it('refuses an unauthenticated object info lookup', async () => {
    const res = await req()('/api/v1/buckets/gitea/objects/some-key');
    expect(res.status).toBe(401);
  });

  it('still serves an authenticated bucket listing', async () => {
    // Not a 401 — that is the only thing under test. The controller's own
    // failure (no database) is a pass-through signature, as documented in
    // public-readonly-routes.test.ts.
    const res = await req()('/api/v1/buckets', { headers: withToken() });
    expect(res.status).not.toBe(401);
  });
});

describe('item 11: share links stay public', () => {
  it('leaves /f/:public_id reachable without a token', async () => {
    // The whole point of the decision: existing shared links must keep working.
    // A 401 here would mean the fix broke live links.
    const res = await req()('/f/does-not-exist-anyway');
    expect(res.status, '/f/:public_id must remain public').not.toBe(401);
  });

  it('leaves /file/:public_id/info reachable without a token', async () => {
    const res = await req()('/file/does-not-exist-anyway/info');
    expect(res.status, '/file/:public_id/info must remain public').not.toBe(401);
  });
});

describe('item 11: writes stay protected', () => {
  it('refuses unauthenticated POST, DELETE and PUT', async () => {
    for (const method of ['POST', 'DELETE', 'PUT'] as const) {
      const res = await req()('/api/v1/buckets', { method });
      expect(res.status, `${method} /api/v1/buckets must require auth`).toBe(401);
    }
  });
});
