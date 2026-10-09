/**
 * Wire types for the dashboard's HTTP surface.
 *
 * Every type here is transcribed from a real response body in
 * `apps/api/src/presentation/http/controllers/`, not guessed. Where a column
 * is nullable in the Drizzle schema the type says `| null` — see the note on
 * `etag`.
 *
 * NOTHING here comes from oRPC. The decision, and its four justifications,
 * are in `./client.ts`.
 */

/** `GET /api/v1/auth/me` success body (200). `handleMe` returns both fields always. */
export interface MeResponse {
  username: string;
  /** ISO-8601, or `null` for a bearer session, which never expires server-side. */
  expiresAt: string | null;
}

/** `POST /api/v1/auth/login` success body (200). */
export interface LoginResponse {
  username: string;
}

/** `POST /api/v1/auth/logout` success body (200). Also the shape every DELETE returns. */
export interface SuccessResponse {
  success: true;
}

/** One row of `GET /api/v1/buckets` -> `buckets[]`. `handleListBucketsV1`. */
export interface BucketSummary {
  id: string;
  name: string;
  /** ISO-8601. */
  createdAt: string;
  objectCount: number;
}

/** `GET /api/v1/buckets` success body. */
export interface ListBucketsResponse {
  buckets: BucketSummary[];
}

/** `POST /api/v1/buckets` success body (201). `handleCreateBucketV1` returns no timestamp. */
export interface CreateBucketResponse {
  id: string;
  name: string;
}

/**
 * One row of `GET /api/v1/buckets/{b}/objects` -> `objects[]`.
 *
 * `handleListObjectsV1` maps these off a Drizzle row:
 * `key` <- `s3Key`, `etag` <- `fileHash`, `sizeBytes` <- `Number(sizeBytes)`.
 *
 * `etag` is `string | null` because `files.file_hash` is a nullable column
 * (`schema.ts:60`) and the handler does not coalesce it. `key` is typed
 * non-null because `listByPrefix` filters on it, but a row that somehow lost
 * `s3_key` would serialise as `null` — the client never dereferences it as a
 * string without the guard in `./endpoints.ts`.
 */
export interface ObjectSummary {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileType: string;
  etag: string | null;
  /** ISO-8601. */
  lastModified: string;
  /** Absolute public share link, `${BASE_URL}/f/{publicId}`. */
  downloadUrl: string;
}

/**
 * `GET /api/v1/buckets/{b}/objects` success body.
 *
 * `isTruncated` and `nextContinuationToken` are typed truthfully and are
 * **not** to be used to build a paginator. `file-repository.ts:155` queries
 * `LIMIT maxKeys + 1` and then folds the extra row into `prefixes`, so
 * `objects.length` can never exceed `maxKeys`, `isTruncated` is always
 * `false`, and `nextContinuationToken` is always `null`. `home.html` hardcoded
 * `max-keys=200` and truncated silently; the port truncates silently and says
 * so in the UI rather than offering a control that cannot work.
 */
export interface ListObjectsResponse {
  objects: ObjectSummary[];
  /** Common-prefix "directories", each already suffixed with `/`. */
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
}

/** Query parameters accepted by `GET /api/v1/buckets/{b}/objects`. */
export interface ListObjectsQuery {
  prefix?: string;
  /** Defaults to `/` server-side. */
  delimiter?: string;
  /** Defaults to `1000` server-side. `home.html` used 200. */
  maxKeys?: number;
  /**
   * Honoured by `handleListObjectsV1` but UNREACHABLE through the typed oRPC
   * input schema, and effectively dead because of the `maxKeys + 1` fold above.
   * Exposed for completeness; nothing in the SPA sends it.
   */
  continuationToken?: string;
}

/** `POST /api/v1/buckets/{b}/upload` success body (201). `handleUploadObjectV1`. */
export interface UploadObjectResponse {
  key: string;
  size: number;
  etag: string;
  downloadUrl: string;
}

/** Request body of `POST /api/v1/buckets/{b}/copy`. `handleCopyObjectV1`. */
export interface CopyObjectRequest {
  sourceKey: string;
  destKey: string;
  /** Defaults to the source bucket server-side. */
  destBucket?: string;
}

/** `POST /api/v1/buckets/{b}/copy` success body. */
export interface CopyObjectResponse {
  sourceKey: string;
  destKey: string;
  destBucket: string;
}

/** Request body of `POST /api/v1/auth/login`. Matches `LoginBodySchema`. */
export interface LoginRequest {
  token: string;
}
