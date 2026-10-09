/**
 * The shared chrome: top bar, nav, logout, org switcher.
 *
 * Ported from `home.html`'s `.topbar` (lines 158-171). Deliberately NOT a
 * component of the file browser: `home.html` put nav, search, bucket select and
 * the admin controls in one flat bar, which is why the search box's value could
 * silently override navigation. Here the bar is the *shell* and each route
 * renders its own controls into the content area, so bucket/prefix live in
 * search params and cannot be clobbered by a stale input (contract §1).
 *
 * Children own their own controls; the shell owns only chrome that is true on
 * every route.
 */

import { Outlet } from '@tanstack/react-router';
import { AppLink } from './AppLink';
import { AuthControls } from './AuthControls';
import { OrgSwitcher } from './OrgSwitcher';

/**
 * Routes reachable from every page.
 *
 * Only `/` is listed. The per-org pages (`/$orgSlug/dashboard`,
 * `/$orgSlug/$bucketName`) are reached by navigating from a bucket, not from
 * global chrome — a nav item for `/$orgSlug/dashboard` would need an org slug
 * that does not exist yet (see `../orgs.ts`), and `to:` on a TanStack `Link` is
 * type-checked against the generated route tree, so naming a route no lane has
 * written yet fails `tsc`. Add entries here when those routes land.
 */
const NAV_ITEMS = [{ to: '/', label: 'Files' }] as const;

export const AppShell = (): React.JSX.Element => (
  <div className="app-shell">
    <header className="topbar">
      <AppLink href="/" className="logo">
        FileDrop
      </AppLink>

      <nav aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          // `aria-current` is set by hand rather than by TanStack's
          // `activeProps`, because `AppLink` is a plain anchor. Swap for
          // `<Link activeProps={{...}}>` when this nav gains a real route.
          <AppLink
            key={item.to}
            href={item.to}
            aria-current={item.to === '/' ? 'page' : undefined}
          >
            {item.label}
          </AppLink>
        ))}
      </nav>

      <span className="spacer" />

      <OrgSwitcher />
      <AuthControls />
    </header>

    <main className="content">
      <Outlet />
    </main>
  </div>
);
