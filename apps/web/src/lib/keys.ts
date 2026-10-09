/**
 * URL construction for the object/bucket path segments.
 *
 * ## Why per-segment encoding, and why this file is the only place that does it
 *
 * `encodeURIComponent` on a WHOLE object key turns `/` into `%2F`. `%2F` is a
 * legal path segment, so it arrives at the server as a literal character
 * inside the key — not as a separator. Both handlers under
 * `/api/v1/buckets/{b}/{key}` re-join the remaining segments with `/`
 * (`web-api-controller.ts:468`), so the key they receive is `a%2Fb%2Fnested.txt`
 * rather than `a/b/nested.txt`. Neither matches a row. Measured against the
 * live app:
 *
 * - `DELETE /api/v1/b/{b}/a%2Fb%2Fnested.txt` -> **200 `{"success":true}`**, row
 *   unchanged. `handleDeleteObjectV1` returns `success:true` unconditionally and
 *   discards `softDelete()`'s return value, so this is a silent no-op that
 *   reports success.
 * - `GET /api/v1/b/{b}/download/a%2Fb%2Fnested.txt` -> **404
 *   `{"error":"Object not found"}`**, so the Download button opens a JSON error
 *   and Copy-link copies a URL that 404s.
 *
 * oRPC's `deleteObject` on the same key WORKS, because `routers/bucket.ts:71`
 * already does this split. Reproduced here so both surfaces agree.
 */

/** Encodes an object key for a URL path, preserving `/` as a segment separator. */
export const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

/**
 * Encodes a bucket name. Bucket names are `[a-z0-9.-]` by `BucketNameSchema`,
 * so encoding is a no-op today — but it is applied anyway so a name that slips
 * past validation can never break out of its segment.
 */
export const encodeBucket = (bucket: string): string => encodeURIComponent(bucket);

/** `GET /api/v1/buckets/{bucket}/objects?…`. */
export const objectsUrl = (bucket: string, query: {
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  continuationToken?: string;
} = {}): string => {
  const params = new URLSearchParams();
  if (query.prefix !== undefined) params.set('prefix', query.prefix);
  if (query.delimiter !== undefined) params.set('delimiter', query.delimiter);
  if (query.maxKeys !== undefined) params.set('max-keys', String(query.maxKeys));
  if (query.continuationToken !== undefined) {
    params.set('continuation-token', query.continuationToken);
  }
  const qs = params.toString();
  const base = `/api/v1/buckets/${encodeBucket(bucket)}/objects`;
  return qs ? `${base}?${qs}` : base;
};

/** `POST /api/v1/buckets/{bucket}/upload`. */
export const uploadUrl = (bucket: string): string =>
  `/api/v1/buckets/${encodeBucket(bucket)}/upload`;

/** `GET /api/v1/buckets/{bucket}/download/{key}`. */
export const downloadUrl = (bucket: string, key: string): string =>
  `/api/v1/buckets/${encodeBucket(bucket)}/download/${encodeKey(key)}`;

/** `DELETE /api/v1/buckets/{bucket}/{key}`. See the warning at the top of this file. */
export const objectUrl = (bucket: string, key: string): string =>
  `/api/v1/buckets/${encodeBucket(bucket)}/${encodeKey(key)}`;

/** `POST /api/v1/buckets/{bucket}/copy`. */
export const copyUrl = (bucket: string): string => `/api/v1/buckets/${encodeBucket(bucket)}/copy`;

/** `DELETE /api/v1/buckets/{bucket}`. */
export const bucketUrl = (bucket: string): string => `/api/v1/buckets/${encodeBucket(bucket)}`;
