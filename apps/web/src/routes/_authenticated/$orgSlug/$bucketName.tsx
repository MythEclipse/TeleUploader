/**
 * Bucket-scoped route: bucket table + file browser for `/<org>/<bucket>`.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { useCanWrite } from '../../../lib/auth-store';
import { BucketTable } from '../../../lib/bucket-table';
import { FileBrowser, MAX_KEYS } from '../../../lib/file-browser';
import NotFound from '../../../lib/layout/NotFound';
import { asPrefix } from '../../../lib/prefix';
import { bucketsQuery, objectListQuery } from '../../../lib/queries';

export interface BucketSearch {
  prefix: string;
}

export const Route = createFileRoute('/_authenticated/$orgSlug/$bucketName')({
  validateSearch: (search: Record<string, unknown>): BucketSearch => ({
    prefix: asPrefix(search.prefix),
  }),

  beforeLoad: async ({ context, params, search }) => {
    const scope = { orgSlug: params.orgSlug };

    const buckets = await context.queryClient.ensureQueryData(bucketsQuery(scope));
    const exists = buckets.buckets.some((bucket) => bucket.name === params.bucketName);
    if (!exists) throw notFound();

    await context.queryClient.ensureQueryData(
      objectListQuery(scope, params.bucketName, search.prefix, MAX_KEYS),
    );

    return { orgSlug: params.orgSlug, bucketName: params.bucketName };
  },

  component: BucketRoute,
  notFoundComponent: () => (
    <NotFound
      title="Bucket not found"
      detail="No bucket by that name exists in this workspace. It may have been deleted, or the link may belong to a different workspace."
    />
  ),
});

function BucketRoute(): React.JSX.Element {
  const { orgSlug, bucketName } = Route.useRouteContext();
  const { prefix } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const canWrite = useCanWrite();

  const buckets = useQuery(bucketsQuery({ orgSlug }));
  const bucketRows = buckets.data?.buckets ?? [];

  return (
    <div className="browser-page">
      <BucketTable
        buckets={bucketRows}
        orgSlug={orgSlug}
        canWrite={canWrite}
        onOpen={(name) => {
          void navigate({
            to: '/$orgSlug/$bucketName',
            params: { orgSlug, bucketName: name },
            search: { prefix: '' },
          });
        }}
      />

      <FileBrowser
        buckets={bucketRows}
        bucket={bucketName}
        prefix={prefix}
        orgSlug={orgSlug}
        canWrite={canWrite}
        onNavigate={(next) => {
          if (next.bucket && next.bucket !== bucketName) {
            void navigate({
              to: '/$orgSlug/$bucketName',
              params: { orgSlug, bucketName: next.bucket },
              search: { prefix: next.prefix ?? '' },
            });
            return;
          }
          void navigate({ search: { prefix: next.prefix ?? prefix } });
        }}
      />
    </div>
  );
}

export default Route;
