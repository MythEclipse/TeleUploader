/**
 * The shared chrome: top bar, nav, organization switcher, account controls.
 */

import { Outlet, useRouterState } from '@tanstack/react-router';
import { useActiveOrganization } from '../auth-store';
import { AppLink } from './AppLink';
import { AuthControls } from './AuthControls';
import { OrgSwitcher } from './OrgSwitcher';

const isCurrent = (pathname: string, to: string): boolean =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);

export const AppShell = (): React.JSX.Element => {
  const activeOrg = useActiveOrganization();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const dashboardHref = activeOrg ? `/${activeOrg.slug}/dashboard` : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <AppLink to="/" className="logo">
          FileDrop
        </AppLink>

        <nav aria-label="Primary">
          <AppLink to="/" aria-current={isCurrent(pathname, '/') ? 'page' : undefined}>
            Files
          </AppLink>
          {dashboardHref ? (
            <AppLink
              to={dashboardHref}
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
