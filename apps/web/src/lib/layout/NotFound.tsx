/**
 * 404 body, shared by the routes whose loaders return `null` for a missing
 * bucket/org rather than throwing.
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
      <AppLink to="/">Back to files</AppLink>
    </p>
  </div>
);

export default NotFound;
