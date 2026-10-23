/** The shared chrome: top bar, nav, organization switcher, account controls. */

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
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-200 sticky top-0 z-50">
        <AppLink to="/" className="font-bold text-lg text-slate-900 no-underline">
          FileDrop
        </AppLink>

        <nav aria-label="Primary" className="flex items-center gap-1">
          <AppLink
            to="/"
            aria-current={isCurrent(pathname, '/') ? 'page' : undefined}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              isCurrent(pathname, '/')
                ? 'bg-blue-50 text-blue-600'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Files
          </AppLink>
          {dashboardHref ? (
            <AppLink
              to={dashboardHref}
              aria-current={isCurrent(pathname, dashboardHref) ? 'page' : undefined}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                isCurrent(pathname, dashboardHref)
                  ? 'bg-blue-50 text-blue-600'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Dashboard
            </AppLink>
          ) : null}
        </nav>

        <div className="flex-1" />

        <OrgSwitcher />
        <AuthControls />
      </header>

      <main className="flex-1 max-w-4xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
};
