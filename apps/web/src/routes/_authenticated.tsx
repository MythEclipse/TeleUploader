/**
 * `_authenticated` — the guard layout every signed-in route lives under.
 *
 * ## Why this file and the sibling folder must BOTH exist
 *
 * Kana's routing rule, and a TanStack behaviour rather than a convention: a file
 * named `_authenticated.tsx` is the LAYOUT (it renders the guard and an `<Outlet/>`),
 * and a sibling folder `_authenticated/` holds the children rendered inside it. The
 * `.tsx` alone renders no children; the folder alone has no guard. The underscore
 * makes the segment invisible in the URL, so `_authenticated/buckets` is served at
 * `/buckets`.
 *
 * ## Why the guard is `beforeLoad` and not a redirect from a component
 *
 * `beforeLoad` runs BEFORE the route's loader and before anything renders. A
 * component-level check would have to render first, which means the loader has
 * already fired a request that can only answer 401 — a wasted round trip and, worse,
 * a flash of an error state before the redirect. Here an unauthenticated visit never
 * reaches a loader at all.
 *
 * ## Two layers, and only one is a trust boundary
 *
 * This guard is UX: it sends a signed-out visitor to `/login` with a `?redirect`
 * back to where they were going, instead of showing them a page of 401s. The real
 * boundary is the server, which refuses every `/api/v1/*` and every `/rpc` call
 * without a session. Nothing here can grant access — deleting this file would make
 * the app unpleasant, not insecure.
 *
 * ## What it does NOT do
 *
 * It does not redirect a signed-in user away from `/login`; that route is a sibling,
 * not a child, precisely so it stays reachable in every state. And it does not
 * enforce organization membership — `$orgSlug` does that, because only that route
 * knows which tenant the URL names.
 */

import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { refreshAuth } from '../lib/auth-store';

export const Route = createFileRoute('/_authenticated')({
  /**
   * Resolves the session before any child loader runs.
   *
   * `refreshAuth()` is de-duplicated inside the store, so the root's probe and this
   * guard share one request rather than racing two.
   *
   * @throws A redirect to `/login` when the caller is not signed in.
   */
  beforeLoad: async ({ location }) => {
    const state = await refreshAuth();

    // `unknown` is NOT treated as signed out. It means the probe failed (network,
    // or a deployment with the route missing) — redirecting there would send a
    // signed-in user to a login page that cannot help them, and would loop when the
    // probe keeps failing. The child routes render the error instead.
    if (state.kind !== 'signed-out') return;

    throw redirect({
      to: '/login',
      // The full intended URL, so signing in lands on the page they asked for. The
      // login route constrains this to a same-origin path and the server validates
      // it again before writing a Location header.
      search: { redirect: location.pathname + location.search },
    });
  },
  component: AuthenticatedLayout,
});

/**
 * The layout itself.
 *
 * Renders nothing but the child route: the chrome lives in `__root`'s `AppShell`,
 * so adding a second wrapper here would nest two page containers.
 */
function AuthenticatedLayout(): React.JSX.Element {
  return <Outlet />;
}
