/**
 * Router root — now bound to the plugin-generated tree.
 *
 * `src/routeTree.gen.ts` is written by `@tanstack/router-plugin` from the files
 * in `src/routes/`. It is NOT hand-written and must not be edited: the plugin
 * overwrites it on every `vite build` / `vite dev`, and it carries an
 * `eslint-disable` banner plus `@ts-nocheck` precisely because its contents are
 * derived, not authored.
 *
 * It only exists once the plugin has run. `pnpm run build` / `pnpm run dev`
 * generate it; a bare `tsc --noEmit` on a fresh clone will not, and will
 * report `Cannot find module './routeTree.gen'`. That is why the typecheck
 * script below runs the build first rather than assuming the file is there.
 *
 * ## Bucket and prefix live in SEARCH PARAMS, not component state
 *
 * `?bucket=x&prefix=a/b/`. `home.html` kept `currentPrefix` in a JS global and
 * never cleared the search box, so `loadObjects` re-read the input on every
 * request (`const prefix = searchVal || currentPrefix`, home.html:289-293) and
 * silently overrode navigation — the breadcrumb then disagreed with the
 * rendered data and the user could not escape without manually clearing the
 * box. In the URL that state cannot desynchronise.
 *
 * This router does not enforce that by itself; it is the convention the route
 * files in `src/routes/` follow. The dashboard/bucket/credentials routes owned
 * by other lanes must read and write those two params and keep no private copy.
 */

import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  /** Prefetch a route's loader on hover/focus. Cheap here: the loaders are
   * small JSON reads, and the first paint after a click is the one users notice. */
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    // Registers this router's types globally, which is what makes `<Link to=…>`
    // and `useParams()` type-check against the generated route tree.
    router: typeof router;
  }
}
