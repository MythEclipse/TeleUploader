/** The shared chrome: modern top bar with controls. */

import { Outlet, useRouterState } from '@tanstack/react-router';
import { ThemeToggle } from '../../components/theme-toggle';
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
    <div className="flex flex-col min-h-screen bg-slate-900">
      <header className="h-16 px-5 border-b border-slate-700 bg-slate-800 flex items-center gap-4 sticky top-0 z-50">
        <AppLink to="/" className="font-bold text-blue-500 text-lg tracking-tight">
          FileDrop
        </AppLink>

        <nav aria-label="Primary" className="flex items-center gap-1">
          <AppLink
            to="/"
            aria-current={isCurrent(pathname, '/') ? 'page' : undefined}
            className="px-3 py-1.5 rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition text-sm font-medium"
          >
            Files
          </AppLink>
          {dashboardHref ? (
            <AppLink
              to={dashboardHref}
              aria-current={isCurrent(pathname, dashboardHref) ? 'page' : undefined}
              className="px-3 py-1.5 rounded-md text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition text-sm font-medium"
            >
              Dashboard
            </AppLink>
          ) : null}
        </nav>

        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <OrgSwitcher />
          <AuthControls />
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
