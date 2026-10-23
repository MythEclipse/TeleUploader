/**
 * `_authenticated/$orgSlug/dashboard` — the workspace overview.
 *
 * ## What it answers
 *
 * Three questions a user has when they open a workspace, and nothing else:
 *
 *   1. How much am I storing? — `GET /api/v1/storage`, per bucket.
 *   2. What can I point a client at? — `GET /api/v1/storage/endpoint`.
 *   3. What keys exist, and how do I make one? — `GET/POST/DELETE /api/v1/credentials`.
 *
 * ## Why the credential secret is shown in a modal that cannot be reopened
 *
 * `POST /api/v1/credentials` returns `secretKey` exactly once; the listing path never
 * selects that column, so no later read can reproduce it. The UI therefore treats the
 * create response as a one-shot secret: it is held in a store only until dismissed,
 * labelled with what it is, and never re-fetched. A panel that offered "show secret"
 * later would be a button that always fails.
 *
 * ## Why the endpoint comes from the API
 *
 * `GET /api/v1/storage/endpoint` returns the origin built from the server's own
 * `BASE_URL`. Deriving it from `window.location.origin` is wrong behind a reverse
 * proxy — the previous version did exactly that and documented the bug — so the value
 * a user pastes into `aws s3` now comes from the server.
 *
 * ## Region is labelled as a default, not an answer
 *
 * Nothing in the API returns the S3 region. `us-east-1` is
 * `config.s3DefaultRegion`'s documented default, and the UI says so rather than
 * presenting a guess as a fact.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCanWrite } from '../../../lib/auth-store';
import { CredentialsPanel } from '../../../lib/credentials-panel';
import { formatSize } from '../../../lib/format';
import { AppLink } from '../../../lib/layout/AppLink';
import { storageEndpointQuery, storageUsageQuery } from '../../../lib/queries';

/** The region shown when the API exposes nothing. */
const DEFAULT_REGION = 'us-east-1';

export const Route = createFileRoute('/_authenticated/$orgSlug/dashboard')({
  /**
   * Prefetches the three reads this page needs.
   *
   * The tenant is already published by the parent `$orgSlug` guard, so these calls are
   * scoped correctly without taking a slug argument.
   */
  beforeLoad: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(storageUsageQuery({ orgSlug: '' })),
      context.queryClient.ensureQueryData(storageEndpointQuery({ orgSlug: '' })),
    ]);
  },
  component: DashboardRoute,
});

/**
 * The page.
 *
 * @returns The overview, the credentials panel, and a way into the buckets.
 */
function DashboardRoute(): React.JSX.Element {
  const { orgSlug } = Route.useRouteContext();
  const canWrite = useCanWrite();

  const usage = useQuery(storageUsageQuery({ orgSlug }));
  const endpoint = useQuery(storageEndpointQuery({ orgSlug }));

  const totalBytes = usage.data?.organization.bytes ?? 0;
  const totalObjects = usage.data?.organization.objects ?? 0;
  const perBucket = usage.data?.buckets ?? [];

  return (
    <div className="dashboard">
      <section className="dashboard-controls" aria-label="Storage totals">
        <div className="empty-state" style={{ flex: 1, padding: 'var(--fd-space-5)' }}>
          <h2>{formatSize(totalBytes)}</h2>
          <p className="muted">stored across {perBucket.length} bucket(s)</p>
        </div>
        <div className="empty-state" style={{ flex: 1, padding: 'var(--fd-space-5)' }}>
          <h2>{totalObjects.toLocaleString()}</h2>
          <p className="muted">objects</p>
        </div>
      </section>

      {usage.isError ? (
        <p className="error-banner" role="alert">
          Could not read storage usage: {describeError(usage.error)}
        </p>
      ) : null}

      {perBucket.length > 0 ? (
        <section aria-label="Buckets">
          <div className="browser-toolbar">
            <h2 style={{ flex: 1 }}>Buckets</h2>
          </div>
          <table className="file-table">
            <caption className="visually-hidden">Storage per bucket</caption>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col" className="numeric">
                  Objects
                </th>
                <th scope="col" className="numeric">
                  Size
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {perBucket.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.name}</th>
                  <td className="numeric">{row.objects.toLocaleString()}</td>
                  <td className="numeric">{formatSize(row.bytes)}</td>
                  <td className="actions-cell">
                    <AppLink className="button small" href={`/${orgSlug}/${row.name}`}>
                      Open
                    </AppLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section aria-label="S3 access">
        <h2>S3 access</h2>
        <p className="field-help">
          Point <code>aws-cli</code>, <code>rclone</code> or the Docker registry client at these
          values. Credentials are per workspace, so one workspace's keys cannot reach another's
          buckets.
        </p>
        <table className="file-table">
          <caption className="visually-hidden">S3 connection settings</caption>
          <tbody>
            <tr>
              <th scope="row">Endpoint</th>
              <td>
                {endpoint.isError ? (
                  <span className="muted">unavailable — {describeError(endpoint.error)}</span>
                ) : (
                  <code>{endpoint.data?.endpoint ?? '…'}</code>
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">Region</th>
              <td>
                <code>{endpoint.data?.region ?? DEFAULT_REGION}</code>{' '}
                <span className="muted small">
                  (the deployment's default; the API does not report a region)
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">Addressing</th>
              <td>
                <span className="muted">Path-style. Bucket names are the first key segment.</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <CredentialsPanel orgSlug={orgSlug} canWrite={canWrite} />
    </div>
  );
}

/** Human-readable text for a query failure. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';
