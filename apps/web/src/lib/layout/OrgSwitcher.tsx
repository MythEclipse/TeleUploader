/** Organization switcher — a REAL control now. */

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
      <span className="text-sm text-slate-500" title="No workspace is available for this account">
        no workspace
      </span>
    );
  }

  if (!active) {
    return (
      <span className="text-sm text-slate-500" title="This workspace is not available to you">
        no workspace
      </span>
    );
  }

  const multiple = organizations.length > 1;

  return (
    <label className="flex items-center gap-2" title={multiple ? 'Switch workspace' : active.name}>
      <span className="visually-hidden">Organization</span>
      <select
        aria-label="Organization"
        disabled={!multiple}
        value={active.slug}
        onChange={(event) => {
          const slug = event.target.value;
          void navigate({ to: '/$orgSlug/dashboard', params: { orgSlug: slug } });
        }}
        className="px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
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
