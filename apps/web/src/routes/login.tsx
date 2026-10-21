/**
 * `/login` — the sign-in page.
 *
 * ## A SIBLING of `_authenticated`, not a child
 *
 * The underscore layout's guard redirects an unauthenticated visitor TO this route.
 * If this route lived inside that layout, the redirect would target a page the guard
 * also protects, and the browser would loop until it gave up with
 * `ERR_TOO_MANY_REDIRECTS`. Being a sibling is what makes it reachable in every
 * state — including the signed-in one, where it offers a way back.
 *
 * ## `?redirect=` is validated by the SERVER, not here
 *
 * The value is only ever a same-origin path: this page passes it to
 * `/api/v1/auth/google/start?redirect=…`, and the server refuses anything absolute
 * before writing a `Location` header. A client-side check here would be a second,
 * weaker copy of a rule the server already enforces — and the one that matters is the
 * server's, because the redirect is emitted by the server.
 *
 * ## Why the Google button is an `<a href>` and not a fetch
 *
 * The flow is a top-level redirect chain: server 302 → Google → callback → server 302
 * → app, with the session cookie set on the last hop. A `fetch` cannot follow that
 * (the cookie is HttpOnly and the chain crosses origins), so the button navigates.
 * That also means it works with JavaScript disabled, which a `fetch`-based sign-in
 * would not.
 *
 * ## States, and what each one says
 *
 * | Auth state | What renders |
 * |---|---|
 * | `signed-out` + `googleEnabled` | the Sign-in button |
 * | `signed-out` + no Google | the configuration notice — NOT a dead button |
 * | `signed-in` | "already signed in" plus a way into the app |
 * | `unknown` | a retry, because the probe failed rather than answering |
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { refreshAuth, useAuthState } from '../lib/auth-store';

/** The URL-side state of this route. */
export interface LoginSearch {
  /**
   * Where to land after signing in.
   *
   * `''` means "the default landing page". Constrained to a same-origin path at the
   * server; see the file header.
   */
  redirect: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    // Only a leading-slash path is kept. A value like `https://evil.example` is
    // reduced to '' rather than passed on: the server would refuse it anyway, and
    // forwarding a value this page already knows is invalid just produces a worse
    // error message than the default landing page.
    redirect: normaliseRedirect(search.redirect),
  }),

  /**
   * Re-probes auth on every visit.
   *
   * `force` because this page's whole job is to answer "am I signed in?" — a cached
   * `signed-in` from before a sign-out elsewhere would render "already signed in" over
   * a dead session.
   */
  beforeLoad: async () => {
    await refreshAuth({ force: true });
  },

  component: LoginRoute,
});

/**
 * Keeps only a same-origin absolute path.
 *
 * @param value - The raw `?redirect=` value.
 * @returns A path starting with `/`, or `''`.
 */
function normaliseRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '';
  // `//host` is a protocol-relative URL — a browser treats it as another origin, so it
  // is an open redirect even though it starts with a slash.
  if (value.startsWith('//')) return '';
  return value;
}

/**
 * The page.
 *
 * @returns The sign-in card.
 */
function LoginRoute(): React.JSX.Element {
  const state = useAuthState();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();

  if (state.kind === 'unknown') {
    return (
      <div className="login-page">
        <h1>FileDrop</h1>
        <p className="muted">
          Could not reach the server to check your session. This is a network or deployment problem,
          not a sign-in problem.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void refreshAuth({ force: true });
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (state.kind === 'signed-in') {
    return (
      <div className="login-page">
        <h1>Already signed in</h1>
        <p className="muted">
          You are signed in as <strong>{state.email || state.userId}</strong>.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void navigate({ to: redirect || '/' });
          }}
        >
          Go to your files
        </button>
      </div>
    );
  }

  // A genuine 401 with Google NOT configured. Rendering a Sign-in button here would
  // dead-end at a 503 from `/auth/google/start`, so the page states the deployment
  // gap instead. This is the arm that made `googleEnabled` worth reading off the 401.
  if (!state.googleEnabled) {
    return (
      <div className="login-page">
        <h1>Sign-in is not configured</h1>
        <p className="muted">
          This deployment has no Google OAuth credentials, so it cannot sign anyone in. An
          administrator needs to set <code>GOOGLE_CLIENT_ID</code> and{' '}
          <code>GOOGLE_CLIENT_SECRET</code> and restart the service.
        </p>
      </div>
    );
  }

  const target = redirect || '/';
  const startHref = `/api/v1/auth/google/start?redirect=${encodeURIComponent(target)}`;

  return (
    <div className="login-page">
      <h1>FileDrop</h1>
      <p className="muted">
        Sign in with Google to reach your buckets. Every account gets its own workspace and its own
        S3 credentials; nobody else can see your files.
      </p>
      {/* A NAVIGATION, not a fetch — see the file header. */}
      <a className="button google-signin" href={startHref}>
        Continue with Google
      </a>
      <p className="field-help">
        You will be redirected to Google and back. Only your email, display name and avatar are
        stored.
      </p>
    </div>
  );
}

export default Route;
