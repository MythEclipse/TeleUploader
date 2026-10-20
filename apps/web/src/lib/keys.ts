/**
 * URL construction for the object/bucket path segments.
 *
 * ## Why per-segment encoding, and why this file is the only place that does it
 *
 * `encodeURIComponent` on a WHOLE object key turns `/` into `%2F`. `%2F` is a legal
 * path segment, so it arrives at the server as a literal character inside the key —
 * not as a separator. Both handlers under `/api/v1/buckets/{b}/{key}` re-join the
 * remaining segments with `/`, so the key they receive is `a%2Fb%2Fnested.txt`
 * rather than `a/b/nested.txt`. Neither matches a row.
 *
 * oRPC's `deleteObject` on the same key WORKS, because `routers/bucket.ts` already
 * does this split. Reproduced here so both surfaces agree.
 *
 * ## Organization scoping
 *
 * Every request takes an optional `org` slug, appended as `?org=<slug>`. The server
 * resolves the tenant from it and REFUSES a slug the caller is not a member of —
 * never a silent fallback — so a wrong value here produces a 403 rather than another
 * tenant's data.
 *
 * The parameter is optional at THIS layer but effectively required in the UI: with
 * no slug the server falls back to the caller's personal organization, which is the
 * right default only before the user has chosen anything. `./endpoints.ts` threads
 * the active slug through from the route.
 */

/** Encodes an object key for a URL path, preserving `/` as a segment separator. */
export const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

/**
 * Encodes a bucket name. Bucket names are `[a-z0-9.-]` by `BucketNameSchema`, so
 * encoding is a no-op today — but it is applied anyway so a name that slips past
 * validation can never break out of its segment.
 */
export const encodeBucket = (bucket: string): string => encodeURIComponent(bucket);

/**
 * Appends the organization scope to a path.
 *
 * Uses `URLSearchParams` so an org slug with unusual characters is encoded, and so
 * an existing query string (the objects listing) is extended rather than replaced —
 * a naive `?org=` concatenation would produce two `?` and drop the listing params.
 *
 * @param path - A path, optionally already carrying a query string.
 * @param org - The organization slug, or undefined to omit the parameter.
 * @returns The path with `org` merged into its query, or the path unchanged.
 */
const withOrg = (path: string, org?: string): string => {
  if (!org) return path;

  const queryIndex = path.indexOf('?');
  const base = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : path.slice(queryIndex + 1));
  params.set('org', org);

  return `${base}?${params.toString()}`;
};

/** `GET /api/v1/organizations` — the switcher's data source. */
export const organizationsUrl = (): string => '/api/v1/organizations';

/** `GET /api/v1/buckets`. */
export const bucketsUrl = (org?: string): string => withOrg('/api/v1/buckets', org);

/** `DELETE /api/v1/buckets/{bucket}`. */
export const bucketUrl = (bucket: string, org?: string): string =>
  withOrg(`/api/v1/buckets/${encodeBucket(bucket)}`, org);

/** `GET /api/v1/buckets/{bucket}/objects?…`. */
export const objectsUrl = (
  bucket: string,
  query: {
    prefix?: string;
    delimiter?: string;
    maxKeys?: number;
    continuationToken?: string;
  } = {},
  org?: string,
): string => {
  const params = new URLSearchParams();
  if (query.prefix !== undefined) params.set('prefix', query.prefix);
  if (query.delimiter !== undefined) params.set('delimiter', query.delimiter);
  if (query.maxKeys !== undefined) params.set('max-keys', String(query.maxKeys));
  if (query.continuationToken !== undefined) {
    params.set('continuation-token', query.continuationToken);
  }
  if (org) params.set('org', org);

  const qs = params.toString();
  const base = `/api/v1/buckets/${encodeBucket(bucket)}/objects`;
  return qs ? `${base}?${qs}` : base;
};

/** `POST /api/v1/buckets/{bucket}/upload`. */
export const uploadUrl = (bucket: string, org?: string): string =>
  withOrg(`/api/v1/buckets/${encodeBucket(bucket)}/upload`, org);

/** `GET /api/v1/buckets/{bucket}/download/{key}`. */
export const downloadUrl = (bucket: string, key: string, org?: string): string =>
  withOrg(`/api/v1/buckets/${encodeBucket(bucket)}/download/${encodeKey(key)}`, org);

/** `DELETE /api/v1/buckets/{bucket}/{key}`. See the warning at the top of this file. */
export const objectUrl = (bucket: string, key: string, org?: string): string =>
  withOrg(`/api/v1/buckets/${encodeBucket(bucket)}/${encodeKey(key)}`, org);

/** `POST /api/v1/buckets/{bucket}/copy`. */
export const copyUrl = (bucket: string, org?: string): string =>
  withOrg(`/api/v1/buckets/${encodeBucket(bucket)}/copy`, org);
