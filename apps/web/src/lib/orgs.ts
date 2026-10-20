/**
 * The organizations the dashboard can be scoped to.
 *
 * ## What this replaces, and why it mattered
 *
 * The previous version of this file hardcoded ONE organization — literally
 * `{ id: 'scoped', slug: 'default', name: 'This deployment' }` — and its header
 * comment explained that this was honest because the API had no endpoint to list
 * organizations and the session carried only a hardcoded username. That was true at
 * the time, and it made the org switcher a permanently disabled control.
 *
 * Both premises are gone. There is now a `users` table, sessions that name a real
 * user, a `members` table that says which organizations that user belongs to, and
 * `GET /api/v1/organizations` to read them. So this module fetches.
 *
 * ## The org is the TENANT, so a wrong answer is a data-leak-shaped bug
 *
 * Every organization-scoped request passes `?org=<slug>`, and the server REFUSES a
 * slug the caller is not a member of (403, never a silent fallback). That makes the
 * failure mode here safe in one direction: a slug the client invents cannot expose
 * another tenant. The dangerous direction is the opposite — the client showing one
 * organization's name while the server is scoped to another — which is why the
 * active organization is always resolved from the server's own list rather than
 * from client state.
 */

import { listOrganizations } from './endpoints';
import type { OrganizationMembership } from './types';

/** Re-exported so callers do not need `./types` for the switcher's item type. */
export type OrgSummary = OrganizationMembership;

/**
 * Fetches the organizations the signed-in account belongs to.
 *
 * @returns The organizations, ordered by name. Empty when signed out.
 * @throws {ApiError} `401` when there is no session, or on a network failure. The
 *   caller decides whether that is an error or a signed-out state — the switcher
 *   treats it as "nothing to switch between" rather than crashing the shell.
 */
export const listOrgs = async (): Promise<OrgSummary[]> => {
  const response = await listOrganizations();
  return response.organizations;
};

/**
 * Resolves an organization by its URL slug.
 *
 * Returns `null` for a slug the account is not a member of. The caller renders "not
 * found" rather than redirecting to the user's own organization, because silently
 * substituting a different tenant for the one named in the URL is how a shared link
 * shows the wrong files.
 *
 * @param slug - The `$orgSlug` path segment.
 * @returns The organization, or `null`.
 */
export const findOrgBySlug = async (slug: string): Promise<OrgSummary | null> => {
  const orgs = await listOrgs();
  return orgs.find((org) => org.slug === slug) ?? null;
};
