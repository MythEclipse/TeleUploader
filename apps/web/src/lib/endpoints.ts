/**
 * Typed wrappers for every endpoint the dashboard needs.
 *
 * Each function is a 1:1 transcription of one branch of `handleWebApiV1`
 * (`web-api-controller.ts`), so the routing table here and the dispatch table there
 * can be compared line by line.
 *
 * **No `any` anywhere.** Input and output types come from `./types`; the only
 * assertion is `as T` on a parsed JSON body, which is unavoidable at an HTTP
 * boundary and is narrowed by the caller picking the right wrapper.
 *
 * ## Organization scoping is a parameter on every call
 *
 * Multi-user means every bucket operation happens inside ONE organization, and the
 * server needs to know which. Each wrapper therefore takes an optional `org` slug
 * that becomes `?org=<slug>` (see `./keys.ts`).
 *
 * It is optional because the server has a sane default: no slug means "the caller's
 * own organization". That keeps scripts and the first page load working without the
 * client having resolved a slug yet. A slug the caller is NOT a member of is a 403 —
 * never a silent fallback — so passing the wrong one fails visibly instead of
 * quietly reading another tenant.
 */

import { ApiError, http } from './client';
import {
  bucketUrl,
  bucketsUrl,
  copyUrl,
  downloadUrl,
  objectUrl,
  objectsUrl,
  organizationsUrl,
  uploadUrl,
} from './keys';
import type {
  BucketSummary,
  CopyObjectRequest,
  CopyObjectResponse,
  CreateBucketResponse,
  ListBucketsResponse,
  ListObjectsQuery,
  ListObjectsResponse,
  ListOrganizationsResponse,
  SuccessResponse,
  UploadObjectResponse,
} from './types';

// ─────── Organizations ───────

/**
 * `GET /api/v1/organizations` — every organization the caller belongs to.
 *
 * Served from `members`, scoped to the authenticated user. There is no endpoint that
 * lists organizations globally, and its absence is deliberate: one would be a
 * cross-tenant directory.
 *
 * @returns The memberships, ordered by name.
 * @throws {ApiError} `401` when there is no session.
 */
export const listOrganizations = (): Promise<ListOrganizationsResponse> =>
  http.getJson<ListOrganizationsResponse>(organizationsUrl());

// ─────── Buckets ───────

/**
 * `GET /api/v1/buckets` — requires a session.
 *
 * This used to be public. The leak was worse than "names and counts": each object
 * listing entry carries a `downloadUrl` (`/f/<public_id>`) and those answer 200
 * unauthenticated, so a public listing meant anyone could read the content of every
 * object. A share link is meant to grant ONE object; the listing handed out one per
 * object and quietly subsumed that decision.
 *
 * `/f/:public_id` itself is deliberately STILL public, so links already handed out
 * keep working. Possession of a link is the credential.
 *
 * @param org - Organization slug to scope to.
 */
export const listBuckets = (org?: string): Promise<BucketSummary[]> =>
  http.getJson<ListBucketsResponse>(bucketsUrl(org)).then((d) => d.buckets);

/**
 * `POST /api/v1/buckets` — requires a session.
 *
 * `201` on success, `409` if the name is taken WITHIN this organization. Bucket names
 * are unique per organization, not globally, so two accounts can each own a bucket
 * called `photos`.
 *
 * @param name - The bucket name.
 * @param org - Organization slug to create it in.
 */
export const createBucket = (name: string, org?: string): Promise<CreateBucketResponse> =>
  http.postJson<CreateBucketResponse, { name: string }>(bucketsUrl(org), { name });

/**
 * `DELETE /api/v1/buckets/{bucket}` — requires a session.
 *
 * Unlike the object delete this one IS honest: `handleDeleteBucketV1` checks
 * existence (`404`) and emptiness (`409`) and `bucketRepository.delete` only runs
 * after both pass, so `{success:true}` here does mean the bucket is gone.
 *
 * @param bucket - The bucket name.
 * @param org - Organization slug it belongs to.
 */
export const deleteBucket = (bucket: string, org?: string): Promise<SuccessResponse> =>
  http.deleteJson<SuccessResponse>(bucketUrl(bucket, org));

// ─────── Objects ───────

/**
 * `GET /api/v1/buckets/{bucket}/objects` — requires a session.
 *
 * `maxKeys` defaults to 200, matching `home.html`'s hardcoded `max-keys=200`. The
 * response's `isTruncated` is always `false` and `nextContinuationToken` always
 * `null` — see {@link ListObjectsResponse} — so this silently truncates rather than
 * paging.
 *
 * One API quirk worth knowing when reading a listing: `delimiter` defaults to `/`
 * server-side via `|| '/'`, so an EMPTY `delimiter=` cannot express "no delimiter" —
 * the listing always rolls up one level into `prefixes`. Drill down via `prefix`.
 *
 * @param bucket - The bucket name.
 * @param query - Prefix / delimiter / page size.
 * @param org - Organization slug it belongs to.
 */
export const listObjects = (
  bucket: string,
  query: ListObjectsQuery = {},
  org?: string,
): Promise<ListObjectsResponse> =>
  http.getJson<ListObjectsResponse>(
    objectsUrl(bucket, { delimiter: '/', maxKeys: 200, ...query }, org),
  );

/**
 * `POST /api/v1/buckets/{bucket}/copy` — requires a session.
 *
 * `501` for a chunked source (`handleCopyObjectV1` does not implement it), so callers
 * should surface that distinctly rather than as a generic failure.
 *
 * @param bucket - Source bucket name.
 * @param body - Source key, destination key, optional destination bucket.
 * @param org - Organization slug.
 */
export const copyObject = (
  bucket: string,
  body: CopyObjectRequest,
  org?: string,
): Promise<CopyObjectResponse> =>
  http.postJson<CopyObjectResponse, CopyObjectRequest>(copyUrl(bucket, org), body);

/**
 * `DELETE /api/v1/buckets/{bucket}/{key}` — requires a session.
 *
 * Key is encoded per segment (`./keys.ts`). The response is trustworthy: the handler
 * reports 404 when the delete changed no row, so a 200 means a row really was
 * soft-deleted.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param org - Organization slug.
 */
export const deleteObject = (bucket: string, key: string, org?: string): Promise<SuccessResponse> =>
  http.deleteJson<SuccessResponse>(objectUrl(bucket, key, org));

/**
 * Re-lists `prefix` and returns whether `key` is genuinely gone.
 *
 * An INDEPENDENT cross-check, not a workaround: the delete response itself reports
 * 404 when nothing was deleted. It is still useful where a caller cares about a key
 * vanishing from a specific window rather than about the delete call's status.
 *
 * @param bucket - The bucket name.
 * @param key - The key that should be gone.
 * @param query - Page-size override.
 * @param org - Organization slug.
 */
export const assertDeleted = async (
  bucket: string,
  key: string,
  query: Omit<ListObjectsQuery, 'prefix'> = {},
  org?: string,
): Promise<boolean> => {
  const prefix = key.includes('/') ? `${key.slice(0, key.lastIndexOf('/') + 1)}` : '';
  const after = await listObjects(bucket, { ...query, prefix }, org);
  return !after.objects.some((o) => o.key === key);
};

/**
 * Absolute URL of the download proxy. Not fetched — handed to `window.open` or the
 * clipboard, so the browser follows it with the cookie jar.
 *
 * Must be built with `encodeKey`, never `encodeURIComponent(key)`: the whole-key form
 * returns `404 {"error":"Object not found"}` for any nested key.
 */
export const objectDownloadUrl = (bucket: string, key: string, org?: string): string =>
  http.absolute(downloadUrl(bucket, key, org));

/**
 * Absolute URL of the public share link already returned by the API as
 * `ObjectSummary.downloadUrl` (`${BASE_URL}/f/{publicId}`, unauthenticated).
 */
export const shareUrl = (publicDownloadUrl: string): string =>
  new URL(publicDownloadUrl, window.location.origin).toString();

// ─────── Upload ───────

/** Progress callback for {@link uploadObject}, in bytes and (if known) total. */
export type UploadProgress = (loaded: number, total: number | null) => void;

/**
 * `POST /api/v1/buckets/{bucket}/upload` — requires a session. Multipart `file` + `key`.
 *
 * ## Raw `XMLHttpRequest`, not `fetch`
 *
 * `fetch` has no upload progress event. `xhr.upload.onprogress` is the only way to
 * report bytes sent.
 *
 * ## What the progress bar actually measures
 *
 * `xhr.upload.onprogress` reports **bytes handed to the server**, not bytes stored.
 * `handleUploadObjectV1` buffers the *entire* body to `/tmp` via `streamToTemp` before
 * its first Telegram call, so the bar reaches 100% and then sits there for the whole
 * upload-to-Telegram phase. No server progress channel exists, so the callback
 * reports `total: null` once the transfer completes and the UI switches to a phase
 * label rather than sitting at a misleading 100%.
 *
 * @param bucket - The bucket name.
 * @param file - The file to upload.
 * @param key - Object key. Unvalidated server-side, so it is never rendered as
 *   anything but a React text child.
 * @param onProgress - Progress callback.
 * @param org - Organization slug.
 */
export const uploadObject = (
  bucket: string,
  file: File,
  key: string,
  onProgress?: UploadProgress,
  org?: string,
): Promise<UploadObjectResponse> =>
  new Promise<UploadObjectResponse>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('key', key);

    const xhr = new XMLHttpRequest();
    // The session cookie is HttpOnly, so XHR must be told to send the jar.
    // `withCredentials` is required for that on the XHR path specifically.
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (onProgress) onProgress(event.loaded, event.lengthComputable ? event.total : null);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadObjectResponse);
        } catch {
          reject(new ApiError(xhr.status, 'Upload returned a non-JSON body'));
        }
        return;
      }
      // Reuse the API's `{error}` envelope rather than `statusText`, which is empty
      // for XHR.
      let message = xhr.statusText || `HTTP ${xhr.status}`;
      try {
        const body: unknown = JSON.parse(xhr.responseText);
        if (typeof body === 'object' && body !== null && 'error' in body) {
          const { error } = body as { error?: unknown };
          if (typeof error === 'string' && error) message = error;
        }
      } catch {
        /* keep the statusText fallback */
      }
      reject(new ApiError(xhr.status, message));
    };

    xhr.onerror = () => reject(new ApiError(0, 'Upload failed — network error'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload aborted'));

    xhr.open('POST', uploadUrl(bucket, org));
    xhr.send(form);
  });
