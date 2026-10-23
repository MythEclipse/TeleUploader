/**
 * The root route: document shell, error boundary, and the one-time auth probe.
 *
 * ## Why this file must exist at all
 *
 * Not a style choice — a build gate. `@tanstack/router-plugin`'s generator calls
 * `generate()` during Vite's `configResolved`, and without a `__root.tsx` it throws
 * `rootRouteNode must not be undefined` and then **continues**, emitting a build
 * that exits 0 with a stale `routeTree.gen.ts`. Verified by running it. That is the
 * worst failure shape in this repo: a green build that shipped a broken router.
 * `src/routeTree.gen.ts` is written by the plugin — never edit it by hand.
 *
 * ## Why there is no `useEffect` here
 *
 * Kana bans React hooks. The previous version fired the auth probe from a
 * `useEffect` with an empty dependency array, which runs AFTER the first paint — so
 * the shell briefly rendered "Checking session…" on every cold load even when the
 * `_authenticated` guard had already resolved the answer. The probe now happens in
 * `_authenticated`'s `beforeLoad`, which is strictly earlier and runs exactly once
 * per navigation that needs it.
 */

import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext } from '@tanstack/react-router';
import { ApiError } from '../lib/client';
import { AppLink } from '../lib/layout/AppLink';
import { AppShell } from '../lib/layout/AppShell';

/** What every route's `beforeLoad` and loader receives. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * Human-readable text for anything thrown inside a route.
 *
 * Takes `unknown` because that is what `errorComponent` hands over — narrowing to
 * `Error` here would be a lie the compiler cannot check, and a thrown string or a
 * rejected non-Error is reachable from a loader.
 *
 * @param error - The thrown value.
 * @returns A message safe to render.
 */
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
  // `errorComponent` receives the error and a `reset` that re-runs the failed
  // loader. A route-level 401 must NOT become a crash page — it is a normal
  // signed-out state, and `_authenticated` redirects before a loader can see it.
  errorComponent: ({ error, reset }) => <ErrorState error={error} reset={reset} />,
});

/**
 * The document shell.
 *
 * `AppShell` renders the top bar and an `<Outlet/>`; the route tree below this one
 * fills that outlet. Keeping the chrome here (rather than per-route) is what makes
 * the top bar persist across navigations instead of remounting.
 */
function RootComponent(): React.JSX.Element {
  return <AppShell />;
}
