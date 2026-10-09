/**
 * Root route: document shell, error boundary, auth probe. No page content.
 *
 * ## Why this file must exist at all
 *
 * Not a style choice — a build gate. `@tanstack/router-plugin`'s generator calls
 * `generate()` during Vite's `configResolved`, and without a `__root.tsx` it
 * throws:
 *
 * ```
 * Error: rootRouteNode must not be undefined. Make sure you've added your root
 * route into the route-tree. … Add the file in: "…/apps/web/src/routes/__root.tsx"
 * ```
 *
 * and then **continues**, emitting a build that exits 0 with the stale
 * `routeTree.gen.ts` (or no tree at all). Verified by running it. That is the
 * worst failure shape in this repo: a green build that shipped a stale or empty
 * router. `src/routeTree.gen.ts` is written by the plugin, not by hand — do not
 * edit it.
 *
 * ## What lives here and what does not
 *
 * Auth *state* lives in `src/lib/auth-store.ts`, not in this component
 * (contract §1.1). This file only (a) mounts the shell and (b) fires the
 * initial probe once. `AppShell` and its children read the store directly.
 */

import { createRootRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
// Relative specifiers, NOT the `@/*` alias that `tsconfig.json` declares.
//
// `tsconfig.json` sets `paths: { "@/*": ["./src/*"] }`, so `@/lib/client`
// typechecks — but `vite.config.ts` has NO `resolve.alias` block, so Rollup
// cannot resolve it:
//
//   [vite]: Rollup failed to resolve import "@/lib/layout/AppShell" from
//   "…/src/routes/__root.tsx".
//
// Two configuration surfaces, one alias, and only one of them wired. The
// alias is the correct fix and belongs in `vite.config.ts`, which this lane does
// not own. Until that lane adds it, relative imports are the only form that
// both typechecks AND bundles. Do not "simplify" these to `@/` — `tsc` will
// stay green while `vite build` fails.
import { AppLink } from '../lib/layout/AppLink';
import { AppShell } from '../lib/layout/AppShell';
import { ApiError } from '../lib/client';
import { refreshAuth } from '../lib/auth-store';

/**
 * Human-readable text for anything thrown inside a route.
 *
 * Takes `unknown` because that is what `errorComponent` hands over — narrowing
 * to `Error` here would be a lie the compiler cannot check, and a thrown string
 * or a rejected non-Error is reachable from a loader.
 */
const describeError = (error: unknown): string => {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message || 'Unknown error';
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
};

const ErrorState = ({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}): React.JSX.Element => (
  <div className="error-state" role="alert">
    <h1>Something went wrong</h1>
    <p className="error-message">{describeError(error)}</p>
    <div className="buttons">
      <button type="button" onClick={reset}>
        Try again
      </button>
      <AppLink href="/">Back to files</AppLink>
    </div>
  </div>
);

export const Route = createRootRoute({
  component: RootComponent,
  // `errorComponent` receives the error and a `reset` that re-runs the failed
  // loader. A route-level 401 must NOT become a crash page — it is a normal
  // read-only state, and `AuthControls` handles it.
  errorComponent: ({ error, reset }) => <ErrorState error={error} reset={reset} />,
  // No `notFoundComponent` on the root: `NotFound` is rendered by the `$orgSlug`
  // and index routes so each can keep its own chrome.
});

function RootComponent(): React.JSX.Element {
  useEffect(() => {
    // Idempotent and de-duplicated inside the store, so StrictMode's double
    // mount and any navigation-driven remount do not double-probe.
    void refreshAuth();
  }, []);

  return <AppShell />;
}
