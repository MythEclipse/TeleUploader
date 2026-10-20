/**
 * The shared chrome: top bar, nav, organization switcher, account controls.
 *
 * Deliberately NOT the file browser. `home.html` put nav, search, bucket select and the
 * admin controls in one flat bar, which is why the search box's value could silently
 * override navigation. Here the bar is the *shell* and each route renders its own
 * controls into the content area, so bucket/prefix live in search params and cannot be
 * clobbered by a stale input.
 *
 * ## What changed with multi-user auth
 *
 * `NAV_ITEMS` used to be one entry — `Files` → `/` — with a comment explaining that a
 * nav item for `/$orgSlug/dashboard` "would need an org slug that does not exist yet".
 * That is no longer true: the auth store knows the caller's organizations, so the shell
 * can link to the ACTIVE one's dashboard. The link is derived, not hardcoded, and it is
 * absent when there is no organization to point at — a nav item to nowhere is worse than
 * no nav item.
 */

import { Outlet } from '@tanstack/react-router';
import { AppLink } from './AppLink';
import { AuthControls } from './AuthControls';
import { OrgSwitcher } from './OrgSwitcher';
import { useActiveOrganization } from '../auth-store';

export const AppShell = (): React.JSX.Element => {
  const activeOrg = useActiveOrganization();

  return (
    <div className="app-shell">
      <header className="topbar">
        <AppLink href="/" className="logo">
          FileDrop
        </AppLink>

        <nav aria-label="Primary">
          <AppLink href="/" aria-current="page">
            Files
          </AppLink>
          {/* Only when an organization is known: `to` is type-checked against the
              generated route tree, and a `$orgSlug` we do not have cannot be named. */}
          {activeOrg ? (
            <AppLink href={`/${activeOrg.slug}/dashboard`}>Dashboard</AppLink>
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
