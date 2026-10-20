/**
 * Wire types for the dashboard's HTTP surface.
 *
 * Every type here is transcribed from a real response body in
 * `apps/api/src/presentation/http/controllers/`, not guessed. Where a column is
 * nullable in the Drizzle schema the type says `| null`.
 *
 * ## What changed with multi-user auth
 *
 * `MeResponse` used to be `{ username, expiresAt }` — the session carried a
 * hardcoded `"admin"` username and nothing else, because there was no user row.
 * It now carries a real identity, the organizations the caller may switch between,
 * and whether Google sign-in is available on this deployment.
 *
 * `LoginRequest` is GONE: there is no token form to POST. Sign-in is a browser
 * navigation to `/api/v1/auth/google/start`.
 */

/** One organization the caller belongs to, as `GET /api/v1/auth/me` reports it. */
export interface OrganizationMembership {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: OrgRole;
}

/** The three roles a membership can carry. Mirrors `members.role`. */
export type OrgRole = 'owner' | 'admin' | 'member';

/**
 * `GET /api/v1/auth/me` success body (200).
 *
 * A 401 means "not signed in", which is a normal state, not an error.
 */
export interface MeResponse {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  /** ISO-8601, or `null` for a bearer token / open deployment, which never expires. */
  readonly expiresAt: string | null;
  /**
   * How the caller authenticated.
   *
   * `disabled` means the deployment has no authentication configured at all — the
   * documented open mode, where writes ARE accepted. It is not a fourth flavour of
   * "not signed in": the server reports it with a 200 precisely so the client does
   * not mislabel an open deployment as read-only.
   */
  readonly method: 'cookie' | 'bearer' | 'disabled';
  /** Organizations the caller may switch to, ordered by name. */
  readonly organizations: OrganizationMembership[];
  /**
   * Whether the server has Google sign-in configured.
   *
   * Read from the response rather than guessed from the hostname: a deployment
   * without Google credentials answers 503 on the OAuth start route, and a login
   * button that leads to a 503 is worse than one that explains why it is disabled.
   */
  readonly googleEnabled: boolean;
}

/** `GET /api/v1/organizations` success body. */
export interface ListOrganizationsResponse {
  readonly organizations: OrganizationMembership[];
}

/** `POST /api/v1/auth/logout` success body (200). Also the shape every DELETE returns. */
export interface SuccessResponse {
  readonly success: true;
}

/** `POST /api/v1/auth/logout-all` success body. */
export interface LogoutAllResponse {
  readonly success: true;
  /** Number of sessions revoked. */
  readonly revoked: number;
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
 * `etag` is `string | null` because `files.file_hash` is a nullable column and the
 * handler does not coalesce it.
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
 * `isTruncated` is always `false` and `nextContinuationToken` always `null` today:
 * `file-repository.ts` queries `LIMIT maxKeys + 1` and folds the extra row into
 * `prefixes`, so a paginator built on these fields would never advance. The UI says
 * so rather than offering a control that cannot work.
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
  /** Defaults to `1000` server-side. */
  maxKeys?: number;
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
