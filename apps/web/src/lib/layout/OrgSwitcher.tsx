/**
 * Org switcher.
 *
 * Renders the orgs `./orgs` can actually enumerate. There is exactly one, and
 * the API has no endpoint that would return more (see `./orgs.ts` for the
 * verification). So the control is present and **disabled**, stating the count —
 * it does not offer a choice that cannot be honoured, and it does not fabricate
 * a list to look complete.
 *
 * The moment P3c lands a real organizations endpoint, `listOrgs` grows a fetch
 * and this becomes a working `<select>`; nothing else changes.
 */

import { useEffect, useState } from 'react';
import { listOrgs } from '../orgs';
import type { OrgSummary } from '../orgs';

export const OrgSwitcher = (): React.JSX.Element => {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    // `listOrgs` resolves rather than rejects; the guard is belt-and-braces for
    // the day it becomes a real fetch.
    void listOrgs().then(
      (next) => {
        if (!cancelled) setOrgs(next);
      },
      () => {
        if (!cancelled) setOrgs([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const multiple = orgs.length > 1;
  const active = orgs[0];

  return (
    <label className="org-switcher" title="Organizations are server-selected in this deployment">
      <span className="visually-hidden">Organization</span>
      <select
        aria-label="Organization"
        disabled={!multiple}
        value={active?.slug ?? ''}
        onChange={() => {
          /* unreachable while `multiple` is false; wired when P3c adds a list */
        }}
      >
        {(orgs.length > 0 ? orgs : [{ slug: '', name: 'Loading…' }]).map((org) => (
          <option key={org.slug} value={org.slug}>
            {org.name}
          </option>
        ))}
      </select>
      <span className="org-count" aria-live="polite">
        {orgs.length === 1 ? '1 org — server-selected' : `${orgs.length} orgs`}
      </span>
    </label>
  );
};
