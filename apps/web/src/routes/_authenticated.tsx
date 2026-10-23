/**
 * `_authenticated` — the guard layout every signed-in route lives under.
 */

import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { refreshAuth } from '../lib/auth-store';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const state = await refreshAuth();

    if (state.kind !== 'signed-out') return;

    throw redirect({
      to: '/login',
      search: { redirect: location.pathname + location.search },
    });
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout(): React.JSX.Element {
  return <Outlet />;
}
