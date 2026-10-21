/**
 * The router: one Query cache, one oRPC client, file-based routes.
 *
 * ## What this file owns
 *
 * Three things and nothing else:
 *
 *   1. the router, built from the plugin-generated tree;
 *   2. the `QueryClient` in its context, so every `beforeLoad` can prefetch; and
 *   3. the `Register` declaration that makes `<Link to="…">` type-check.
 *
 * `src/routeTree.gen.ts` is written by `@tanstack/router-plugin` from the files in
 * `src/routes/`. It is NOT hand-written and must not be edited: the plugin
 * overwrites it on every `vite build` / `vite dev`. It only exists once the plugin
 * has run, which is why the typecheck script builds first.
 *
 * ## Bucket and prefix live in SEARCH PARAMS, not component state
 *
 * `?bucket=x&prefix=a/b/`. `home.html` kept `currentPrefix` in a JS global and
 * never cleared the search box, so `loadObjects` re-read the input on every request
 * and silently overrode navigation — the breadcrumb then disagreed with the
 * rendered data. In the URL that state cannot desynchronise.
 *
 * ## `defaultPendingMs` and the pending state
 *
 * A route whose `beforeLoad` awaits a query shows a pending state. Without a
 * `defaultPendingMs` the flash is instant and reads as a broken render; 150ms is
 * the threshold where a fast response shows no spinner at all and a slow one shows
 * one before the user starts wondering.
 */

import { createRouter } from '@tanstack/react-router';
import { queryClient } from './lib/query';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  /**
   * The context every route receives.
   *
   * `queryClient` is required by `RouterContext`, so a route that needs to prefetch
   * gets a definite client rather than an optional one it must null-check — and the
   * prefetch lands in the SAME cache the components read.
   */
  context: { queryClient },
  /** Prefetch a route's loader on hover/focus. Cheap here: the loaders are small
   * JSON reads, and the first paint after a click is the one users notice. */
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
});

declare module '@tanstack/react-router' {
  interface Register {
    // Registers this router's types globally, which is what makes `<Link to=…>`
    // and `useParams()` type-check against the generated route tree.
    router: typeof router;
  }
}
