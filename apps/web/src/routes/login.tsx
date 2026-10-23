/** `/login` — the sign-in page. */

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
      <div className="max-w-md mx-auto mt-12 p-8 bg-white border border-slate-200 rounded-xl text-center">
        <h1 className="text-2xl font-bold text-slate-900 mb-3">FileDrop</h1>
        <p className="text-slate-600 mb-6">
          Could not reach the server to check your session. This is a network or deployment problem,
          not a sign-in problem.
        </p>
        <button
          type="button"
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
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
      <div className="max-w-md mx-auto mt-12 p-8 bg-white border border-slate-200 rounded-xl text-center">
        <h1 className="text-2xl font-bold text-slate-900 mb-3">Already signed in</h1>
        <p className="text-slate-600 mb-6">
          You are signed in as <strong className="text-slate-900">{state.email || state.userId}</strong>.
        </p>
        <button
          type="button"
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
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
      <div className="max-w-md mx-auto mt-12 p-8 bg-white border border-slate-200 rounded-xl text-center">
        <h1 className="text-2xl font-bold text-slate-900 mb-3">Sign-in is not configured</h1>
        <p className="text-slate-600 mb-6">
          This deployment has no Google OAuth credentials, so it cannot sign anyone in. An
          administrator needs to set <code className="bg-slate-100 px-1.5 py-0.5 rounded text-red-600 font-mono">GOOGLE_CLIENT_ID</code> and{' '}
          <code className="bg-slate-100 px-1.5 py-0.5 rounded text-red-600 font-mono">GOOGLE_CLIENT_SECRET</code> and restart the service.
        </p>
      </div>
    );
  }

  const target = redirect || '/';
  const startHref = `/api/v1/auth/google/start?redirect=${encodeURIComponent(target)}`;

  return (
    <div className="max-w-md mx-auto mt-12 p-8 bg-white border border-slate-200 rounded-xl text-center">
      <h1 className="text-2xl font-bold text-slate-900 mb-3">FileDrop</h1>
      <p className="text-slate-600 mb-6">
        Sign in with Google to reach your buckets. Every account gets its own workspace and its own
        S3 credentials; nobody else can see your files.
      </p>
      <a
        className="block w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors text-center"
        href={startHref}
      >
        Continue with Google
      </a>
      <p className="text-sm text-slate-500 mt-4">
        You will be redirected to Google and back. Only your email, display name and avatar are
        stored.
      </p>
      <div className="mt-6 flex justify-center">
        <ThemeToggle />
      </div>
    </div>
  );
}

export default Route;
