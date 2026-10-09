/**
 * Auth state: the three-state probe, plus login/logout.
 *
 * ## Why this is a discriminated union and not a boolean
 *
 * `GET /api/v1/auth/me` is **public** (`app.ts:128`, not wrapped in
 * `requireAuth`) and its HTTP status is a state probe, not an authorization
 * verdict:
 *
 * | Status | Server behaviour | Meaning to the SPA |
 * |---|---|---|
 * | `200` | `getAuthSession` found a valid cookie or Bearer | authenticated admin |
 * | `401` | `handleMe` found no session | **read-only** — reads work, writes 401 |
 * | `404` | `handleMe` returned early: `isAuthEnabled()` is false | **auth DISABLED — full access** |
 *
 * The `404` arm is the trap. With `ADMIN_API_TOKEN=""`, `requireAuth` is a
 * pass-through (`auth.ts:310-312`), so `POST /api/v1/buckets` with **no cookie
 * at all** returns `201 Created`. `home.html` got this right by accident —
 * `checkAuth` reads `res.status === 404` and sets `isAdmin = true` — and any
 * rewrite that collapses the probe to `isAuthenticated` regresses it: either the
 * admin UI disappears in a deployment that is wide open, or it renders in one
 * that is locked down. Both are wrong and one is a security regression.
 *
 * `unknown` covers the network-error and any other status, and is treated as
 * read-only.
 */

import { ApiError, http } from './client';
import type { LoginResponse, MeResponse } from './types';

/** Auth capability, as probed from `GET /api/v1/auth/me`. */
export type AuthState =
  /** 200 — a valid session cookie. Write controls render and are enforced. */
  | { readonly kind: 'admin'; readonly username: string; readonly expiresAt: string | null }
  /** 401 — no session. Reads render; writes are refused client-side. */
  | { readonly kind: 'readonly' }
  /** 404 — `ADMIN_API_TOKEN` is empty, so `requireAuth` passes everything. */
  | { readonly kind: 'auth-disabled' }
  /** Network failure, or a status that is not 200/401/404. Treated as read-only. */
  | { readonly kind: 'unknown' };

const UNKNOWN: AuthState = { kind: 'unknown' };

/**
 * Whether the admin UI should render.
 *
 * `auth-disabled` counts as admin on purpose: the server will accept the write,
 * so hiding the control would be a lie about what the deployment can do.
 */
export const canWrite = (state: AuthState): boolean =>
  state.kind === 'admin' || state.kind === 'auth-disabled';

/** Whether to show the read-only badge. Unknown state is shown as read-only. */
export const isReadOnly = (state: AuthState): boolean => !canWrite(state);

/** Whether to render a Login button. Pointless when auth is disabled. */
export const shouldOfferLogin = (state: AuthState): boolean => state.kind !== 'auth-disabled';

/**
 * Reads `GET /api/v1/auth/me` and maps the status onto {@link AuthState}.
 *
 * Never throws: an auth probe that rejects would leave the whole UI unable to
 * decide what to render, which is exactly the "read-only by accident" state
 * this module exists to make explicit.
 */
export const probeAuth = async (): Promise<AuthState> => {
  try {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    if (res.status === 404) return { kind: 'auth-disabled' };
    if (res.status === 401) return { kind: 'readonly' };
    if (!res.ok) return UNKNOWN;
    const body = (await res.json()) as Partial<MeResponse>;
    return {
      kind: 'admin',
      username: typeof body.username === 'string' ? body.username : 'admin',
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    };
  } catch {
    return UNKNOWN;
  }
};

/**
 * `POST /api/v1/auth/login`.
 *
 * On success the server sets `tu_session` (or `SESSION_COOKIE_NAME`) with
 * `HttpOnly; Secure; SameSite=Lax; Path=/`. This function cannot see the cookie
 * — that is the point of `HttpOnly` — so it verifies by **re-probing**
 * `/auth/me` rather than trusting the 200.
 *
 * That re-probe is not paranoia. The cookie is set with `Secure`
 * unconditionally (`auth.ts:109`), so over plain `http://localhost` the browser
 * accepts the response and then **discards** the cookie. `handleLogin` still
 * returns `200 {"username":"admin"}`. Without the re-probe the SPA would flip to
 * the admin UI and every write would then 401 with no explanation — contract
 * gotcha 12, reproduced as a real bug in `home.html`'s flow.
 *
 * @throws {ApiError} `401` invalid token, `400` empty token, `429` rate limited,
 *   or — when the re-probe fails — `ApiError(401, …)` explaining the cookie was
 *   not stored, naming the `Secure`-over-http cause.
 */
export const login = async (token: string): Promise<AuthState> => {
  await http.postJson<LoginResponse, { token: string }>('/api/v1/auth/login', { token });

  const probed = await probeAuth();
  if (probed.kind === 'admin') return probed;

  if (probed.kind === 'auth-disabled') return probed;

  throw new ApiError(
    401,
    'Logged in, but the session cookie was not stored. The cookie is set with ' +
      '`Secure`, which browsers reject over plain http. Use https, or terminate TLS ' +
      'in front of the app.',
  );
};

/**
 * `POST /api/v1/auth/logout`.
 *
 * **Logout revokes nothing** (contract gotcha 13). Sessions are a stateless
 * HMAC blob with no server-side store, so replaying the captured cookie after
 * logout still returns `200` on `/auth/me`. This clears the browser's cookie jar
 * and nothing else, and the UI must not present it as securing the session.
 *
 * Best-effort: a network failure still ends up read-only locally, so the error
 * is swallowed deliberately rather than surfaced as a failed logout.
 */
export const logout = async (): Promise<void> => {
  await http.postEmptyJson<unknown>('/api/v1/auth/logout').catch(() => undefined);
};
