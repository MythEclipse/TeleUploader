/**
 * Typed wrappers for every endpoint the dashboard inventory needs.
 *
 * Each function is a 1:1 transcription of one branch of
 * `handleWebApiV1` (`web-api-controller.ts:424-484`), so the routing table here
 * and the dispatch table there can be compared line by line.
 *
 * **No `any` anywhere.** Input and output types come from `./types`; the only
 * assertion is `as T` on a parsed JSON body, which is unavoidable at an HTTP
 * boundary and is narrowed by the caller picking the right wrapper.
 *
 * ## The delete endpoint used to lie — fixed in TODO item 10
 *
 * `handleDeleteObjectV1` returned `{success:true}` **unconditionally** and
 * discarded `softDelete()`'s boolean: a key that matched no row, or a
 * mis-encoded key, still reported success. `assertDeleted` was written as the
 * workaround — the caller re-listed the prefix and checked the key was gone.
 *
 * That defect is FIXED: the handler now answers 404 when the delete changed no
 * row, so the status carries the information. `assertDeleted` survives as an
 * independent cross-check rather than as the only trustworthy confirmation.
 *
 * The second half of that defect — the DELETE catch-all shadowing the reserved
 * `download` / `objects` / `upload` / `copy` segments, so a request meant to
 * DOWNLOAD a file deleted it — was fixed in the same change, in the router's
 * dispatch order. Both branches are pinned by
 * `apps/api/test/web-api-delete-reserved-segments.test.ts`.
 */

import { ApiError, http } from './client';
import {
  bucketUrl,
  copyUrl,
  downloadUrl,
  objectUrl,
  objectsUrl,
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
  LoginResponse,
  SuccessResponse,
  UploadObjectResponse,
} from './types';

// ─────── Buckets ───────

/**
 * `GET /api/v1/buckets` — **public**, no auth required (`app.ts:149`).
 *
 * Leaks every bucket name plus its object count to an unauthenticated caller
 * (contract gotcha 9). The SPA inherits that; it is flagged, not fixed.
 */
export const listBuckets = (): Promise<BucketSummary[]> =>
  http.getJson<ListBucketsResponse>('/api/v1/buckets').then((d) => d.buckets);

/** `POST /api/v1/buckets` — admin. `201` on success, `409` if the name is taken. */
export const createBucket = (name: string): Promise<CreateBucketResponse> =>
  http.postJson<CreateBucketResponse, { name: string }>('/api/v1/buckets', { name });

/**
 * `DELETE /api/v1/buckets/{bucket}` — admin.
 *
 * Unlike the object delete this one IS honest: `handleDeleteBucketV1` checks
 * existence (`404`) and emptiness (`409`) and `bucketRepository.delete` only
 * runs after both pass, so `{success:true}` here does mean the bucket is gone.
 */
export const deleteBucket = (bucket: string): Promise<SuccessResponse> =>
  http.deleteJson<SuccessResponse>(bucketUrl(bucket));

// ─────── Objects ───────

/**
 * `GET /api/v1/buckets/{bucket}/objects` — **public**.
 *
 * `maxKeys` defaults to 200 here, matching `home.html`'s hardcoded
 * `max-keys=200`. The response's `isTruncated` is always `false` and
 * `nextContinuationToken` always `null` — see the note on
 * {@link ListObjectsResponse} — so this silently truncates rather than paging.
 */
export const listObjects = (
  bucket: string,
  query: ListObjectsQuery = {},
): Promise<ListObjectsResponse> =>
  http.getJson<ListObjectsResponse>(
    objectsUrl(bucket, { delimiter: '/', maxKeys: 200, ...query }),
  );

/**
 * `POST /api/v1/buckets/{bucket}/copy` — admin.
 *
 * `501` for a chunked source (`handleCopyObjectV1` does not implement it), so
 * callers should surface that distinctly rather than as a generic failure.
 */
export const copyObject = (
  bucket: string,
  body: CopyObjectRequest,
): Promise<CopyObjectResponse> =>
  http.postJson<CopyObjectResponse, CopyObjectRequest>(copyUrl(bucket), body);

/**
 * `DELETE /api/v1/buckets/{bucket}/{key}` — admin.
 *
 * Key is encoded per segment (`./keys.ts`).
 *
 * The response is now TRUSTWORTHY: the handler reports 404 when the delete
 * changed no row, so a 200 means a row really was soft-deleted (TODO item 10).
 * `assertDeleted` remains available as an independent cross-check, but a caller
 * no longer depends on it to know whether anything happened.
 */
export const deleteObject = (bucket: string, key: string): Promise<SuccessResponse> =>
  http.deleteJson<SuccessResponse>(objectUrl(bucket, key));

/**
 * Re-lists `prefix` and returns whether `key` is genuinely gone.
 *
 * An INDEPENDENT cross-check, not a workaround: since TODO item 10 the delete
 * response itself reports 404 when nothing was deleted, so this is no longer the
 * only trustworthy confirmation. It is still useful where a caller cares about a
 * key vanishing from a specific window rather than about the delete call's
 * status.
 *
 * It deliberately re-uses the caller's `prefix`/`maxKeys` so the check is made
 * against the exact window the user is looking at; a key that fell outside the
 * truncated window reads as "deleted" either way, which is why the UI pairs this
 * with the "results are truncated" notice rather than presenting it as proof.
 */
export const assertDeleted = async (
  bucket: string,
  key: string,
  query: Omit<ListObjectsQuery, 'prefix'> = {},
): Promise<boolean> => {
  const prefix = key.includes('/') ? `${key.slice(0, key.lastIndexOf('/') + 1)}` : '';
  const after = await listObjects(bucket, { ...query, prefix });
  return !after.objects.some((o) => o.key === key);
};

/**
 * Absolute URL of the download proxy. Not fetched — handed to `window.open` or
 * the clipboard, so the browser follows it with the cookie jar (and the CORS
 * headers `handleDownloadObjectV1` emits).
 *
 * Must be built with `encodeKey`, never `encodeURIComponent(key)`: the whole-key
 * form returns `404 {"error":"Object not found"}` for any nested key.
 */
export const objectDownloadUrl = (bucket: string, key: string): string =>
  http.absolute(downloadUrl(bucket, key));

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
 * `POST /api/v1/buckets/{bucket}/upload` — admin. Multipart `file` + `key`.
 *
 * ## Raw `XMLHttpRequest`, not `fetch`
 *
 * `fetch` has no upload progress event. `home.html:343` used
 * `xhr.upload.onprogress` and the contract mandates keeping that (§1.6).
 *
 * ## What the progress bar actually measures
 *
 * `xhr.upload.onprogress` reports **bytes handed to the server**, not bytes
 * stored. `handleUploadObjectV1` buffers the *entire* body to `/tmp` via
 * `streamToTemp` before its first Telegram call (`web-api-controller.ts:202`),
 * so the bar reaches 100% and then sits there for the whole upload-to-Telegram
 * phase. That gap exists today and is not fixable from the client: no server
 * progress channel exists. The callback therefore reports `total: null` and a
 * phase label once `upload.onprogress` completes, so the UI can say
 * "transferring…" instead of sitting at a misleading 100%.
 *
 * There is also no size cap on this route (`web-api-controller.ts:201` calls
 * `streamToTemp` without `maxSizeBytes`, unlike public `/api/upload`), so the
 * SPA does not pre-validate size — a client-side limit would be a fiction the
 * server does not enforce.
 *
 * @param key Object key. **Unvalidated server-side** (`formData.get('key')` is
 *   taken verbatim at `web-api-controller.ts:201`), so it is never rendered as
 *   anything but a React text child.
 */
export const uploadObject = (
  bucket: string,
  file: File,
  key: string,
  onProgress?: UploadProgress,
): Promise<UploadObjectResponse> =>
  new Promise<UploadObjectResponse>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('key', key);

    const xhr = new XMLHttpRequest();
    // The session cookie is HttpOnly, so XHR must be told to send the jar.
    // `same-origin` (not `include`): the SPA is served from the API's own
    // origin and there is no cross-origin credential exchange.
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
      // Reuse the API's `{error}` envelope rather than `statusText`, which is
      // empty for XHR.
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

    xhr.open('POST', uploadUrl(bucket));
    xhr.send(form);
  });

// ─────── Auth endpoints ───────

/**
 * `POST /api/v1/auth/login` — **rate limited** (`app.ts:126`).
 *
 * Thin re-export; prefer `login()` from `./auth`, which wraps this and then
 * re-probes `/auth/me` to catch the `Secure`-over-http cookie drop.
 */
export const postLogin = (token: string): Promise<LoginResponse> =>
  http.postJson<LoginResponse, { token: string }>('/api/v1/auth/login', { token });
