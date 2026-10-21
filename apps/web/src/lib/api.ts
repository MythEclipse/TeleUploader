/**
 * A typed wrapper over the oRPC client.
 *
 * ## Why this exists
 *
 * The oRPC contract in `apps/api/src/presentation/orpc/routers/` declares INPUT
 * schemas but no output schemas, so every procedure's return type is `unknown`. That
 * is correct for the server — a controller returns a `Response` whose body it never
 * re-declares — and it means the client must state what it expects.
 *
 * `lib/types.ts` already carries those shapes, hand-written from the controllers'
 * actual responses and asserted by `apps/api/test/web-api.test.ts`. This module is
 * the single place they are attached to the client, so:
 *
 *   - a call site writes `api.listBuckets()` and gets `ListBucketsResponse`, not
 *     `unknown`;
 *   - if a controller's body changes, `types.ts` is the one file to update, and every
 *     call site that depended on the old shape fails to compile;
 *   - there is exactly ONE cast per procedure, here, instead of an `as` at each use.
 *
 * ## Why casts at all, and why they are safe
 *
 * `ProcedureUtils.call` is `(input) => Promise<unknown>` for an output-schema-less
 * procedure. There is no way to narrow that without a schema, so the assertion is
 * unavoidable — but it is contained and reviewable: the shape it asserts is the one
 * the API's own tests pin. Nothing here is `any`; each is a named interface.
 *
 * ## Upload and download are absent, deliberately
 *
 * They cannot cross oRPC (JSON input, JSON output) and live in `./client.ts`.
 */

import { orpc } from './rpc';
import type {
  BucketUsageResponse,
  CreateBucketResponse,
  CreateCredentialResponse,
  CredentialSummary,
  ListBucketsResponse,
  ListCredentialsResponse,
  ListObjectsResponse,
  ListOrganizationsResponse,
  MoveObjectResponse,
  ObjectSearchHit,
  SearchObjectsResponse,
  StorageEndpointResponse,
  StorageUsageResponse,
  SuccessResponse,
} from './types';

/** The dashboard's data operations, each with its response shape attached. */
export const api = {
  /** The caller's organization memberships. */
  listOrganizations: (): Promise<ListOrganizationsResponse> =>
    orpc.organization.list.call() as Promise<ListOrganizationsResponse>,

  /** Every bucket in the active tenant. */
  listBuckets: (): Promise<ListBucketsResponse> =>
    orpc.bucket.listBuckets.call() as Promise<ListBucketsResponse>,

  /** Creates a bucket. `name` is validated by the contract's Zod schema first. */
  createBucket: (name: string): Promise<CreateBucketResponse> =>
    orpc.bucket.createBucket.call({ name }) as Promise<CreateBucketResponse>,

  /**
   * Deletes a bucket.
   *
   * The server refuses a non-empty bucket with 409 before deleting, so this response
   * is honest — unlike {@link api.deleteObject}.
   */
  deleteBucket: (bucket: string): Promise<SuccessResponse> =>
    orpc.bucket.deleteBucket.call({ bucket }) as Promise<SuccessResponse>,

  /**
   * One level of a bucket's listing.
   *
   * `delimiter: '/'` is explicit because the server defaults it with `|| '/'` — an
   * empty string cannot mean "no delimiter", so every listing rolls folders into
   * `prefixes` and drilling down means changing `prefix`.
   */
  listObjects: (params: {
    bucket: string;
    prefix?: string;
    delimiter?: string;
    maxKeys?: number;
  }): Promise<ListObjectsResponse> =>
    orpc.bucket.listObjects.call({
      bucket: params.bucket,
      prefix: params.prefix,
      delimiter: params.delimiter ?? '/',
      maxKeys: params.maxKeys,
    }) as Promise<ListObjectsResponse>,

  /**
   * Soft-deletes one object.
   *
   * ## This response cannot be trusted
   *
   * `handleDeleteObjectV1` returns `{"success":true}` unconditionally and discards
   * `softDelete()`'s boolean, so a key that never existed reports success identically
   * to a real delete. A caller that needs to know must re-list the prefix — see
   * `file-browser.tsx`, which does exactly that.
   */
  deleteObject: (params: { bucket: string; key: string }): Promise<SuccessResponse> =>
    orpc.bucket.deleteObject.call(params) as Promise<SuccessResponse>,

  /** Renames an object or every object under a folder prefix. */
  moveObject: (params: {
    bucket: string;
    fromKey: string;
    toKey: string;
  }): Promise<MoveObjectResponse> => orpc.bucket.move.call(params) as Promise<MoveObjectResponse>,

  /** One bucket's object count and byte total. */
  bucketUsage: (bucket: string): Promise<BucketUsageResponse> =>
    orpc.bucket.usage.call({ bucket }) as Promise<BucketUsageResponse>,

  /** Organization-wide totals, per bucket. */
  storageUsage: (): Promise<StorageUsageResponse> =>
    orpc.storage.usage.call() as Promise<StorageUsageResponse>,

  /** The S3 endpoint a user pastes into a client. */
  storageEndpoint: (): Promise<StorageEndpointResponse> =>
    orpc.storage.endpoint.call() as Promise<StorageEndpointResponse>,

  /** Search across the tenant's object keys. */
  search: (term: string): Promise<SearchObjectsResponse> =>
    orpc.storage.search.call({ q: term }) as Promise<SearchObjectsResponse>,

  /** The tenant's S3 key pairs. Summaries only — never a secret. */
  listCredentials: (): Promise<ListCredentialsResponse> =>
    orpc.credentials.list.call() as Promise<ListCredentialsResponse>,

  /**
   * Issues an S3 key pair.
   *
   * The response carries `secretKey` EXACTLY ONCE. No later read can reproduce it,
   * because the listing path never selects that column.
   */
  createCredential: (label?: string): Promise<CreateCredentialResponse> =>
    orpc.credentials.create.call({ label }) as Promise<CreateCredentialResponse>,

  /** Revokes one key pair. */
  deleteCredential: (id: string): Promise<SuccessResponse> =>
    orpc.credentials.remove.call({ id }) as Promise<SuccessResponse>,
};

/** Re-exported so a caller needs one import for the data surface and its types. */
export type {
  BucketUsageResponse,
  CreateBucketResponse,
  CreateCredentialResponse,
  CredentialSummary,
  ListBucketsResponse,
  ListCredentialsResponse,
  ListObjectsResponse,
  ListOrganizationsResponse,
  MoveObjectResponse,
  ObjectSearchHit,
  SearchObjectsResponse,
  StorageEndpointResponse,
  StorageUsageResponse,
};
