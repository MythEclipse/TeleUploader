/**
 * `/$orgSlug` — the organization layout.
 *
 * ## This is a layout, not just a page
 *
 * TanStack file routing treats a file with a `$param` segment as a **parent** when a
 * directory of the same name exists beside it. `routes/$orgSlug/` holds
 * `dashboard.tsx` and `bucketName.tsx`, so this component renders for all three URLs
 * and must emit an `<Outlet/>` or the children render nothing at all.
 *
 * ## What changed with multi-user auth
 *
 * This loader used to resolve the slug against `listOrgs()`, which returned exactly
 * one hardcoded entry — `{id:'scoped', slug:'default'}` — because there was no
 * organizations endpoint. The route therefore threw `notFound()` for any slug but
 * `default`, and the header said "1 org, server-selected".
 *
 * Both of those statements are now false and had to go. `GET /api/v1/organizations`
 * returns the caller's real memberships, and an organization slug in the URL selects a
 * tenant rather than naming the only one.
 *
 * ## The loader is a security boundary, not a formality
 *
 * Resolving the slug here does two things:
 *
 *  1. it makes the children's `?org=` trustworthy — a slug that survives this check is
 *     one the account is genuinely a member of; and
 *  2. it turns a cross-tenant URL into a clean 404 in the shell instead of a 403
 *     rendered as a page-level error.
 *
 * The second is defence in depth, not the actual control. The server refuses a
 * non-member slug regardless of what the client asks for, and that refusal is the real
 * boundary; this check exists so the UI never has to explain a 403 a user cannot fix.
 *
 * ## Signed out is not "not found"
 *
 * With no session `GET /api/v1/organizations` answers 401. Rendering "no such
 * organization" there would be a lie: the organization may exist and the visitor may
 * belong to it. That case redirects to `/login` with a `?redirect` back to the URL they
 * asked for, so signing in lands them where they intended rather than at the dashboard.
 *
 * Relative imports, NOT `@/` — `vite.config.ts` has no `resolve.alias`, so `@/…`
 * typechecks and then fails Rollup. See `__root.tsx`.
 */

import { createFileRoute, Outlet, notFound, redirect } from '@tanstack/react-router';
import NotFound from '../lib/layout/NotFound';
import { listOrgs } from '../lib/orgs';
import type { OrgSummary } from '../lib/orgs';
import { ApiError } from '../lib/client';

/** What the layout loader hands to the layout and its children. */
export interface OrgLoaderData {
  /** The organization named by the URL, proven to be a membership. */
  readonly org: OrgSummary;
  /** Total memberships, so the layout can hint at the switcher without a second read. */
  readonly organizationCount: number;
}

export const Route = createFileRoute('/$orgSlug')({
  /**
   * Resolves the slug to a real membership before anything renders.
   *
   * @throws A redirect to `/login` when there is no session; `notFound()` when the
   *   session exists but the account is not a member of this organization; the raw
   *   error otherwise.
   */
  loader: async ({ params, location }): Promise<OrgLoaderData> => {
    let organizations: OrgSummary[];

    try {
      organizations = await listOrgs();
    } catch (error) {
      // 401 is the only "not signed in" signal. Anything else (503, network) is a real
      // failure and must not be dressed up as a login prompt — `__root` renders the
      // error, and redirecting there would loop.
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({
          to: '/login',
          search: { redirect: location.pathname + location.search },
        });
      }
      throw error;
    }

    const org = organizations.find((candidate) => candidate.slug === params.orgSlug);
    if (!org) throw notFound();

    return { org, organizationCount: organizations.length };
  },
  component: OrgLayout,
  notFoundComponent: () => (
    <NotFound
      title="No such organization"
      detail="You are not a member of an organization with this address. Check the link, or open your own workspace from the switcher."
    />
  ),
});

function OrgLayout(): React.JSX.Element {
  const { org, organizationCount } = Route.useLoaderData();
  const { orgSlug } = Route.useParams();

  return (
    <div className="org-layout" data-org-slug={org.slug}>
      {/*
        The children (`dashboard`, `bucketName`) render their own headings, so this
        header is only for the landing URL. `orgSlug` is typed as the literal
        `'dashboard'` by the generator for the child route, so this comparison narrows
        rather than widening to `string`.
      */}
      {orgSlug === 'dashboard' ? null : (
        <header className="org-header">
          <h1>{org.name}</h1>
          <p className="auth-status">
            Your role here is <code>{org.role}</code>. Every request in this workspace is
            scoped to <code>{org.slug}</code> — the server refuses any other organization.
            {organizationCount > 1
              ? ' Use the switcher in the top bar to change workspace.'
              : null}
          </p>
        </header>
      )}

      {/* Required for `/$orgSlug/dashboard` and `/$orgSlug/$bucketName`. Without it
          those routes resolve and render nothing — a 200 with an empty page. */}
      <Outlet />
    </div>
  );
}
