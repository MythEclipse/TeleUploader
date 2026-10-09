/**
 * The dashboard's HTTP transport.
 *
 * ## `/api/v1/*`, not `/rpc/*` — the decision and its justification
 *
 * The contract settled this in §1.3 ("the surface is NOT fully on `/rpc`").
 * Four independent reasons, each verified against the source:
 *
 * 1. **`/rpc` is auth-gated wholesale, so it cannot serve the read-only
 *    browser.** `app.ts:146` registers `app.all('/rpc/*', rpcAuthenticated)`.
 *    `GET /api/v1/*` is registered bare at `app.ts:149`. `home.html` renders
 *    the file browser to logged-out visitors and gates only the write controls
 *    (`applyAdminUI`); moving reads to `/rpc` would 401 the entire UI for the
 *    unauthenticated case that is a supported, working mode today.
 * 2. **There is no upload procedure.** `POST /rpc/bucket/uploadObject` -> 404.
 *    Upload must go to `POST /api/v1/buckets/{b}/upload`.
 * 3. **`downloadObject` cannot carry bytes over `/rpc`.** It is bound through
 *    `jsonPayload()`, which does `res.json()` (`routers/bucket.ts:155-165`), so
 *    a binary body is destroyed. Download must use the REST proxy route.
 * 4. **Per-segment key encoding is already correct on the REST path** — see
 *    `./keys.ts`, which is the same one-liner `routers/bucket.ts:71` uses.
 *    `deleteObject` is the single operation where `/rpc` is genuinely the better
 *    transport, and it is not worth a second client, a second auth story, and a
 *    hard dependency for one call that REST gets right once keys are encoded
 *    per segment.
 *
 * **`@orpc/client` is also not installed in this workspace.** `pnpm-lock.yaml`
 * is owned by the DEPS lane and no Build lane may run `pnpm install`
 * (contract §7.1); `apps/web/node_modules/@orpc` does not exist. A client that
 * imports it would not typecheck. This is a second, independent reason for the
 * same answer.
 *
 * ## Auth, reproduced exactly
 *
 * Traced from `middleware/auth.ts` and `controllers/auth-controller.ts`:
 *
 * - `requireAuth` (auth.ts:304) is a **pass-through when
 *   `ADMIN_API_TOKEN` is empty** (auth.ts:310-312). It calls the handler
 *   unconditionally. There is no cookie to present in that mode.
 * - When auth IS enabled, `getAuthSession` (auth.ts:255) tries the **cookie
 *   first**, then `Authorization: Bearer <ADMIN_API_TOKEN>`.
 * - The cookie is minted by `handleLogin` (auth-controller.ts:84) via
 *   `createSessionCookie('admin')`. Its **name** comes from
 *   `config.sessionCookieName` = `process.env.SESSION_COOKIE_NAME || 'tu_session'`
 *   (env.ts:213). Its value is `base64url({"u":"admin","e":<epochMs>}) + "." +
 *   HMAC-SHA256-base64url`, and `parseSessionFromCookie` **rejects any payload
 *   whose `u` is not exactly `"admin"`** (auth.ts:207).
 * - `handleLogin` sets it with `HttpOnly; SameSite=Lax; Secure; Path=/` and
 *   **HttpOnly means the SPA cannot read it** — it must rely on the browser's
 *   automatic cookie jar. Therefore every request here is same-origin and must
 *   carry the jar explicitly (`credentials: 'same-origin'`, and
 *   `withCredentials` on the XHR upload path). There is no token in
 *   localStorage and no manual `Cookie` header — a browser forbids setting it.
 * - `POST /api/v1/auth/login` is **rate limited** (`app.ts:126`), so a failed
 *   attempt is not retried automatically here.
 *
 * ### The `Secure`-over-http trap (contract gotcha 12)
 *
 * `cookieAttributes` (auth.ts:109) sets `Secure` **unconditionally**. Over
 * plain `http://localhost` the browser silently refuses to store the cookie,
 * so login returns 200, the SPA believes it is admin, and every subsequent
 * write 401s. `login()` below therefore re-probes `/auth/me` after a
 * successful login and reports the mismatch rather than reporting success.
 */

/** A non-2xx response from the API, carrying the server's own error message. */
export class ApiError extends Error {
  constructor(
    /** HTTP status. `401` and `404` on `/auth/me` are meaningful, not failures. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Credentials mode for every call.
 *
 * `'same-origin'` is the spec default in current browsers, but it is set
 * explicitly because the whole auth story depends on the cookie jar being
 * attached, and `include` would be wrong — the SPA is served from the API's own
 * origin and there is no cross-origin credential exchange to permit.
 */
const CREDENTIALS: RequestCredentials = 'same-origin';

/** The JSON error envelope every `web-api-controller` handler emits. */
const readError = async (res: Response): Promise<string> => {
  const body: unknown = await res.json().catch(() => undefined);
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error?: unknown };
    if (typeof error === 'string' && error) return error;
  }
  return res.statusText || `HTTP ${res.status}`;
};

/**
 * Performs one request and returns the raw `Response`, throwing {@link ApiError}
 * on any non-2xx status.
 *
 * Deliberately does NOT throw on `401`/`404` from `/auth/me` — that endpoint's
 * status is the state probe (contract §1.2), so callers that care use
 * `probeAuth`, which reads the status without going through here.
 */
const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(path, { ...init, credentials: CREDENTIALS });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return res;
};

/** `request` + `.json()`. The body is typed at the call site, never `any`. */
const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await request(path, init);
  return (await res.json()) as T;
};

const jsonHeaders = { 'content-type': 'application/json' } as const;

export const http = {
  /** `GET`, returning parsed JSON. */
  getJson: <T>(path: string): Promise<T> => requestJson<T>(path),

  /** `POST` with a JSON body, returning parsed JSON. */
  postJson: <TResponse, TBody>(path: string, body: TBody): Promise<TResponse> =>
    requestJson<TResponse>(path, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }),

  /** `POST` with no body — logout. Returns the parsed JSON body. */
  postEmptyJson: <T>(path: string): Promise<T> =>
    requestJson<T>(path, { method: 'POST' }),

  /** `DELETE`, returning parsed JSON. */
  deleteJson: <T>(path: string): Promise<T> => requestJson<T>(path, { method: 'DELETE' }),

  /**
   * The base URL for absolute links handed to the browser (`window.open`,
   * clipboard). Relative paths work for both, but a resolved absolute URL is
   * what a user pasting into `aws s3` or a `curl` needs.
   */
  absolute: (path: string): string => new URL(path, window.location.origin).toString(),
};
