/**
 * Query-key factory for every server read in the dashboard.
 *
 * ## Why a factory and not inline arrays
 *
 * Kana requires one: "Always define a query key factory per feature API; never
 * inline query keys." The reason is invalidation. A mutation must invalidate
 * exactly the queries it invalidated server-side, and with keys spelled at each
 * call site there is no way to express "every listing under this bucket" — you get
 * a scatter of literals that must be kept in sync by hand, and the first one
 * someone forgets is a stale row on screen after a successful delete.
 *
 * Keys here are built so a prefix invalidation is meaningful:
 *
 *   - `keys.buckets(org)` matches every bucket query in one tenant.
 *   - `keys.objects(org, bucket)` matches every listing of one bucket — all
 *     prefixes — so an upload or delete refreshes whichever folder is on screen.
 *   - `keys.all` matches everything, for sign-out.
 *
 * ## Every key carries the organization
 *
 * Multi-tenancy makes this non-optional. Without the slug in the key, switching
 * organizations would serve the previous tenant's cached bucket list from the
 * cache — the same array of buckets rendered under a different heading. The slug is
 * the first segment of every tenant-scoped key precisely so a cross-tenant read is
 * impossible rather than merely unlikely.
 */

import type { OrganizationMembership } from './types';

/**
 * The key factory.
 *
 * `as const` on the tuples is load-bearing: TanStack's `DataTag` typing infers the
 * data type from the `queryOptions` a key was created by, and a widened
 * `readonly (string | number)[]` loses that inference at `invalidateQueries`.
 */
export const keys = {
  /** Every query in the app. Used by sign-out. */
  all: ['dashboard'] as const,

  /** The caller's organizations — the switcher's data. */
  organizations: () => [...keys.all, 'organizations'] as const,

  /** Every bucket query in one organization. */
  buckets: (orgSlug: string) => [...keys.all, orgSlug, 'buckets'] as const,

  /** The bucket list for one organization. */
  bucketList: (orgSlug: string) => [...keys.buckets(orgSlug), 'list'] as const,

  /** One bucket's storage usage. */
  bucketUsage: (orgSlug: string, bucket: string) =>
    [...keys.buckets(orgSlug), 'usage', bucket] as const,

  /**
   * Every listing of one bucket, at any prefix.
   *
   * Deliberately prefix-wide: a delete or upload inside `a/b/` must also refresh
   * the listing of `a/` (which shows `b/` as a folder row and may show a rolled-up
   * object count), and `invalidateQueries({ queryKey: keys.objects(org, bucket) })`
   * is how that is expressed in one call.
   */
  objects: (orgSlug: string, bucket: string) => [...keys.all, orgSlug, 'objects', bucket] as const,

  /** One listing at one prefix. */
  objectList: (orgSlug: string, bucket: string, prefix: string) =>
    [...keys.objects(orgSlug, bucket), prefix] as const,

  /** Organization-wide storage usage. */
  storageUsage: (orgSlug: string) => [...keys.all, orgSlug, 'storage'] as const,

  /** The S3 endpoint a user pastes into a client. */
  storageEndpoint: (orgSlug: string) => [...keys.all, orgSlug, 'storage-endpoint'] as const,

  /** The S3 credentials list. Never contains a secret — see the API's summary type. */
  credentials: (orgSlug: string) => [...keys.all, orgSlug, 'credentials'] as const,

  /** A search result set. The term is part of the key, so each is cached separately. */
  search: (orgSlug: string, term: string) => [...keys.all, orgSlug, 'search', term] as const,
} as const;

/** The slug a key factory call needs, extracted from a membership. */
export const slugOf = (org: OrganizationMembership): string => org.slug;
