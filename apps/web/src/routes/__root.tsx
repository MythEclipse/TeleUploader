/**
 * Root route: document shell, error boundary, and the one-time auth probe.
 */

import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext } from '@tanstack/react-router';
import { ApiError } from '../lib/client';
import { AppLink } from '../lib/layout/AppLink';
import { AppShell } from '../lib/layout/AppShell';

export interface RouterContext {
  readonly queryClient: QueryClient;
}

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message || 'Unknown error';
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
};

const ErrorState = ({ error, reset }: { error: unknown; reset: () => void }): React.JSX.Element => (
  <div className="error-state" role="alert">
    <h1>Something went wrong</h1>
    <p className="error-message">{describeError(error)}</p>
    <div className="buttons">
      <button type="button" onClick={reset}>
        Try again
      </button>
      <AppLink to="/">Back to files</AppLink>
    </div>
  </div>
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ({ error, reset }) => <ErrorState error={error} reset={reset} />,
});

function RootComponent(): React.JSX.Element {
  return <AppShell />;
}
