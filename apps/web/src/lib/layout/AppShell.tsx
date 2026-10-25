/** The shared chrome: a sticky top bar with navigation, theme and account controls. */

import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Cloud, Files, LayoutDashboard } from 'lucide-react';
import { ThemeToggle } from '../../components/theme-toggle';
import { useActiveOrganization } from '../auth-store';
import { AuthControls } from './AuthControls';
import { OrgSwitcher } from './OrgSwitcher';

const isCurrent = (pathname: string, to: string): boolean =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);

const NAV_ITEM =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors';

export const AppShell = (): React.JSX.Element => {
  const activeOrg = useActiveOrganization();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const dashboardHref = activeOrg ? `/${activeOrg.slug}/dashboard` : null;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6">
          <Link
            to="/"
            className="mr-1 flex items-center gap-2 rounded-lg font-semibold tracking-tight text-foreground transition-opacity hover:opacity-80"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-card">
              <Cloud className="size-4" aria-hidden="true" />
            </span>
            <span className="text-[0.9375rem]">TeleUploader</span>
          </Link>

          <nav aria-label="Primary" className="flex items-center gap-0.5">
            <Link
              to="/"
              aria-current={isCurrent(pathname, '/') ? 'page' : undefined}
              className={`${NAV_ITEM} ${
                isCurrent(pathname, '/')
                  ? 'bg-surface-muted text-foreground'
                  : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
              }`}
            >
              <Files className="size-3.5" aria-hidden="true" />
              Files
            </Link>
            {dashboardHref ? (
              <Link
                to={dashboardHref}
                aria-current={isCurrent(pathname, dashboardHref) ? 'page' : undefined}
                className={`${NAV_ITEM} ${
                  isCurrent(pathname, dashboardHref)
                    ? 'bg-surface-muted text-foreground'
                    : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                }`}
              >
                <LayoutDashboard className="size-3.5" aria-hidden="true" />
                Dashboard
              </Link>
            ) : null}
          </nav>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <OrgSwitcher />
            <ThemeToggle />
            <AuthControls />
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
