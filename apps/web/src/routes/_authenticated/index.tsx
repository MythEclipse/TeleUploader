/**
 * `/` — the bucket list and the default landing page.
 *
 * ## What this route is now
 *
 * A thin shell over three shared pieces:
 *
 *   - `bucket-table.tsx` for the list and its create/delete controls;
 *   - `file-browser.tsx` for the object browser when `?bucket=` names one;
 *   - `useQuery` for the data, prefetched by this route's `beforeLoad`.
 *
 * It used to be 1468 lines because every component lived here and every piece of
 * state was a `useState`. Both are gone: the components are in `lib/`, the server
 * data is in the Query cache, and the local flags are in TanStack Stores.
 *
 * ## Why `/` resolves an organization rather than taking one from the path
 *
 * `/` has no `$orgSlug` segment, so it cannot read the tenant from route params the
 * way `/$orgSlug/*` does. It asks the API for the caller's memberships and picks the
 * default — an explicit choice (personal/owner organization first), not
 * `organizations[0]` by accident.
 *
 * The URL stays clean rather than redirecting to `/<org>`: a bare `/` is what a user
 * types, and bouncing it through a redirect adds a history entry that Back then has
 * to walk. Every scoped call passes the resolved slug explicitly.
 *
 * ## `?bucket=` and `?prefix=` are the whole state
 *
 * Selecting a bucket and drilling into a folder are search params, so a view is
 * shareable and restorable and the breadcrumb can never disagree with the data.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { activeOrganizationOf, refreshAuth } from '../../lib/auth';
import { useCanWrite } from '../../lib/auth-store';
import { BucketTable } from '../../lib/bucket-table';
import { FileBrowser, MAX_KEYS } from '../../lib/file-browser';
import NotFound from '../../lib/layout/NotFound';
import { asBucketName, asPrefix } from '../../lib/prefix';
import { bucketsQuery, objectListQuery, organizationsQuery } from '../../lib/queries';

/** The URL-side view of this route's state. */
export interface BrowserSearch {
  /** Bucket name. `''` means "no bucket selected". */
  bucket: string;
  /** Directory prefix, always `''` or ending in `/`. */
  prefix: string;
}

/** What `beforeLoad` hands the component. */
export interface IndexData {
  /** The organization the URL resolved to. */
  readonly orgSlug: string;
}

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: (search: Record<string, unknown>): BrowserSearch => ({
    bucket: asBucketName(search.bucket),
    prefix: asPrefix(search.prefix),
  }),

  /**
   * Resolves the caller and their default organization, then prefetches.
   *
   * Every await here goes through the Query cache the component reads, so nothing is
   * fetched twice: the guard's `ensureQueryData` and the component's `useQuery` share
   * one entry.
   *
   * @throws A redirect to `/login` when there is no session; an Error for a broken
   *   account invariant, which the root boundary renders.
   */
  beforeLoad: async ({ context, location, search }): Promise<IndexData> => {
    const state = await refreshAuth();

    // `_authenticated` already redirected a signed-out visitor, so reaching here with
    // `signed-out` means the state changed between the two guards. Treated as a
    // redirect rather than an error for the same reason.
    if (state.kind === 'signed-out') {
      throw redirect({
        to: '/login',
        search: { redirect: location.pathname + location.search },
      });
    }

    // `unknown` (a failed probe) has no organizations to resolve, and rendering an
    // empty browser would look like an empty account. The root boundary is the right
    // place for it.
    if (state.kind === 'unknown') {
      throw new Error('Could not determine your session. Reload to try again.');
    }

    const org = activeOrganizationOf(state);
    if (!org) {
      // A signed-in account always has a personal organization provisioned at
      // sign-in, so this is a broken invariant rather than a normal state.
      throw new Error(
        'This account belongs to no organization. Signing out and back in re-provisions a ' +
          'personal workspace; if it persists, the deployment has a provisioning fault.',
      );
    }

    const scope = { orgSlug: org.slug };

    // The bucket list is needed by both branches; the listing only when a bucket is
    // named. Both go through `ensureQueryData`, so a cached answer costs nothing.
    await Promise.all([
      context.queryClient.ensureQueryData(organizationsQuery()),
      context.queryClient.ensureQueryData(bucketsQuery(scope)),
      search.bucket
        ? context.queryClient.ensureQueryData(
            objectListQuery(scope, search.bucket, search.prefix, MAX_KEYS),
          )
        : Promise.resolve(),
    ]);

    return { orgSlug: org.slug };
  },

  component: IndexRoute,
});

/**
 * The page.
 *
 * Both queries here are cache reads, not fetches — `beforeLoad` populated them.
 * `isPending` is therefore only true during a background refetch, which is why the
 * pending state keeps the previous rows rather than replacing them with a spinner.
 */
function IndexRoute(): React.JSX.Element {
  const { orgSlug } = Route.useRouteContext();
  const { bucket, prefix } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const canWrite = useCanWrite();

  const buckets = useQuery(bucketsQuery({ orgSlug }));
  const bucketRows = buckets.data?.buckets ?? [];

  if (buckets.isError) {
    return (
      <div className="browser-page">
        <p className="error-banner" role="alert">
          Could not load buckets: {describeError(buckets.error)}
        </p>
      </div>
    );
  }

  // A bucket named in the URL that this account does not have. Checked against the
  // bucket list rather than by probing the listing, because a 404 from the listing is
  // indistinguishable from an empty bucket in the response shape.
  const bucketMissing =
    bucket.length > 0 && !buckets.isPending && !bucketRows.some((row) => row.name === bucket);

  if (bucketMissing) {
    return (
      <NotFound
        title="Bucket not found"
        detail={`No bucket named "${bucket}" exists in this workspace. It may have been deleted, or the link may belong to a different deployment.`}
      />
    );
  }

  return (
    <div className="browser-page">
      <BucketTable
        buckets={bucketRows}
        orgSlug={orgSlug}
        canWrite={canWrite}
        selected={bucket}
        onOpen={(name) =>
          // Switching bucket resets the prefix: a prefix from another bucket would
          // list nothing and look like data loss.
          void navigate({ search: { bucket: name, prefix: '' } })
        }
      />

      {bucket ? (
        <FileBrowser
          buckets={bucketRows}
          bucket={bucket}
          prefix={prefix}
          orgSlug={orgSlug}
          canWrite={canWrite}
          // Merged against the current search because `validateSearch` makes both
          // params REQUIRED: TanStack types `search` as `{bucket, prefix}` with no
          // `?`, so navigating with a `Partial` fails TS2322. Merging is also the
          // correct semantics — the browser only sends the half it means to change.
          onNavigate={(next) => void navigate({ search: { ...{ bucket, prefix }, ...next } })}
        />
      ) : null}
    </div>
  );
}

/** Human-readable text for a query failure. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

export default Route;
