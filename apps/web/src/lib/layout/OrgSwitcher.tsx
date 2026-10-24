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
    return (
      <span className="text-sm text-slate-500" title="No workspace available">
        No workspace
      </span>
    );
  }

  if (!active) {
    return (
      <span className="text-sm text-slate-500" title="This workspace is not available">
        No workspace
      </span>
    );
  }

  const multiple = organizations.length > 1;

  return (
    <label className="flex items-center gap-2" title={multiple ? 'Switch workspace' : active.name}>
      <span className="sr-only">Organization</span>
      <select
        aria-label="Organization"
        disabled={!multiple}
        value={active.slug}
        className="px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-md text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-500"
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
