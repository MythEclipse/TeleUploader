/**
 * The organization the dashboard is scoped to.
 *
 * ## There is exactly one, and the API will not tell you its name
 *
 * The org switcher is required by the contract (§1.1) and by this lane's brief.
 * It has to be built against what the server actually offers, which is:
 *
 * - **No organizations endpoint exists.** Verified:
 *   `grep -rn "'/api/v1" apps/api/src/presentation/http/controllers/*.ts
 *    apps/api/src/presentation/orpc/routers/*.ts | grep -iv "buckets\|auth"`
 *   returns nothing. `handleWebApiV1` (`web-api-controller.ts:424-484`) has
 *   exactly nine branches and none of them list organizations.
 * - **`OrganizationRepository` has one method**, `findOrganizationIdByUserId`
 *   (`domain/ports/organization-repository.ts:22`). There is no "list all".
 * - **The scope is not per-user in any case.** `resolveAdminOrganizationId()`
 *   ignores the session entirely and maps the CONFIGURED
 *   `BOOTSTRAP_ADMIN_ID` to its organization
 *   (`organization-resolver.ts`). `AuthSession` carries only a hardcoded
 *   `username`, and `parseSessionFromCookie` rejects any cookie whose `u` is not
 *   literally `"admin"` (`auth.ts:207`). There is no user identity in the
 *   session to resolve a tenant from — that is TODO.md item 6 (better-auth),
 *   deliberately deferred.
 *
 * So a switcher that rendered a list of orgs would be fabricating data. This
 * module instead exposes a **single-entry source** whose shape is ready for
 * multiple entries when P3c lands, and `OrgSwitcher` renders a disabled control
 * with the count. That is the honest shape: the UI affordance exists, and it
 * states the truth (one org, server-selected) instead of pretending to offer a
 * choice.
 *
 * ## When this becomes real
 *
 * P3c must add a server endpoint before this module can list anything. Until
 * then, adding entries here would be the same defect class as the eight
 * precedents in docs/P4-CONTRACT.md §0: a claim written down and trusted
 * downstream.
 */

import { listBuckets } from './endpoints';
import type { BucketSummary } from './types';

/**
 * One entry in the org switcher.
 *
 * `id` is the organization UUID the server scopes to. `slug` is the URL
 * segment used by `/$orgSlug/...` — it is NOT the UUID, because putting a UUID
 * in a path segment is unreadable and the contract's route shapes are
 * slug-based. `name` is a display label.
 */
export interface OrgSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Placeholder org for the single-tenant deployment.
 *
 * `id` is deliberately a constant placeholder, not a fabricated UUID: nothing
 * in the response set carries an organization id, and inventing one that looks
 * real is the mock-more-correct-than-the-code failure this phase is trying to
 * avoid. `resolveScopedOrg()` below is where a real value would enter.
 */
const SINGLE_SCOPED_ORG: OrgSummary = {
  id: 'scoped',
  slug: 'default',
  name: 'This deployment',
};

/** The orgs the switcher can render. One entry, for the reasons above. */
export const listOrgs = (): Promise<OrgSummary[]> => Promise.resolve([SINGLE_SCOPED_ORG]);

/**
 * Resolves the org whose `slug` matches, or `null`.
 *
 * With one entry this only ever matches `'default'`, so `/$orgSlug` routes for
 * any other slug 404 through the caller's loader rather than rendering a
 * foreign org's buckets.
 */
export const findOrgBySlug = async (slug: string): Promise<OrgSummary | null> => {
  const orgs = await listOrgs();
  return orgs.find((org) => org.slug === slug) ?? null;
};

/**
 * Buckets belonging to an org.
 *
 * Today every org resolves to the same server-side scope, so this is
 * `listBuckets()` and nothing else — the org argument is accepted so callers
 * written against the eventual multi-tenant shape do not have to change. It is
 * **not** sent to the server, because there is no parameter for it.
 */
export const listBucketsForOrg = async (_org: OrgSummary): Promise<BucketSummary[]> =>
  listBuckets();
