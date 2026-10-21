/**
 * `_authenticated/$orgSlug` — the tenant guard for every `/<org>/…` route.
 *
 * ## What this route is responsible for
 *
 * Two things, and it is the ONLY place either happens:
 *
 *   1. **Proving membership.** The slug comes from the URL, so it is user input. The
 *      route resolves it against the caller's own memberships and 404s a slug they do
 *      not belong to. That is UX: the server refuses a non-member slug on every
 *      request regardless of what the client sends, and that is the real boundary.
 *   2. **Publishing the tenant.** `setTenant(slug)` runs BEFORE any child prefetch, so
 *      every subsequent RPC call carries `?org=<slug>` and a child route cannot
 *      accidentally read another workspace.
 *
 * ## Why the slug is validated here rather than in each child
 *
 * Children (`dashboard`, `$bucketName`) would each need the same check, and the first
 * one that forgot it would render an empty page for a tenant the account cannot see —
 * indistinguishable from a genuinely empty workspace. One guard, one answer.
 *
 * ## Why a non-member slug is a 404 and not a 403
 *
 * A 403 confirms the organization EXISTS, which tells an outsider something about
 * another tenant's naming. Not-found is both more accurate from the caller's
 * perspective (they can see nothing of it) and quieter.
 *
 * ## The layout renders `<Outlet/>` and nothing else page-shaped
 *
 * The page chrome lives in `__root`'s `AppShell`; each child owns its own content
 * area. A wrapper here would nest a second page container inside the shell's.
 */

import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';
import { activeOrganizationOf, refreshAuth } from '../../lib/auth';
import NotFound from '../../lib/layout/NotFound';
import { organizationsQuery } from '../../lib/queries';
import { setTenant } from '../../lib/rpc';

/** What this route hands its children. */
export interface OrgContext {
  /** The organization slug, proven to be one the caller belongs to. */
  readonly orgSlug: string;
  /** That organization's display name, for headings. */
  readonly orgName: string;
}

export const Route = createFileRoute('/_authenticated/$orgSlug')({
  /**
   * Resolves the tenant and publishes it to the RPC client.
   *
   * `_authenticated` has already guaranteed a session, so this only has to answer
   * "does this account belong to the org in the URL?".
   *
   * @throws {notFound} When the slug matches no membership.
   */
  beforeLoad: async ({ context, params }): Promise<OrgContext> => {
    const state = await refreshAuth();
    if (state.kind !== 'signed-in') {
      // Unreachable behind `_authenticated`, but a signed-out state here would mean the
      // session expired mid-navigation. Falling through would render a page of 401s
      // instead of a login prompt.
      throw new Error('Your session ended. Sign in again to continue.');
    }

    const match = state.organizations.find((org) => org.slug === params.orgSlug);
    if (!match) throw notFound();

    // Before any child prefetch. Every RPC call after this point is scoped to this
    // tenant, and the server refuses a slug the caller is not a member of — so a bug
    // here cannot leak another workspace, only produce a 403.
    setTenant(match.slug);

    await context.queryClient.ensureQueryData(organizationsQuery());

    // `activeOrganizationOf` is used rather than `match` directly for its documented
    // preference order; with an explicit slug it returns that exact membership or null,
    // and `match` already proved it is non-null.
    const active = activeOrganizationOf(state, params.orgSlug) ?? match;
    return { orgSlug: active.slug, orgName: active.name };
  },

  component: OrgLayout,
  notFoundComponent: () => (
    <NotFound
      title="Workspace not found"
      detail="This account is not a member of that workspace. Check the link, or switch to a workspace you own."
    />
  ),
});

/**
 * The layout: the organization heading, then the child route.
 *
 * The heading is here rather than in each child because it is identical for all of them
 * and its data comes from this route's `beforeLoad`.
 */
function OrgLayout(): React.JSX.Element {
  const { orgName } = Route.useRouteContext();

  return (
    <div className="org-layout">
      <header className="org-header">
        <h1>{orgName}</h1>
        <p>Buckets, files and S3 credentials for this workspace.</p>
      </header>
      <Outlet />
    </div>
  );
}
