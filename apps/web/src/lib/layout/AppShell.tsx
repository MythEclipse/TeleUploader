/**
 * The shared chrome: top bar, nav, organization switcher, account controls.
 *
 * Deliberately NOT the file browser. `home.html` put nav, search, bucket select and the
 * admin controls in one flat bar, which is why the search box's value could silently
 * override navigation. Here the bar is the *shell* and each route renders its own
 * controls into the content area, so bucket/prefix live in search params and cannot be
 * clobbered by a stale input.
 *
 * ## The active nav item comes from the ROUTER, not from a literal
 *
 * The previous version hardcoded `aria-current="page"` on the Files link, so every page
 * announced itself as the file browser — a screen-reader user was told they were on
 * `/` while looking at the dashboard. `useRouterState` reads the resolved pathname and
 * each item compares against it.
 *
 * The comparison is prefix-based for the dashboard (which owns `/<org>/dashboard`) and
 * exact for Files, because Files is `/` — a prefix match on `/` would match everything.
 *
 * ## The Dashboard link is derived, and absent when it cannot exist
 *
 * `activeOrg` comes from the auth store. When the caller has no organization there is no
 * valid `$orgSlug` to put in the href, and a nav item to nowhere is worse than no nav
 * item. Same reasoning as the previous version, kept.
 */

import { Outlet, useRouterState } from '@tanstack/react-router';
import { useActiveOrganization } from '../auth-store';
import { AppLink } from './AppLink';
import { AuthControls } from './AuthControls';
import { OrgSwitcher } from './OrgSwitcher';

/**
 * Whether a nav href is the current page.
 *
 * Exact match for `/` (a prefix test would match every route) and prefix match for
 * everything else, so `/<org>/dashboard` stays current on a nested path.
 *
 * @param pathname - The router's resolved pathname.
 * @param href - The nav item's destination.
 * @returns Whether to mark the item as the current page.
 */
const isCurrent = (pathname: string, href: string): boolean =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

export const AppShell = (): React.JSX.Element => {
  const activeOrg = useActiveOrganization();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const dashboardHref = activeOrg ? `/${activeOrg.slug}/dashboard` : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <AppLink href="/" className="logo">
          FileDrop
        </AppLink>

        <nav aria-label="Primary">
          <AppLink href="/" aria-current={isCurrent(pathname, '/') ? 'page' : undefined}>
            Files
          </AppLink>
          {dashboardHref ? (
            <AppLink
              href={dashboardHref}
              aria-current={isCurrent(pathname, dashboardHref) ? 'page' : undefined}
            >
              Dashboard
            </AppLink>
          ) : null}
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
};
