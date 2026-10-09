/**
 * 404 body, shared by the routes whose loaders return `null` for a missing
 * bucket/org rather than throwing.
 *
 * Kept out of `__root.tsx` on purpose: the root has no `notFoundComponent`
 * because a 404 inside the shell is a page-level concern. Each route that can
 * fail to resolve something renders this, so the user keeps the top bar (and
 * therefore a way back) instead of landing on a bare error page.
 */

import { AppLink } from './AppLink';

const NotFound = ({
  title = 'Not found',
  detail,
}: {
  title?: string;
  detail?: string;
}): React.JSX.Element => (
  <div className="empty-state">
    <h2>{title}</h2>
    {detail ? <p>{detail}</p> : null}
    <p>
      <AppLink href="/">Back to files</AppLink>
    </p>
  </div>
);

export default NotFound;
