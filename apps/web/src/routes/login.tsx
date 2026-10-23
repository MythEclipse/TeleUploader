/**
 * `/login` — the sign-in page.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ThemeToggle } from '../components/theme-toggle';
import { refreshAuth, useAuthState } from '../lib/auth-store';

export interface LoginSearch {
  redirect: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: normaliseRedirect(search.redirect),
  }),

  beforeLoad: async () => {
    await refreshAuth({ force: true });
  },

  component: LoginRoute,
});

function normaliseRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '';
  if (value.startsWith('//')) return '';
  return value;
}

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
          className="btn-primary"
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
          className="btn-primary"
          onClick={() => {
            void navigate({ to: redirect || '/' });
          }}
        >
          Go to your files
        </button>
      </div>
    );
  }

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
      <a className="btn-primary google-signin" href={startHref}>
        Continue with Google
      </a>
      <p className="field-help">
        You will be redirected to Google and back. Only your email, display name and avatar are
        stored.
      </p>
      <ThemeToggle />
    </div>
  );
}

export default Route;
