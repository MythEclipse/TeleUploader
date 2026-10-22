/**
 * Wire types for the dashboard's HTTP surface.
 *
 * Every type here is transcribed from a real response in
 * `apps/api/src/presentation/http/controllers/`, not guessed. Where a column is
 * nullable in the Drizzle schema the type says `| null`.
 *
 * ## Why these are hand-written rather than imported from `@teleuploader/api`
 *
 * Kana's rule is that the web app imports TYPES ONLY from the API package, and a
 * shared type is the ideal. The blocker is that the API package exports no types
 * at all: `apps/api/package.json` has no `exports` map, so `@teleuploader/api` is
 * not resolvable from the web package, and the oRPC `AppRouter` type lives behind
 * a server entry point that pulls Hono and Drizzle along with it.
 *
 * Declaring them here keeps `verbatimModuleSyntax` honest and the bundle free of
 * server code. The oRPC procedures added for this surface return the same shapes,
 * so when the API package grows an `exports` map these can be replaced by a
 * re-export without touching a call site.
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
   * `disabled` means the deployment has no authentication configured at all.
   */
  readonly method: 'cookie' | 'bearer' | 'disabled';
  /** Organizations the caller may switch to, ordered by name. */
  readonly organizations: OrganizationMembership[];
  /** Whether the server has Google sign-in configured. */
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
 * `prefixes`, so a paginator built on these fields would never advance.
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

/** `GET /api/v1/buckets/{bucket}/usage` success body. `handleBucketUsageV1`. */
export interface BucketUsageResponse {
  name: string;
  /** Sum of `size_bytes` over live objects. */
  bytes: number;
  objects: number;
}

/** One entry of `GET /api/v1/storage` -> `buckets[]`. `handleStorageUsageV1`. */
export interface StorageBucketUsage {
  id: string;
  name: string;
  bytes: number;
  objects: number;
}

/**
 * `GET /api/v1/storage` success body.
 *
 * Reports the tenant total AND every bucket in one round trip, so the header and
 * the per-bucket rows cannot disagree while both are loading.
 */
export interface StorageUsageResponse {
  organization: { bytes: number; objects: number };
  buckets: StorageBucketUsage[];
}

/** `GET /api/v1/storage/endpoint` success body. */
export interface StorageEndpointResponse {
  /** The absolute S3 endpoint a client should be pointed at. */
  endpoint: string;
  region: string;
  /** Whether the S3 surface is usable at all on this deployment. */
  s3Enabled: boolean;
}

/** One entry of `GET /api/v1/search` -> `results[]`. `handleSearchObjectsV1`. */
export interface ObjectSearchHit {
  /** The bucket the object lives in. */
  bucket: string;
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  etag: string | null;
  /** ISO-8601. */
  lastModified: string;
  downloadUrl: string;
}

/** `GET /api/v1/search` success body. */
export interface SearchObjectsResponse {
  query: string;
  results: ObjectSearchHit[];
  /** True when the result list hit the server's cap. */
  truncated: boolean;
  limit: number;
}

/**
 * One entry of `GET /api/v1/credentials` -> `credentials[]`.
 *
 * NEVER carries a secret. `SUMMARY_COLUMNS` in the repository omits `secret_key`
 * entirely, so no listing endpoint can leak one.
 */
export interface CredentialSummary {
  id: string;
  organizationId: string;
  accessKey: string;
  /** Human label, or `null` when it was seeded from the environment. */
  label: string | null;
  /** ISO-8601, or `null` for a key that has never signed a request. */
  lastUsedAt: string | null;
  createdAt: string | null;
}

/** `GET /api/v1/credentials` success body. */
export interface ListCredentialsResponse {
  credentials: CredentialSummary[];
}

/**
 * `POST /api/v1/credentials` success body (201).
 *
 * `secretKey` appears in THIS response and no other — the column stores what the
 * client signs with, and no listing query selects it. The UI must show it once
 * and say so.
 */
export interface CreateCredentialResponse {
  credential: CredentialSummary;
  secretKey: string;
  endpoint: string;
  region: string;
}

/** `POST /api/v1/buckets/{bucket}/move` success body. `handleMoveObjectV1`. */
export interface MoveObjectResponse {
  /** How many objects moved — `1` for a rename, N for a folder. */
  moved: number;
  fromKey: string;
  toKey: string;
  kind: 'object' | 'folder' | 'none';
}

/** One public file entry from `GET /api/v1/files/public`. */
export interface PublicFileItem {
  public_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_type: string;
  created_at: string;
  download_url: string;
}

/** `GET /api/v1/files/public` success body. */
export interface ListPublicFilesResponse {
  files: PublicFileItem[];
  next_cursor: string | null;
}
