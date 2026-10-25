/** Dashboard route — storage totals, buckets table, S3 access, credentials. */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Boxes, Database, HardDrive, Server } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from '../../../components/ui/table';
import { useCanWrite } from '../../../lib/auth-store';
import { CredentialsPanel } from '../../../lib/credentials-panel';
import { formatSize } from '../../../lib/format';
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

/** One of the three headline numbers. */
function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

/** A read-only key/value row for the S3 connection settings. */
function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-28 shrink-0 text-[0.8125rem] font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-[0.8125rem] text-muted-foreground">{children}</dd>
    </div>
  );
}

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
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6">
      <section aria-label="Storage totals">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            icon={<HardDrive className="size-3.5" aria-hidden="true" />}
            label="Total storage"
            value={formatSize(totalBytes)}
            hint="Across every bucket in this workspace"
          />
          <Stat
            icon={<Boxes className="size-3.5" aria-hidden="true" />}
            label="Objects"
            value={totalObjects.toLocaleString()}
            hint="Live objects, deleted rows excluded"
          />
          <Stat
            icon={<Database className="size-3.5" aria-hidden="true" />}
            label="Buckets"
            value={perBucket.length.toLocaleString()}
            hint="S3 buckets owned by this workspace"
          />
        </div>
      </section>

      {usageError ? (
        <div
          className="rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] text-danger"
          role="alert"
        >
          Could not read storage usage: {usageError}
        </div>
      ) : null}

      <section aria-labelledby="dashboard-buckets">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="dashboard-buckets" className="text-[0.9375rem] font-semibold text-foreground">
            Storage per bucket
          </h2>
        </div>

        {perBucket.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <TableWrap>
              <Table>
                <caption className="sr-only">Storage per bucket</caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Bucket</TableHead>
                    <TableHead className="text-right">Objects</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {perBucket.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                      <TableCell className="tabular text-right">
                        {row.objects.toLocaleString()}
                      </TableCell>
                      <TableCell className="tabular text-right">{formatSize(row.bytes)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Link
                            to="/$orgSlug/$bucketName"
                            params={{ orgSlug, bucketName: row.name }}
                            search={{ prefix: '' }}
                            className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[0.8125rem] font-medium text-primary transition-colors hover:bg-primary-soft"
                          >
                            Open
                            <ArrowRight className="size-3.5" aria-hidden="true" />
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableWrap>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface px-4 py-10 text-center shadow-card">
            <p className="text-[0.8125rem] text-muted-foreground">
              No buckets yet — create one from the bucket page to see usage here.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="dashboard-s3">
        <div className="mb-3">
          <h2
            id="dashboard-s3"
            className="flex items-center gap-2 text-[0.9375rem] font-semibold text-foreground"
          >
            <Server className="size-4 text-subtle-foreground" aria-hidden="true" />
            S3 access
          </h2>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] text-muted-foreground">
            Point <code className="rounded bg-surface-muted px-1 py-0.5">aws-cli</code>,{' '}
            <code className="rounded bg-surface-muted px-1 py-0.5">rclone</code> or the Docker
            registry client at these values. Credentials are per workspace, so one workspace's keys
            cannot reach another's buckets.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <dl className="divide-y divide-border">
            <SettingRow label="Endpoint">
              {endpoint.isError ? (
                <span className="text-danger">
                  unavailable —{' '}
                  {endpoint.error instanceof Error ? endpoint.error.message : 'unknown error'}
                </span>
              ) : (
                <code className="rounded bg-surface-muted px-1.5 py-0.5 text-foreground">
                  {endpoint.data?.endpoint ?? '…'}
                </code>
              )}
            </SettingRow>
            <SettingRow label="Region">
              <code className="rounded bg-surface-muted px-1.5 py-0.5 text-foreground">
                {endpoint.data?.region ?? DEFAULT_REGION}
              </code>{' '}
              <span className="text-subtle-foreground">
                (the deployment's default; the API does not report a region)
              </span>
            </SettingRow>
            <SettingRow label="Addressing">
              Path-style. Bucket names are the first key segment.
            </SettingRow>
          </dl>
        </div>
      </section>

      <CredentialsPanel orgSlug={orgSlug} canWrite={canWrite} />
    </div>
  );
}

export default Route;
