/**
 * Organization switcher — a REAL control now.
 *
 * ## What this replaces
 *
 * The previous version rendered a permanently DISABLED `<select>` showing one hardcoded
 * organization, because there was no endpoint to list organizations and the session
 * carried a hardcoded username rather than a user. Its own comment said the day P3c
 * landed "this becomes a working `<select>`; nothing else changes".
 *
 * That day is now. `GET /api/v1/organizations` returns the caller's memberships, and
 * switching selects a different `?org=<slug>` for every subsequent request.
 *
 * ## The selected value comes from the URL, not from the account's default
 *
 * `useActiveOrganization()` derives the slug from the CURRENT pathname. A first draft of
 * this component instead picked `organizations.find(role === 'owner')`, which is correct
 * only on `/` — on `/<org-b>/dashboard` it displayed org A's name while the page listed
 * org B's buckets, so the `<select>` disagreed with the content beside it.
 *
 * ## Switching is a NAVIGATION, not local state
 *
 * The organization is part of the URL (`/$orgSlug/...`), so a bucket listing is
 * shareable and restorable. Keeping the selection in component state instead would let
 * the switcher and the visible file list disagree after a back button.
 *
 * With exactly one organization — the common case, since every account gets a personal
 * workspace on first sign-in — the control renders the name and is disabled. A
 * one-option dropdown that does nothing is worse than a label.
 */

import { useNavigate } from '@tanstack/react-router';
import { useActiveOrganization, useAuthState, useOrganizations } from '../auth-store';

export const OrgSwitcher = (): React.JSX.Element | null => {
  // Every hook is hoisted above every return. Calling `useActiveOrganization()` after
  // the early returns below would change the hook count between renders, which React
  // reports as "Rendered more hooks than during the previous render" and then unmounts
  // the tree — the exact defect that once lived in `routes/index.tsx`.
  const auth = useAuthState();
  const organizations = useOrganizations();
  const active = useActiveOrganization();
  const navigate = useNavigate();

  // Signed out or still probing: there is no tenant to show, and rendering a placeholder
  // would suggest a selection exists when it does not.
  if (auth.kind !== 'signed-in') return null;

  if (organizations.length === 0) {
    return (
      <span className="org-switcher org-empty" title="No workspace is available for this account">
        no workspace
      </span>
    );
  }

  // The URL names an organization this account is not a member of. Rendering the default
  // in the select would silently relabel the page as a different tenant.
  if (!active) {
    return (
      <span className="org-switcher org-empty" title="This workspace is not available to you">
        no workspace
      </span>
    );
  }

  const multiple = organizations.length > 1;

  return (
    <label className="org-switcher" title={multiple ? 'Switch workspace' : active.name}>
      <span className="visually-hidden">Organization</span>
      <select
        aria-label="Organization"
        disabled={!multiple}
        value={active.slug}
        onChange={(event) => {
          const slug = event.target.value;
          // Navigate to that organization's dashboard: the slug lives in the path, so
          // this is a route change rather than a filter on the current page.
          void navigate({ to: '/$orgSlug/dashboard', params: { orgSlug: slug } });
        }}
      >
        {organizations.map((org) => (
          <option key={org.id} value={org.slug}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  );
};
