/**
 * `_authenticated/$orgSlug/$bucketName` — a bucket-scoped, shareable view.
 *
 * ## Why this route exists alongside `/?bucket=`
 *
 * A bucket URL has to be shareable and restorable. `/<org>/<bucket>?prefix=a/b/` says
 * which workspace, which bucket and which folder with no client state at all. The index
 * route can express the same thing with `?bucket=`, but only under the root path — and a
 * link that names the workspace is a link a colleague can actually use.
 *
 * ## What is shared and what differs
 *
 * Everything visual is shared: `BucketTable` and `FileBrowser` from `lib/`. The
 * differences are exactly two:
 *
 *   - the bucket comes from `params.bucketName` instead of `?bucket=`;
 *   - the prefix is still a search param, so drilling into a folder does not change the
 *     path.
 *
 * ## The parent loader already proved the membership
 *
 * `$orgSlug` resolves the slug against the caller's memberships and 404s a non-member
 * before this loader runs, so `params.orgSlug` here is a tenant the account genuinely
 * belongs to. That is why there is no second membership check: duplicating it would cost
 * a request and could disagree with the parent.
 *
 * The security boundary is still the SERVER — it refuses a non-member slug on every
 * request regardless of what the client sends.
 *
 * ## Search params carry only the prefix
 *
 * `validateSearch` declares `prefix` alone. Declaring `bucket` too would let a link carry
 * two conflicting bucket names — a path segment and a query parameter — and the winner
 * would be whichever the loader read first. One source, one value.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { useCanWrite } from '../../../lib/auth-store';
import { BucketTable } from '../../../lib/bucket-table';
import { FileBrowser, MAX_KEYS } from '../../../lib/file-browser';
import NotFound from '../../../lib/layout/NotFound';
import { asPrefix } from '../../../lib/prefix';
import { bucketsQuery, objectListQuery } from '../../../lib/queries';

/** The URL-side state of this route. */
export interface BucketSearch {
  /** Directory prefix, always `''` or ending in `/`. */
  prefix: string;
}

export const Route = createFileRoute('/_authenticated/$orgSlug/$bucketName')({
  validateSearch: (search: Record<string, unknown>): BucketSearch => ({
    prefix: asPrefix(search.prefix),
  }),

  /**
   * Prefetches the bucket list and the first listing.
   *
   * The tenant was published by the parent guard, so these calls are scoped without
   * taking a slug argument — but the slug is passed to the query key so the cache entry
   * is namespaced by tenant.
   *
   * @throws {notFound} When the bucket does not exist in this workspace.
   */
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

/**
 * The page.
 *
 * @returns The bucket list plus the browser, scoped to the bucket in the path.
 */
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
        selected={bucketName}
        onOpen={(name) => {
          // A different bucket is a different PATH, not a different search param — the
          // bucket is this route's segment. Resetting the prefix is deliberate: a prefix
          // from another bucket would list nothing and read as data loss.
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
          // Only the prefix is settable here. A `bucket` change in `next` is ignored
          // rather than silently dropped: `BucketTable` above is what changes buckets,
          // and it navigates by path.
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
