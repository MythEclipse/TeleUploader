/**
 * Query options for every server read, built on the typed API surface.
 *
 * ## Why this exists as a separate layer
 *
 * Three callers need the same reads and none of them may own the others' data:
 *
 *   - route `beforeLoad` guards, which run outside React and prefetch into the cache
 *     so the first paint has rows;
 *   - components, which read what the guard put there;
 *   - mutations, which invalidate it.
 *
 * Expressing each read once as a `queryOptions` object means the guard's prefetch and
 * the component's `useQuery` are the SAME query — same key, same fetcher, one cache
 * entry. Written twice they would be two entries and the page would fetch the listing
 * again on mount, which is the waterfall the prefetch exists to remove.
 *
 * ## The organization travels on the RPC URL, so it is a KEY, not an argument
 *
 * No procedure takes an org parameter: `lib/rpc.ts` appends `?org=<slug>` to every
 * request from a store the `$orgSlug` guard sets before any prefetch. The slug is still
 * the leading segment of every query key, because that is what stops one tenant's cached
 * bucket list from being served under another tenant's heading.
 *
 * `TenantScope.orgSlug` is therefore OPTIONAL. A route guard that resolved the slug
 * passes it and gets a fully-namespaced key; a component rendering INSIDE the `$orgSlug`
 * subtree may omit it, because the tenant is already published and `slugFor` falls back
 * to it. Omitting it never risks a cross-tenant collision — the key still carries
 * whichever slug was published, and the server refuses a slug the caller does not
 * belong to.
 *
 * ## Why the reads are NOT gated on a slug
 *
 * An earlier version had `enabled: scope.orgSlug.length > 0` on every tenant-scoped
 * query. That was correct when the slug was an argument and a missing one meant "ask for
 * the default tenant". It is wrong now: the slug is published by the guard that runs
 * before these queries, so gating on it only disabled the queries for a caller that
 * legitimately omitted it — a dashboard that silently never fetched.
 */

import { queryOptions } from '@tanstack/react-query';
import { api } from './api';
import { keys } from './query-keys';
import { currentTenant } from './rpc';

/** A tenant scope. Omit the slug inside the `$orgSlug` layout; see the file header. */
export interface TenantScope {
  readonly orgSlug?: string;
}

/**
 * The slug a key should be namespaced under.
 *
 * Falls back to the published tenant, so a component deep inside the layout gets a
 * correctly-namespaced key without threading the slug down.
 *
 * @param scope - The caller's scope, if it has one.
 * @returns The slug, or `''` when no tenant is known.
 */
const slugFor = (scope: TenantScope): string => scope.orgSlug ?? currentTenant();

/**
 * The caller's organizations.
 *
 * Not tenant-scoped — it is what DISCOVERS the tenants, so it runs unconditionally. This
 * is also the read that answers 401 for a signed-out visitor, which the retry policy
 * deliberately does not retry.
 */
export const organizationsQuery = () =>
  queryOptions({
    queryKey: keys.organizations(),
    queryFn: () => api.listOrganizations(),
  });

/** One organization's buckets. */
export const bucketsQuery = (scope: TenantScope = {}) =>
  queryOptions({
    queryKey: keys.bucketList(slugFor(scope)),
    queryFn: () => api.listBuckets(),
  });

/**
 * One bucket's listing at one prefix.
 *
 * `delimiter: '/'` is explicit. The server defaults it via `|| '/'`, so an empty
 * delimiter cannot express "no delimiter" — the listing always rolls one level up into
 * `prefixes`, and drilling down means changing `prefix`.
 */
export const objectListQuery = (
  scope: TenantScope,
  bucket: string,
  prefix: string,
  maxKeys: number,
) =>
  queryOptions({
    queryKey: keys.objectList(slugFor(scope), bucket, prefix),
    queryFn: () => api.listObjects({ bucket, prefix, delimiter: '/', maxKeys }),
    enabled: bucket.length > 0,
  });

/** One bucket's storage usage. */
export const bucketUsageQuery = (scope: TenantScope, bucket: string) =>
  queryOptions({
    queryKey: keys.bucketUsage(slugFor(scope), bucket),
    queryFn: () => api.bucketUsage(bucket),
    enabled: bucket.length > 0,
  });

/** Organization-wide storage usage — the dashboard's totals. */
export const storageUsageQuery = (scope: TenantScope = {}) =>
  queryOptions({
    queryKey: keys.storageUsage(slugFor(scope)),
    queryFn: () => api.storageUsage(),
  });

/** The S3 endpoint a user pastes into a client. */
export const storageEndpointQuery = (scope: TenantScope = {}) =>
  queryOptions({
    queryKey: keys.storageEndpoint(slugFor(scope)),
    queryFn: () => api.storageEndpoint(),
  });

/** The S3 credentials list. Summaries only — no secret is ever returned here. */
export const credentialsQuery = (scope: TenantScope = {}) =>
  queryOptions({
    queryKey: keys.credentials(slugFor(scope)),
    queryFn: () => api.listCredentials(),
  });

/**
 * A search across the organization's objects.
 *
 * `enabled` requires a non-empty term: an empty search is not "list everything", and the
 * server would scan the whole tenant for nothing. This is the one `enabled` that is
 * about the USER's input rather than about tenant readiness.
 */
export const searchQuery = (scope: TenantScope, term: string) =>
  queryOptions({
    queryKey: keys.search(slugFor(scope), term),
    queryFn: () => api.search(term),
    enabled: term.trim().length > 0,
  });
