/**
 * Dashboard route — storage totals, buckets table, S3 access, credentials.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useCanWrite } from '../../../lib/auth-store';
import { CredentialsPanel } from '../../../lib/credentials-panel';
import { formatSize } from '../../../lib/format';
import { AppLink } from '../../../lib/layout/AppLink';
import { storageEndpointQuery, storageUsageQuery } from '../../../lib/queries';

const DEFAULT_REGION = 'us-east-1';

export const Route = createFileRoute('/_authenticated/$orgSlug/dashboard')({
  beforeLoad: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(storageUsageQuery({ orgSlug: '' })),
      context.queryClient.ensureQueryData(storageEndpointQuery({ orgSlug: '' })),
    ]);
  },
  component: DashboardRoute,
});

function DashboardRoute(): React.JSX.Element {
  const { orgSlug } = Route.useRouteContext();
  const canWrite = useCanWrite();

  const usage = useQuery(storageUsageQuery({ orgSlug }));
  const endpoint = useQuery(storageEndpointQuery({ orgSlug }));

  const totalBytes = usage.data?.organization.bytes ?? 0;
  const totalObjects = usage.data?.organization.objects ?? 0;
  const perBucket = usage.data?.buckets ?? [];

  const usageError = usage.error instanceof Error ? usage.error.message : null;

  return (
    <div className="dashboard">
      <section className="hero" aria-label="Storage totals">
        <div>
          <p className="field-label">Total storage</p>
          <p className="hero-number">{formatSize(totalBytes)}</p>
        </div>
        <div>
          <p className="field-label">Objects</p>
          <p className="hero-number">{totalObjects.toLocaleString()}</p>
        </div>
        <div>
          <p className="field-label">Buckets</p>
          <p className="hero-number">{perBucket.length}</p>
        </div>
      </section>

      {usageError ? (
        <p className="error-banner" role="alert">
          Could not read storage usage: {usageError}
        </p>
      ) : null}

      {perBucket.length > 0 ? (
        <section aria-label="Buckets">
          <div className="browser-toolbar">
            <h2 className="browser-toolbar-title">Buckets</h2>
          </div>
          <div className="panel">
            <div className="table-responsive">
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
                        <AppLink className="btn-secondary btn-sm" to={`/${orgSlug}/${row.name}`}>
                          Open
                        </AppLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-label="S3 access">
        <h2>S3 access</h2>
        <p className="field-help">
          Point <code>aws-cli</code>, <code>rclone</code> or the Docker registry client at these
          values. Credentials are per workspace, so one workspace's keys cannot reach another's
          buckets.
        </p>
        <div className="panel">
          <div className="table-responsive">
            <table className="file-table">
              <caption className="visually-hidden">S3 connection settings</caption>
              <tbody>
                <tr>
                  <th scope="row">Endpoint</th>
                  <td>
                    {endpoint.isError ? (
                      <span className="muted">
                        unavailable —{' '}
                        {endpoint.error instanceof Error ? endpoint.error.message : 'unknown error'}
                      </span>
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
                    <span className="muted">
                      Path-style. Bucket names are the first key segment.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <CredentialsPanel orgSlug={orgSlug} canWrite={canWrite} />
    </div>
  );
}

export default Route;
