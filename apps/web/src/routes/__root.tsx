/**
 * Root route: document shell, error boundary, 404 boundary.
 */

import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext } from '@tanstack/react-router';
import { ArrowLeft, Cloud, RotateCw, TriangleAlert } from 'lucide-react';
import { ApiError } from '../lib/client';
import { AppLink } from '../lib/layout/AppLink';
import { AppShell } from '../lib/layout/AppShell';
import NotFound from '../lib/layout/NotFound';

export interface RouterContext {
  readonly queryClient: QueryClient;
}

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message || 'Unknown error';
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
};

/**
 * Boundary UI. Renders outside `AppShell` (a route error replaces the whole
 * subtree), so it supplies its own page chrome and background.
 */
const ErrorState = ({ error, reset }: { error: unknown; reset: () => void }): React.JSX.Element => (
  <div className="flex min-h-dvh flex-col bg-background" role="alert">
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <TriangleAlert className="size-5" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
        This page could not be rendered. The details are below.
      </p>
      <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs leading-relaxed text-danger">
        {describeError(error)}
      </pre>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
        >
          <RotateCw className="size-4" aria-hidden="true" />
          Try again
        </button>
        <AppLink
          to="/"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-surface-hover"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to files
        </AppLink>
      </div>
    </div>
  </div>
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ({ error, reset }) => <ErrorState error={error} reset={reset} />,
  notFoundComponent: () => (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4 sm:px-6">
          <AppLink to="/" className="flex items-center gap-2 font-semibold text-foreground">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Cloud className="size-4" aria-hidden="true" />
            </span>
            TeleUploader
          </AppLink>
        </div>
      </header>
      <main className="flex-1">
        <NotFound
          title="Page not found"
          detail="That address does not match any page in this app."
        />
      </main>
    </div>
  ),
});

function RootComponent(): React.JSX.Element {
  return <AppShell />;
}
