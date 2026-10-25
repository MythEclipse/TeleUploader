/** `/login` — the sign-in page. */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight, CloudOff, LogIn, ShieldCheck } from 'lucide-react';
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

/** The centred card every login state shares. */
function AuthCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-xl border border-border bg-surface p-7 shadow-raised">{children}</div>
    </div>
  );
}

function LoginRoute(): React.JSX.Element {
  const state = useAuthState();
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();

  if (state.kind === 'unknown') {
    return (
      <AuthCard>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-danger-soft text-danger">
          <CloudOff className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Cannot reach the server</h1>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          The session check failed, so sign-in cannot start. This is a network or deployment
          problem, not a problem with your account.
        </p>
        <button
          type="button"
          className="mt-5 inline-flex h-9 w-full items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
          onClick={() => {
            void refreshAuth({ force: true });
          }}
        >
          Try again
        </button>
      </AuthCard>
    );
  }

  if (state.kind === 'signed-in') {
    return (
      <AuthCard>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-success-soft text-success">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Already signed in</h1>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          You are signed in as{' '}
          <strong className="font-medium text-foreground">{state.email || state.userId}</strong>.
        </p>
        <button
          type="button"
          className="mt-5 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
          onClick={() => {
            void navigate({ to: redirect || '/' });
          }}
        >
          Go to your files
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </AuthCard>
    );
  }

  if (!state.googleEnabled) {
    return (
      <AuthCard>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-warning-soft text-warning">
          <CloudOff className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Sign-in is not configured</h1>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          This deployment has no Google OAuth credentials, so it cannot sign anyone in. An
          administrator needs to set{' '}
          <code className="rounded bg-surface-muted px-1.5 py-0.5 text-foreground">
            GOOGLE_CLIENT_ID
          </code>{' '}
          and{' '}
          <code className="rounded bg-surface-muted px-1.5 py-0.5 text-foreground">
            GOOGLE_CLIENT_SECRET
          </code>{' '}
          and restart the service.
        </p>
      </AuthCard>
    );
  }

  const target = redirect || '/';
  const startHref = `/api/v1/auth/google/start?redirect=${encodeURIComponent(target)}`;

  return (
    <AuthCard>
      <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-card">
        <LogIn className="size-5" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">Sign in to TeleUploader</h1>
      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
        Every account gets its own workspace, its own buckets and its own S3 credentials. Nobody
        else can see your files.
      </p>

      <a
        className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
        href={startHref}
      >
        Continue with Google
        <ArrowRight className="size-4" aria-hidden="true" />
      </a>

      <p className="mt-4 text-xs leading-relaxed text-subtle-foreground">
        You will be redirected to Google and back. Only your email, display name and avatar are
        stored.
      </p>
    </AuthCard>
  );
}

export default Route;
