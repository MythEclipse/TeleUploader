/** Dashboard route — storage totals, buckets table, S3 access, credentials. */

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
    <div className="p-6 space-y-6">
      <section aria-label="Storage totals">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 bg-slate-800 border border-slate-700 rounded-lg shadow-sm">
            <p className="text-xs uppercase text-slate-400 font-semibold mb-2 tracking-wide">
              Total storage
            </p>
            <p className="text-3xl font-bold text-slate-100">{formatSize(totalBytes)}</p>
          </div>
          <div className="p-5 bg-slate-800 border border-slate-700 rounded-lg shadow-sm">
            <p className="text-xs uppercase text-slate-400 font-semibold mb-2 tracking-wide">
              Objects
            </p>
            <p className="text-3xl font-bold text-slate-100">{totalObjects.toLocaleString()}</p>
          </div>
          <div className="p-5 bg-slate-800 border border-slate-700 rounded-lg shadow-sm">
            <p className="text-xs uppercase text-slate-400 font-semibold mb-2 tracking-wide">
              Buckets
            </p>
            <p className="text-3xl font-bold text-slate-100">{perBucket.length}</p>
          </div>
        </div>
      </section>

      {usageError ? (
        <div
          className="p-3 rounded-lg border border-red-500/50 bg-red-500/10 text-red-400"
          role="alert"
        >
          Could not read storage usage: {usageError}
        </div>
      ) : null}

      {perBucket.length > 0 ? (
        <section aria-label="Buckets">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-slate-200">Buckets</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <caption className="sr-only">Storage per bucket</caption>
              <thead>
                <tr className="bg-slate-900/50">
                  <th scope="col" className="text-xs uppercase text-slate-400 font-semibold p-3">
                    Bucket
                  </th>
                  <th
                    scope="col"
                    className="text-xs uppercase text-slate-400 font-semibold p-3 text-right"
                  >
                    Objects
                  </th>
                  <th
                    scope="col"
                    className="text-xs uppercase text-slate-400 font-semibold p-3 text-right"
                  >
                    Size
                  </th>
                  <th scope="col" className="p-3 sr-only">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {perBucket.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-900/30 transition">
                    <th scope="row" className="p-3 font-medium text-slate-200">
                      {row.name}
                    </th>
                    <td className="p-3 text-right text-slate-300">
                      {row.objects.toLocaleString()}
                    </td>
                    <td className="p-3 text-right text-slate-300">{formatSize(row.bytes)}</td>
                    <td className="p-3">
                      <AppLink
                        className="inline-flex items-center justify-center px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition"
                        to={`/${orgSlug}/${row.name}`}
                      >
                        Open
                      </AppLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-label="S3 access">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-200">S3 access</h2>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Point <code>aws-cli</code>, <code>rclone</code> or the Docker registry client at these
          values. Credentials are per workspace, so one workspace's keys cannot reach another's
          buckets.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <caption className="sr-only">S3 connection settings</caption>
            <tbody className="divide-y divide-slate-700">
              <tr>
                <th scope="row" className="p-3 font-medium text-slate-200">
                  Endpoint
                </th>
                <td className="p-3">
                  {endpoint.isError ? (
                    <span className="text-slate-400">
                      unavailable —{' '}
                      {endpoint.error instanceof Error ? endpoint.error.message : 'unknown error'}
                    </span>
                  ) : (
                    <code className="text-slate-200 bg-slate-900/50 px-2 py-0.5 rounded">
                      {endpoint.data?.endpoint ?? '…'}
                    </code>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row" className="p-3 font-medium text-slate-200">
                  Region
                </th>
                <td className="p-3">
                  <code className="text-slate-200 bg-slate-900/50 px-2 py-0.5 rounded">
                    {endpoint.data?.region ?? DEFAULT_REGION}
                  </code>{' '}
                  <span className="text-xs text-slate-500">
                    (the deployment's default; the API does not report a region)
                  </span>
                </td>
              </tr>
              <tr>
                <th scope="row" className="p-3 font-medium text-slate-200">
                  Addressing
                </th>
                <td className="p-3">
                  <span className="text-slate-400 text-sm">
                    Path-style. Bucket names are the first key segment.
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <CredentialsPanel orgSlug={orgSlug} canWrite={canWrite} />
    </div>
  );
}

export default Route;
