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
    <div className="space-y-6">
      <section className="grid grid-cols-3 gap-4" aria-label="Storage totals">
        <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Total storage</p>
          <p className="text-3xl font-bold text-slate-900">{formatSize(totalBytes)}</p>
        </div>
        <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Objects</p>
          <p className="text-3xl font-bold text-slate-900">{totalObjects.toLocaleString()}</p>
        </div>
        <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Buckets</p>
          <p className="text-3xl font-bold text-slate-900">{perBucket.length}</p>
        </div>
      </section>

      {usageError ? (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg" role="alert">
          Could not read storage usage: {usageError}
        </div>
      ) : null}

      {perBucket.length > 0 ? (
        <section aria-label="Buckets">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900">Buckets</h2>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 font-semibold">Bucket</th>
                    <th className="px-4 py-3 font-semibold text-right">Objects</th>
                    <th className="px-4 py-3 font-semibold text-right">Size</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {perBucket.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <th className="px-4 py-3 font-medium text-slate-900">{row.name}</th>
                      <td className="px-4 py-3 text-slate-600 text-right">{row.objects.toLocaleString()}</td>
                      <td className="px-4 py-3 text-slate-600 text-right">{formatSize(row.bytes)}</td>
                      <td className="px-4 py-3">
                        <AppLink
                          className="px-3 py-1.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
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
          </div>
        </section>
      ) : null}

      <section aria-label="S3 access">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">S3 access</h2>
        <p className="text-sm text-slate-600 mb-4">
          Point <code className="bg-slate-100 px-1.5 py-0.5 rounded text-red-600 font-mono">aws-cli</code>, <code className="bg-slate-100 px-1.5 py-0.5 rounded text-red-600 font-mono">rclone</code> or the Docker registry client at these
          values. Credentials are per workspace, so one workspace's keys cannot reach another's
          buckets.
        </p>
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <caption className="visually-hidden">S3 connection settings</caption>
              <tbody className="divide-y divide-slate-200">
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-900 w-1/3">Endpoint</th>
                  <td className="px-4 py-3">
                    {endpoint.isError ? (
                      <span className="text-slate-500">
                        unavailable —{' '}
                        {endpoint.error instanceof Error ? endpoint.error.message : 'unknown error'}
                      </span>
                    ) : (
                      <code className="font-mono text-slate-900">{endpoint.data?.endpoint ?? '…'}</code>
                    )}
                  </td>
                </tr>
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-900">Region</th>
                  <td className="px-4 py-3">
                    <code className="font-mono text-slate-900">{endpoint.data?.region ?? DEFAULT_REGION}</code>{' '}
                    <span className="text-slate-500 text-sm">
                      (the deployment's default; the API does not report a region)
                    </span>
                  </td>
                </tr>
                <tr>
                  <th className="px-4 py-3 font-medium text-slate-900">Addressing</th>
                  <td className="px-4 py-3 text-slate-600">
                    <span className="text-slate-500">
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
