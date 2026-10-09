/**
 * `/$orgSlug` — the org layout, and the thin org landing (contract §1.1).
 *
 * ## This is a layout, not just a page
 *
 * TanStack file routing treats a file with a `$param` segment as a **parent**
 * when a directory of the same name exists beside it. `routes/$orgSlug/`
 * already holds `dashboard.tsx` (this lane) and `bucketName.tsx` (the sibling
 * bucket lane), so this component renders for all three URLs and must emit an
 * `<Outlet/>` or they render nothing at all.
 *
 * The three-state branch on `isDashboard` is therefore not a nicety — it is how
 * the layout both parents its children and still renders something useful on
 * its own:
 *
 * - `/$orgSlug/dashboard` → render the child, nothing else.
 * - `/$orgSlug/$bucketName` → render the child, nothing else.
 * - `/$orgSlug` → render the landing, as the contract specifies.
 *
 * The branch keys on the **`dashboard` path segment**, which the generator
 * resolves to a literal for this route (see the generated `path` in
 * `routeTree.gen.ts`), so the literal comparison typechecks rather than being
 * widened to `string`. A param typed `string` cannot be narrowed by `===` at
 * all, which is why `isDashboard` is written as the generator types it.
 *
 * ## Why the slug is validated at all
 *
 * `findOrgBySlug` resolves against `listOrgs()`, which returns exactly ONE
 * hardcoded entry (`lib/orgs.ts`: `{id:'scoped', slug:'default'}`). There is no
 * organizations endpoint — 9 candidate paths were probed and all returned 404 —
 * so any slug other than `default` names nothing that exists. Rendering buckets
 * for an unresolvable slug would be showing another (the only) org's data under
 * a name that does not exist.
 *
 * So this route throws `notFound()`. That is a real 404 state, distinct from a
 * loader error: the shell stays, so the user keeps the top bar and a way back,
 * and `NotFound` renders inside it rather than replacing the whole page.
 *
 * The single hardcoded org is inherited, not invented — the SPA does not
 * fabricate an org id it was not given.
 *
 * ## Why there is no `beforeLoad` auth gate here
 *
 * `/$orgSlug/*` only ever lists buckets, and `GET /api/v1/buckets` is **public**
 * (`app.ts:296` registers `/api/v1/*` GET bare). Gating it would lock out the
 * exact read-only visitor this route exists to serve. Writes stay admin-gated
 * where they are, in `AuthControls` and the browser route.
 *
 * Relative imports, NOT `@/` — `vite.config.ts` has no `resolve.alias`, so
 * `@/…` typechecks and then fails Rollup. See `__root.tsx`.
 */

import { createFileRoute, Outlet, notFound } from '@tanstack/react-router';
import NotFound from '../lib/layout/NotFound';
import { findOrgBySlug } from '../lib/orgs';
import type { OrgSummary } from '../lib/orgs';

export const Route = createFileRoute('/$orgSlug')({
  /**
   * Resolves the slug before rendering anything.
   *
   * Throwing `notFound()` (rather than returning a flag the component checks)
   * means an unknown org never flashes "Loading…" and then a bucket list; the
   * not-found body is the first thing rendered.
   */
  loader: async ({ params }): Promise<OrgSummary> => {
    const org = await findOrgBySlug(params.orgSlug);
    if (!org) throw notFound();
    return org;
  },
  component: OrgLayout,
  notFoundComponent: () => (
    <NotFound
      title="No such organization"
      detail="This deployment serves a single server-selected organization. Its slug is not derived from the URL you opened."
    />
  ),
});

function OrgLayout(): React.JSX.Element {
  const org = Route.useLoaderData();
  const { orgSlug } = Route.useParams();

  return (
    <div className="org-layout" data-org-slug={org.slug}>
      {/*
        `orgSlug` is typed as the literal `'dashboard'` by the generator, so
        this comparison narrows rather than widening to `string`. It is how the
        layout both parents its children and still renders something on its own:
        `/$orgSlug/dashboard` and `/$orgSlug/$bucketName` render the child and
        nothing else, while a bare `/$orgSlug` renders the landing header.

        On the landing URL the org name is all there is to show — there is
        exactly one org, so a "choose an org" list would be a list of one item
        that navigates to itself.
      */}
      {orgSlug === 'dashboard' ? null : (
        <header className="org-header">
          <h1>{org.name}</h1>
          <p className="auth-status">
            {/*
              One org, server-selected. Says so rather than implying a choice
              that cannot be made — the same honesty `OrgSwitcher` applies.
            */}
            1 org, server-selected — <code>{org.slug}</code>. Organization membership is resolved
            server-side; this slug only names what the API already scoped.
          </p>
        </header>
      )}

      {/*
        Required for `/$orgSlug/dashboard` and `/$orgSlug/$bucketName`. Without
        it those routes resolve and render nothing — a 200 with an empty page.
      */}
      <Outlet />
    </div>
  );
}