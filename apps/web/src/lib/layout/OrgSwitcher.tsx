/** Organization switcher — a compact select that stays out of the way for single-org accounts. */

import { useNavigate } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useActiveOrganization, useAuthState, useOrganizations } from '../auth-store';

export const OrgSwitcher = (): React.JSX.Element | null => {
  const auth = useAuthState();
  const organizations = useOrganizations();
  const active = useActiveOrganization();
  const navigate = useNavigate();

  if (auth.kind !== 'signed-in') return null;

  if (organizations.length === 0 || !active) {
    return (
      <span
        className="hidden items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-subtle-foreground sm:inline-flex"
        title="No workspace is available for this account"
      >
        <Building2 className="size-3" aria-hidden="true" />
        No workspace
      </span>
    );
  }

  // One organization is the common case: a disabled select reads as clutter, so
  // show the name as a label and only render a control when there is a choice.
  if (organizations.length === 1) {
    return (
      <span
        className="hidden max-w-40 items-center gap-1.5 truncate rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline-flex"
        title={active.name}
      >
        <Building2 className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{active.name}</span>
      </span>
    );
  }

  return (
    <label className="relative hidden sm:block">
      <span className="sr-only">Switch organization</span>
      <Building2
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground"
        aria-hidden="true"
      />
      <select
        aria-label="Switch organization"
        value={active.slug}
        onChange={(event) => {
          const slug = event.target.value;
          void navigate({ to: '/$orgSlug/dashboard', params: { orgSlug: slug } });
        }}
        className="h-8 max-w-48 appearance-none rounded-lg border border-border-strong bg-surface pl-8 pr-7 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
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
