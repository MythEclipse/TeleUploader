/** Organization switcher — cleaner, functional control. */

import { useNavigate } from '@tanstack/react-router';
import { useActiveOrganization, useAuthState, useOrganizations } from '../auth-store';

export const OrgSwitcher = (): React.JSX.Element | null => {
  const auth = useAuthState();
  const organizations = useOrganizations();
  const active = useActiveOrganization();
  const navigate = useNavigate();

  if (auth.kind !== 'signed-in') return null;

  if (organizations.length === 0) {
    return <span className="org-switcher org-empty" title="No workspace available">No workspace</span>;
  }

  if (!active) {
    return <span className="org-switcher org-empty" title="This workspace is not available">No workspace</span>;
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
