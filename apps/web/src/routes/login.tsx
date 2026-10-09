/**
 * `/login` — the admin token form.
 *
 * ## What the wire actually does
 *
 * `POST /api/v1/auth/login` takes `{token}` and answers one of five things, and
 * this page renders each differently because they are NOT the same failure:
 *
 * | Result | Cause | What the user is told |
 * |---|---|---|
 * | `200 {"username":"admin"}` | token correct — but see the `Secure` trap below | success |
 * | `400 {"error":"Token is required"}` | body failed `LoginBodySchema` | paste the token |
 * | `401 {"error":"Invalid token"}` | token wrong | try again |
 * | `429 {"error":"Rate limit exceeded"}` | `limited()` wrapped login (`app.ts:248`) | wait — **do not** retry |
 * | `404 {"error":"Not found"}` | `isAuthEnabled()` is false — auth is OFF | nothing to log into |
 *
 * `429` is rate limited but `GET /api/v1/*` reads are NOT (`app.ts:296` is
 * registered bare while `:248` is wrapped), so a 429 here means only "you are
 * logging in too fast", not "the deployment is throttling you" — the browser
 * still works. That is why it gets its own message and no auto-retry: retrying
 * a 429 is the one thing guaranteed to keep the window exhausted.
 *
 * ## The `Secure`-over-http trap — why a 200 is not success
 *
 * `createSessionCookie` sets `HttpOnly; SameSite=Lax; Secure` UNCONDITIONALLY
 * (`middleware/auth.ts:108-109`). Over plain `http://localhost` the browser
 * accepts the `Set-Cookie` header and then discards the cookie, and
 * `handleLogin` still answers `200 {"username":"admin"}`.
 *
 * So `signIn()` does not trust the POST: it re-probes `GET /api/v1/auth/me`
 * (`lib/auth.ts:102-116`) and throws `ApiError(401, …)` naming the cause when
 * the cookie did not land. **This page surfaces that message verbatim.** It is
 * the only explanation the user will get for why their writes then 401, and
 * replacing it with a generic "Login failed" reproduces exactly the confusion
 * `home.html` had.
 *
 * ## The three-state probe, not a boolean
 *
 * `/auth/me` returns `200` (admin), `401` (read-only) or — when
 * `ADMIN_API_TOKEN` is empty — `404`, which means `requireAuth` is a
 * pass-through and the caller is *effectively* admin. That arm is why this page
 * redirects away from `/login` in the `auth-disabled` state: there is nothing
 * to log into, and `AuthControls` already hides the Login button there
 * (contract §1.2).
 *
 * ## Where "onward" goes, and why `?redirect` is validated
 *
 * `validateSearch` accepts an optional `redirect` so any page can send the user
 * here and back. It is constrained to a same-origin **path** only — a value
 * containing `://` or a scheme-relative `//` is discarded rather than handed to
 * `window.location.assign`. Without that guard `/login?redirect=https://evil`
 * is an open redirect, and this is the one page that would act on it.
 *
 * Relative imports, NOT `@/`: `tsconfig.json` declares the alias but
 * `vite.config.ts` has no `resolve.alias`, so `@/…` typechecks and then fails
 * the Rollup build. See `__root.tsx` for the full statement.
 */

import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/client';
import { refreshAuth, signIn, useAuthState } from '../lib/auth-store';
import type { AuthState } from '../lib/auth';

/** Where the user lands when `?redirect` is absent or rejected. */
const DEFAULT_DESTINATION = '/';

/**
 * The empty search every navigation to `/` must carry.
 *
 * `routes/index.tsx` validates `search` into `{bucket, prefix}` — both
 * REQUIRED, no `?` — so TanStack types `navigate({to: '/'})` as a missing-
 * property error. Repeating the empty pair here rather than reaching into the
 * index route's types keeps this file decoupled: if the index route's search
 * shape changes, the fix lands in one place per file instead of silently
 * breaking every cross-route link.
 */
const HOME_SEARCH = { bucket: '', prefix: '' } as const;

/** What the user is told, derived from the thrown error rather than hardcoded. */
interface LoginFailure {
  /** Verbatim server message where one exists. */
  message: string;
  /** Extra guidance that is true for this specific failure and no other. */
  hint?: string;
  /** Whether trying the same token again could plausibly work. */
  retryable: boolean;
}

/**
 * Maps a rejected login onto a message worth reading.
 *
 * `429` is separated from `401` on purpose: "wrong token" invites a retry and
 * "rate limited" must not, so giving them the same copy produces the exact
 * failure this page exists to avoid — a user mashing Login until the window
 * stays exhausted long after their token was right.
 *
 * Note the shared `401` arm: `login()` reuses 401 to report a successful login
 * whose cookie the browser refused to store, and that message is the single
 * most useful sentence on this page. It is passed through whole rather than
 * being flattened into "Login failed".
 */
const explain = (error: unknown): LoginFailure => {
  if (!(error instanceof ApiError)) {
    return { message: 'Could not reach the server.', retryable: true };
  }
  switch (error.status) {
    case 429:
      return {
        message: 'Too many login attempts.',
        hint: `${error.message}. Wait for the current window to expire, then try once — retrying now only keeps the window open.`,
        retryable: false,
      };
    case 404:
      return {
        message: 'This deployment has authentication turned off.',
        hint: 'ADMIN_API_TOKEN is empty, so the server accepts every request as admin. There is nothing to log into.',
        retryable: false,
      };
    case 400:
      return { message: error.message, hint: 'Paste the admin API token.', retryable: true };
    default:
      // Covers 401 (wrong token, and the Secure-cookie drop) plus any status
      // this page has no special handling for.
      return { message: error.message || `HTTP ${error.status}`, retryable: false };
  }
};

/**
 * One-line summary of the current probe, shown above the form.
 *
 * Mirrors `AuthControls`' table: `auth-disabled` is reported as fully writable
 * because the server would accept writes, and `unknown` is described without
 * claiming read-only — an unanswered probe must never be presented as a
 * permission decision.
 */
const statusLine = (state: AuthState): string | null => {
  switch (state.kind) {
    case 'admin':
      return 'You are signed in.';
    case 'auth-disabled':
      return 'Authentication is disabled on this server — everything is already writable.';
    case 'readonly':
      return 'Not signed in. Reading files is still available.';
    case 'unknown':
      return 'Could not determine your access. Reading files may still work.';
  }
};

function LoginPage(): React.JSX.Element {
  const state = useAuthState();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const [token, setToken] = useState('');
  const [failure, setFailure] = useState<LoginFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The initial probe is fired by `__root.tsx`, but this route can also be
   * entered directly (deep link, refresh). Re-probing here is idempotent and
   * de-duplicated inside the store, so StrictMode's double effect does not
   * issue two requests.
   */
  useEffect(() => {
    void refreshAuth();
  }, []);

  /**
   * Already admin, or auth is off — nothing to do on this page.
   *
   * `auth-disabled` is included deliberately: it counts as admin
   * (`canWrite`), and a login form there would offer a control that cannot
   * work. `goHome` is declared below and referenced here; the effect body runs
   * after render, so the `const` is assigned by then.
   */
  useEffect(() => {
    if (state.kind === 'admin' || state.kind === 'auth-disabled') goHome();
    // `goHome` is recreated each render; depending on it would re-run this on
    // every keystroke. `redirect` is the only value it actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, redirect]);

  /**
   * Hands control back to the browser.
   *
   * A same-origin `?redirect` is a document load (it may name a route this
   * bundle's tree does not own); the default `/` gets a client transition.
   */
  function goHome(): void {
    if (redirect !== DEFAULT_DESTINATION) {
      window.location.assign(redirect);
      return;
    }
    void navigate({ to: '/', search: HOME_SEARCH, replace: true });
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    const trimmed = token.trim();
    if (trimmed.length === 0) {
      // Client-side mirror of `LoginBodySchema` (`z.string().min(1)`). The
      // server would answer 400 for this anyway; catching it here spares a
      // round trip on a rate-limited endpoint.
      setFailure({ message: 'Token is required', hint: 'Paste the admin API token.', retryable: true });
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      await signIn(trimmed);
      // `signIn` publishes the new state before resolving, so navigating here
      // rather than waiting for the effect above means `?redirect` is honoured
      // on the very first successful submit rather than a render later.
      goHome();
    } catch (error: unknown) {
      setFailure(explain(error));
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  const status = statusLine(state);

  return (
    <section className="login-page" aria-labelledby="login-heading">
      <h1 id="login-heading">Sign in</h1>

      {status ? (
        <p className="auth-status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}

      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="login-token">Admin API token</label>
        <input
          id="login-token"
          ref={inputRef}
          type="password"
          name="token"
          value={token}
          autoComplete="current-password"
          autoFocus
          required
          disabled={busy}
          onChange={(event) => {
            setToken(event.target.value);
            if (failure) setFailure(null);
          }}
        />

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/*
        `role="alert"` so a screen reader announces the failure without the user
        having to move focus. The text is React-escaped by construction: there
        is no `dangerouslySetInnerHTML` on this page, and no handler is ever
        built by string concatenation.
      */}
      {failure ? (
        <p className="error-message" role="alert">
          {failure.message}
          {failure.hint ? <> {failure.hint}</> : null}
        </p>
      ) : null}

      {/*
        Logout semantics, stated once, on the page where a new session begins.
        Sessions are a stateless HMAC blob with NO server-side store, so
        `POST /api/v1/auth/logout` only sends `Max-Age=0` — a cookie captured
        before logout still authenticates until it expires (contract gotcha
        13). The copy says "clears this browser's cookie", never "revokes".
      */}
      <p className="auth-status">
        Signing out clears this browser&apos;s cookie only. Sessions are stateless, so a cookie
        captured beforehand keeps working until it expires.
      </p>

      <p className="auth-status">
        <Link to="/" search={HOME_SEARCH}>
          Back to files
        </Link>
        {' — reading files does not require signing in.'}
      </p>
    </section>
  );
}

export const Route = createFileRoute('/login')({
  /**
   * `redirect` is a query string, i.e. attacker-influenceable. It is accepted
   * only if it looks like a same-origin absolute path — leading `/`, no scheme,
   * no authority. Everything else falls back to `/`.
   */
  validateSearch: (search: Record<string, unknown>): { redirect: string } => {
    const raw = search.redirect;
    const usable =
      typeof raw === 'string' &&
      raw.startsWith('/') &&
      !raw.startsWith('//') &&
      !raw.includes('://');
    return { redirect: usable ? raw : DEFAULT_DESTINATION };
  },
  component: LoginPage,
});