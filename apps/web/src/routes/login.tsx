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
      <div className="max-w-md mx-auto mt-16 p-8 bg-slate-800 border border-slate-700 rounded-lg text-center shadow-lg">
        <h1 className="text-2xl font-bold mb-3">FileDrop</h1>
        <p className="text-slate-400 mb-6">
          Could not reach the server to check your session. This is a network or deployment problem,
          not a sign-in problem.
        </p>
        <button
          type="button"
          className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
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
      <div className="max-w-md mx-auto mt-16 p-8 bg-slate-800 border border-slate-700 rounded-lg text-center shadow-lg">
        <h1 className="text-2xl font-bold mb-3">Already signed in</h1>
        <p className="text-slate-400 mb-6">
          You are signed in as <strong className="text-slate-200">{state.email || state.userId}</strong>.
        </p>
        <button
          type="button"
          className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
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
      <div className="max-w-md mx-auto mt-16 p-8 bg-slate-800 border border-slate-700 rounded-lg text-center shadow-lg">
        <h1 className="text-2xl font-bold mb-3">Sign-in is not configured</h1>
        <p className="text-slate-400 mb-6">
          This deployment has no Google OAuth credentials, so it cannot sign anyone in. An
          administrator needs to set <code className="bg-slate-900 px-1.5 py-0.5 rounded text-slate-300">GOOGLE_CLIENT_ID</code> and{' '}
          <code className="bg-slate-900 px-1.5 py-0.5 rounded text-slate-300">GOOGLE_CLIENT_SECRET</code> and restart the service.
        </p>
      </div>
    );
  }

  const target = redirect || '/';
  const startHref = `/api/v1/auth/google/start?redirect=${encodeURIComponent(target)}`;

  return (
    <div className="max-w-md mx-auto mt-16 p-8 bg-slate-800 border border-slate-700 rounded-lg text-center shadow-lg">
      <h1 className="text-2xl font-bold mb-3">FileDrop</h1>
      <p className="text-slate-400 mb-6">
        Sign in with Google to reach your buckets. Every account gets its own workspace and its own
        S3 credentials; nobody else can see your files.
      </p>
      <a className="inline-flex items-center justify-center w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition" href={startHref}>
        Continue with Google
      </a>
      <p className="text-slate-500 text-sm mt-4">
        You will be redirected to Google and back. Only your email, display name and avatar are
        stored.
      </p>
    </div>
  );
}

export default Route;
