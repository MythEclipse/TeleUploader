/**
 * `/$orgSlug/$bucketName` — the bucket-scoped browser.
 *
 * A thin adapter over `/`. It exists because a bucket URL has to be shareable and
 * restorable: `/{org}/{bucket}?prefix=a/b/` says which bucket and which folder with no
 * client state at all, which `?bucket=` on the index route also does but only under the
 * root path.
 *
 * ## What is shared and what differs
 *
 * Everything is shared. `loadBrowser`, `FileBrowser`, `BucketTable`, `Breadcrumb`,
 * `ObjectTable`, `NoticeBanner` and `ConfirmDialog` are all imported from `../index`.
 *
 * The differences are exactly two:
 *
 *  - the bucket name comes from `params.bucketName` instead of `?bucket=`;
 *  - the organization comes from `params.orgSlug` and is passed to `loadBrowser` as an
 *    explicit argument, so every call is scoped to the tenant named in the URL.
 *
 * ## The parent loader already proved the membership
 *
 * `routes/$orgSlug.tsx` resolves the slug against `GET /api/v1/organizations` and 404s
 * a non-membership before this loader runs, so `params.orgSlug` here is a tenant the
 * account genuinely belongs to. That is why there is no second `findOrgBySlug` check:
 * duplicating it would cost a request and could disagree with the parent.
 *
 * The security boundary is still the SERVER — it refuses a non-member slug on every
 * request regardless of what the client sends. This loader's job is to make the URL's
 * tenant the one that gets asked for.
 *
 * ## Search params here carry only the prefix
 *
 * `validateSearch` declares `prefix` alone. Declaring `bucket` too would let a link
 * carry two conflicting bucket names — a path segment and a query parameter — and the
 * winner would be whichever the loader read first. One source, one value.
 *
 * ## Importing another route module is not a cycle
 *
 * This file imports from `../index`, and `../index` does not import from here. The
 * plugin-generated tree imports both.
 */

import { createFileRoute } from '@tanstack/react-router';
import { BucketTable, FileBrowser, loadBrowser } from '../index';
// Type-only, so `verbatimModuleSyntax` erases them. Importing them as values makes
// esbuild emit `import { BrowserData } from '../index'`, and it warns "not exported by
// src/routes/index.tsx" — an interface has no runtime export. The build still exited 0,
// which is exactly the shape of failure this project's gates exist to remove.
import type { BrowserData, BrowserSearch } from '../index';
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
   * `FullSearchSchemaOption` in `@tanstack/router-core` declares exactly one member:
   *
   * ```ts
   * export interface FullSearchSchemaOption<TParentRoute, TSearchValidator> {
   *     search: Expand<ResolveFullSearchSchema<TParentRoute, TSearchValidator>>;
   * }
   * ```
   *
   * So the bucket name is NOT available here and is read from `params` in the loader
   * instead. `loaderDeps` still declares `search.prefix`, which is what actually has to
   * trigger a re-run.
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
  }): Promise<BrowserData> => {
    // The org slug is passed straight through: the parent loader proved it is a
    // membership, and the server re-checks it on every request regardless.
    return loadBrowser(params.orgSlug, params.bucketName, deps.prefix);
  },
  component: BucketNameRoute,
});

function BucketNameRoute(): React.JSX.Element {
  const params = Route.useParams();
  const { prefix } = Route.useSearch();
  const data = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const canWrite = useCanWrite();

  if (data.missingBucket) {
    return (
      <NotFound
        title="Bucket not found"
        detail={`No bucket named "${params.bucketName}" exists in this workspace. It may have been deleted, or the link may point at a different organization.`}
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
                // `/$orgSlug/$bucketName`. `tsc` rejects the path form with TS2820.
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
