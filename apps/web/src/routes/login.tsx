/**
 * `/login` — Sign in with Google.
 *
 * ## What the wire actually does now
 *
 * There is no token form any more. `POST /api/v1/auth/login` is gone; the route was
 * removed in the same change that introduced per-user tenancy, because a single
 * shared token cannot identify a person and every dashboard request now resolves its
 * tenant from a real session.
 *
 * The flow is a browser navigation:
 *
 *   1. this page links to `/api/v1/auth/google/start?redirect=<path>`;
 *   2. the server mints `state` + PKCE, persists them, and 302s to Google;
 *   3. Google 302s back to `/api/v1/auth/google/callback?code=…&state=…`;
 *   4. the server verifies the ID token, upserts the user, provisions their personal
 *      organization, sets the HttpOnly session cookie, and 302s to `redirect`;
 *   5. the SPA loads, `refreshAuth()` probes `/auth/me`, and the shell renders signed
 *      in.
 *
 * ## Why this is an `<a href>` and not a `fetch`
 *
 * The cookie is `HttpOnly` and set by the API origin at the END of a cross-origin
 * redirect chain. Fetching the start URL would follow the 302s inside an XHR, land on
 * Google's HTML, and never store the cookie. A real navigation is the only thing that
 * works, so `beginSignIn` assigns `window.location`.
 *
 * ## Where "onward" goes, and why `?redirect` is validated on BOTH sides
 *
 * `validateSearch` accepts an optional `redirect` so any page can send the user here
 * and back. It is constrained to a same-origin **path** — a value containing `://`, a
 * scheme-relative `//`, or a backslash is discarded rather than forwarded.
 *
 * The server validates the same value again before writing it into a `Location`
 * header on the callback (`safeRedirectPath`). Two checks for one value is deliberate:
 * this page's check protects the browser from being sent somewhere odd, and the
 * server's protects against a hand-crafted request that never touched this page. Only
 * the second is a real trust boundary.
 *
 * Relative imports, NOT `@/`: `tsconfig.json` declares the alias but `vite.config.ts`
 * has no `resolve.alias`, so `@/…` typechecks and then fails the Rollup build.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthState, refreshAuth } from '../lib/auth-store';
import { AppLink } from '../lib/layout/AppLink';

/**
 * Constrains `?redirect` to a same-origin path.
 *
 * @param raw - The untrusted search value.
 * @returns A safe path, defaulting to `/`.
 */
export const safeRedirect = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  if (raw.includes('\\')) return '/';
  if (raw.includes('://')) return '/';
  return raw;
};

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect: string } => ({
    redirect: safeRedirect(search.redirect),
  }),
  component: LoginPage,
});

function LoginPage(): React.JSX.Element {
  const { redirect } = Route.useSearch();
  const auth = useAuthState();

  useEffect(() => {
    // The probe may not have run yet on a cold load of this route.
    void refreshAuth();
  }, []);

  // Already signed in: this page has nothing to offer. `replace` so the back button
  // does not bounce between here and the destination.
  useEffect(() => {
    if (auth.kind === 'signed-in') {
      window.location.replace(redirect);
    }
  }, [auth.kind, redirect]);

  if (auth.kind === 'signed-in') {
    return (
      <div className="login-page">
        <p className="muted">Signed in as {auth.email} — redirecting…</p>
      </div>
    );
  }

  if (auth.kind === 'unknown') {
    return (
      <div className="login-page">
        <p className="muted">Checking your session…</p>
      </div>
    );
  }

  return (
    <div className="login-page">
      <h1>Sign in</h1>
      <p className="muted">
        FileDrop stores files in your own workspace. Sign in with Google to continue.
      </p>

      {auth.googleEnabled ? (
        <a
          className="button google-signin"
          href={`/api/v1/auth/google/start?redirect=${encodeURIComponent(redirect)}`}
        >
          Sign in with Google
        </a>
      ) : (
        // A button that led to a 503 would be worse than an explanation. The server
        // reports `googleEnabled` on `/auth/me`, so this branch is a fact about the
        // deployment rather than a guess about the hostname.
        <div className="notice-banner" role="status">
          <strong>Sign-in is not configured on this server.</strong>
          <p>
            An administrator must set <code>GOOGLE_CLIENT_ID</code> and{' '}
            <code>GOOGLE_CLIENT_SECRET</code> before anyone can sign in. Machine callers
            can still authenticate with the <code>ADMIN_API_TOKEN</code> bearer
            credential.
          </p>
        </div>
      )}

      <p className="muted small">
        <AppLink href="/">Continue without signing in</AppLink> — public share links keep
        working, but the file browser needs a session.
      </p>
    </div>
  );
}
