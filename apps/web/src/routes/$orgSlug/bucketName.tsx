/**
 * `/$orgSlug/$bucketName` — the bucket-scoped browser.
 *
 * This is a thin adapter over `/`. It exists because a bucket URL has to be
 * shareable and restorable: `/{org}/{bucket}?prefix=a/b/` says which bucket and
 * which folder with no client state at all, which `?bucket=` on the index route
 * also does but only under the root path.
 *
 * ## What is shared and what differs
 *
 * Everything is shared. `loadBrowser`, `FileBrowser`, `BucketTable`, `Breadcrumb`,
 * `ObjectTable`, `NoticeBanner` and `ConfirmDialog` are all imported from
 * `../index` — the contract asks for exactly this (§1.1: "Shares components with
 * `index.tsx`; differs only in that the bucket comes from the path").
 *
 * The single difference: the bucket name comes from `params.bucketName` instead
 * of `?bucket=`, and the org slug is checked against `../lib/orgs` rather than
 * invented.
 *
 * ## Search params here carry only the prefix
 *
 * `validateSearch` on this route declares `prefix` alone. Declaring `bucket` too
 * would let a link carry two conflicting bucket names — a path segment and a
 * query parameter — and the winner would be whichever the loader read first. One
 * source, one value.
 *
 * ## Importing another route module is not a cycle
 *
 * This file imports from `../index`, and `../index` does not import from here. The
 * plugin-generated tree imports both. There is no cycle, and `../index` holds no
 * reference to this route.
 */

import { createFileRoute } from '@tanstack/react-router';
import { BucketTable, FileBrowser, loadBrowser } from '../index';
// Type-only, so `verbatimModuleSyntax` erases them. Importing them as values
// makes esbuild emit `import { BrowserData } from '../index'`, and it warns
// "not exported by src/routes/index.tsx" — an interface has no runtime export.
// The build still exited 0, which is exactly the shape of failure this phase
// exists to remove.
import type { BrowserData, BrowserSearch } from '../index';
import { findOrgBySlug } from '../../lib/orgs';
import NotFound from '../../lib/layout/NotFound';
import { useCanWrite } from '../../lib/auth-store';

export const Route = createFileRoute('/$orgSlug/bucketName')({
  validateSearch: (search: Record<string, unknown>): Pick<BrowserSearch, 'prefix'> => ({
    prefix:
      typeof search.prefix === 'string' && search.prefix.length > 0
        ? search.prefix.endsWith('/')
          ? search.prefix
          : `${search.prefix}/`
        : '',
  }),
  /**
   * `loaderDeps` receives `{ search }` ONLY — **not** `params`.
   *
   * `FullSearchSchemaOption` in `@tanstack/router-core@1.171.34`
   * `dist/esm/route.d.ts:167-169` declares exactly one member:
   *
   * ```ts
   * export interface FullSearchSchemaOption<TParentRoute, TSearchValidator> {
   *     search: Expand<ResolveFullSearchSchema<TParentRoute, TSearchValidator>>;
   * }
   * ```
   *
   * So the bucket name is NOT available here and is read from `params` in the
   * loader instead. `loaderDeps` still declares `search.prefix`, which is what
   * actually has to trigger a re-run.
   */
  loaderDeps: ({ search }: { search: Pick<BrowserSearch, 'prefix'> }) => ({
    prefix: search.prefix,
  }),
  loader: async ({
    params,
    deps,
  }: {
    params: { orgSlug: string; bucketName: string };
    deps: { prefix: string };
  }): Promise<{ data: BrowserData; unknownOrg: boolean }> => {
    // `findOrgBySlug` resolves against `../lib/orgs`, which lists exactly one
    // server-selected org today. A slug that does not match is a stale or
    // hand-written link; rendering some other org's buckets would be worse than
    // saying the link is wrong.
    const org = await findOrgBySlug(params.orgSlug);
    if (!org) return { data: emptyData, unknownOrg: true };
    return { data: await loadBrowser(params.bucketName, deps.prefix), unknownOrg: false };
  },
  component: BucketNameRoute,
});

/** Placeholder for the org-not-found branch, which never reads `data`. */
const emptyData: BrowserData = {
  buckets: [],
  listing: null,
  missingBucket: false,
  error: null,
  orgSlug: '',
};

function BucketNameRoute(): React.JSX.Element {
  const params = Route.useParams();
  const { prefix } = Route.useSearch();
  const { data, unknownOrg } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const canWrite = useCanWrite();

  if (unknownOrg) {
    return (
      <NotFound
        title="Organization not found"
        detail={`This deployment is scoped to a single organization, and "${params.orgSlug}" is not it. The slug in the URL is not used to select data — the server decides the scope — so a mismatch is reported rather than silently ignored.`}
      />
    );
  }

  if (data.missingBucket) {
    return (
      <NotFound
        title="Bucket not found"
        detail={`No bucket named "${params.bucketName}" exists on this server. It may have been deleted, or the link may belong to a different deployment.`}
      />
    );
  }

  return (
    <div className="browser-page">
      {data.error ? (
        <p className="error-banner" role="alert">
          {data.error.message}
        </p>
      ) : (
        <FileBrowser
          buckets={data.buckets}
          bucket={params.bucketName}
          prefix={prefix}
          listing={data.listing}
          orgSlug={params.orgSlug}
          // Switching bucket from within a bucket page is a PATH change, not a
          // search-param change: `bucket` is not a search param on this route, so
          // `navigate({ to: … })` is the only correct way to express it.
          onNavigate={(next) => {
            const name = next.bucket;
            if (name !== undefined && name !== params.bucketName) {
              void navigate({
                // `to` is the ROUTE ID `/$orgSlug/bucketName`, not the URL path
                // `/$orgSlug/$bucketName`. They differ in the `$` on the second
                // segment, and `tsc` rejects the path form with
                // TS2820. Verified against the plugin-generated tree, which emits
                // `path: '/$orgSlug/$bucketName'` and `id: '/$orgSlug/bucketName'`.
                to: '/$orgSlug/bucketName',
                params: { orgSlug: params.orgSlug, bucketName: name },
                search: { prefix: next.prefix ?? '' },
              });
              return;
            }
            void navigate({ search: { prefix: next.prefix ?? '' } });
          }}
        />
      )}

      {data.buckets.length === 0 && !data.error ? (
        <BucketTable buckets={data.buckets} orgSlug={params.orgSlug} canWrite={canWrite} />
      ) : null}
    </div>
  );
}

export default Route;