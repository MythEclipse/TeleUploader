/**
 * The dashboard's HTTP transport for the paths oRPC cannot carry.
 *
 * ## What changed, and why `http` is still here
 *
 * This module used to justify hand-rolling every call because `@orpc/client` was
 * not installed. It IS installed now, and `./rpc.ts` is the typed client for the
 * JSON surface — that is where buckets, objects, usage, search and credentials
 * go, so the wire contract has one definition instead of two.
 *
 * `http` remains because three operations genuinely cannot cross an oRPC
 * boundary, and pretending otherwise would mean a broken feature rather than a
 * tidier file:
 *
 * 1. **Upload** is `multipart/form-data`. oRPC serialises procedure input as
 *    JSON, so a `File` cannot be an argument.
 * 2. **Download** returns bytes. The API's oRPC adapter calls `res.json()` on a
 *    controller response, which destroys a binary body — the same reason the
 *    server keeps download off `/rpc`.
 * 3. **Progress** needs `XMLHttpRequest`; `fetch` exposes no upload-progress
 *    event, and XHR cannot be expressed as an oRPC call at all.
 *
 * `send`/`sendJson` therefore exist as the general escape hatch, and
 * `uploadObject`/`downloadObject` are the two specific cases.
 *
 * ## Credentials mode
 *
 * `'same-origin'` is the spec default in current browsers, but it is set
 * explicitly because the whole auth story depends on the cookie jar being
 * attached, and `include` would be wrong — the SPA is served from the API's own
 * origin and there is no cross-origin credential exchange to permit.
 */

/** A non-2xx response from the API, carrying the server's own error message. */
export class ApiError extends Error {
  constructor(
    /** HTTP status. `401` on `/auth/me` is meaningful, not a failure. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Credentials mode for every call.
 *
 * `'same-origin'` is the spec default in current browsers, but it is set
 * explicitly because the whole auth story depends on the cookie jar being
 * attached, and `include` would be wrong — the SPA is served from the API's own
 * origin and there is no cross-origin credential exchange to permit.
 */
const CREDENTIALS: RequestCredentials = 'same-origin';

/** The JSON error envelope every `web-api-controller` handler emits. */
const readError = async (res: Response): Promise<string> => {
  const body: unknown = await res.json().catch(() => undefined);
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error?: unknown };
    if (typeof error === 'string' && error) return error;
  }
  return res.statusText || `HTTP ${res.status}`;
};

/**
 * Performs one request and returns the raw `Response`, throwing {@link ApiError}
 * on any non-2xx status.
 *
 * Deliberately does NOT throw on `401`/`404` from `/auth/me` — that endpoint's
 * status is the state probe, so callers that care use `probeAuth`, which reads
 * the status without going through here.
 */
const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(path, { ...init, credentials: CREDENTIALS });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return res;
};

/** `request` + `.json()`. The body is typed at the call site, never `any`. */
const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await request(path, init);
  return (await res.json()) as T;
};

const jsonHeaders = { 'content-type': 'application/json' } as const;

export const http = {
  /** `GET`, returning parsed JSON. */
  getJson: <T>(path: string): Promise<T> => requestJson<T>(path),

  /** `POST` with a JSON body, returning parsed JSON. */
  postJson: <TResponse, TBody>(path: string, body: TBody): Promise<TResponse> =>
    requestJson<TResponse>(path, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    }),

  /** `POST` with no body — logout. Returns the parsed JSON body. */
  postEmptyJson: <T>(path: string): Promise<T> => requestJson<T>(path, { method: 'POST' }),

  /** `DELETE`, returning parsed JSON. */
  deleteJson: <T>(path: string): Promise<T> => requestJson<T>(path, { method: 'DELETE' }),

  /**
   * The base URL for absolute links handed to the browser (`window.open`,
   * clipboard). Relative paths work for both, but a resolved absolute URL is
   * what a user pasting into `aws s3` or a `curl` needs.
   */
  absolute: (path: string): string => new URL(path, window.location.origin).toString(),
};

/** Outcome of one upload, as the server reports it. */
export interface UploadResult {
  key: string;
  size: number;
  etag: string;
  downloadUrl: string;
}

/** Progress callback for {@link uploadObject}. */
export type UploadProgress = (loaded: number, total: number) => void;

/**
 * Uploads one file to a bucket, reporting progress.
 *
 * ## Why `XMLHttpRequest` and not `fetch`
 *
 * `fetch` has no upload-progress event. For a large file over a slow link, a
 * spinner that cannot say "40% done" is the difference between waiting and giving
 * up. XHR's `upload.onprogress` is the only browser API that reports bytes sent.
 *
 * ## Why the promise resolves on `load`, not on `readystatechange`
 *
 * `load` fires after the response body is available; `readystatechange` fires
 * repeatedly and would need a guard for `readyState === 4`, which is the same
 * event with more ways to get it wrong.
 *
 * @param params - Bucket, file, destination key, scope, and progress callback.
 * @returns The server's upload result.
 * @throws {ApiError} With the server's status and message on a non-2xx response.
 */
export const uploadObject = (params: {
  bucket: string;
  file: File;
  /** Destination key. Defaults to the file's own name server-side. */
  key?: string;
  orgSlug?: string;
  onProgress?: UploadProgress;
}): Promise<UploadResult> =>
  new Promise((resolve, reject) => {
    const url = new URL(
      `/api/v1/buckets/${encodeURIComponent(params.bucket)}/upload`,
      window.location.origin,
    );
    if (params.orgSlug) url.searchParams.set('org', params.orgSlug);

    const form = new FormData();
    form.append('file', params.file);
    if (params.key) form.append('key', params.key);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url.toString());
    // Same-origin XHR already sends cookies, but it is set explicitly so the
    // auth contract is visible at the call site rather than implied by a default.
    xhr.withCredentials = true;

    if (params.onProgress) {
      xhr.upload.onprogress = (event) => {
        // `lengthComputable` is false when the browser cannot determine the size
        // (a streamed body). Reporting 0/0 would render as a divide-by-zero bar.
        if (event.lengthComputable) params.onProgress?.(event.loaded, event.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new ApiError(xhr.status, 'The upload succeeded but returned an unreadable body'));
        }
        return;
      }
      reject(new ApiError(xhr.status, parseErrorMessage(xhr)));
    };

    xhr.onerror = () =>
      reject(new ApiError(0, 'The upload failed — the connection was interrupted'));
    xhr.ontimeout = () => reject(new ApiError(0, 'The upload timed out'));
    xhr.onabort = () => reject(new ApiError(0, 'The upload was cancelled'));

    xhr.send(form);
  });

/**
 * Extracts the server's error message from a failed XHR.
 *
 * Falls back to the status text because a 413 from a proxy may not carry the
 * JSON envelope at all — reporting "HTTP 413" beats reporting nothing.
 *
 * @param xhr - The completed request.
 * @returns A human-readable message.
 */
const parseErrorMessage = (xhr: XMLHttpRequest): string => {
  try {
    const body: unknown = JSON.parse(xhr.responseText);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error?: unknown };
      if (typeof error === 'string' && error) return error;
    }
  } catch {
    // Not JSON — a proxy error page, most likely. The status text is the best
    // information available.
  }
  return xhr.statusText || `HTTP ${xhr.status}`;
};

/**
 * Triggers a browser download of one object through the API's proxy route.
 *
 * A NAVIGATION, not a `fetch`: the response is a file the browser should save,
 * and the route requires the session cookie (attached automatically on a
 * same-origin navigation). Reading the body into JS first would buffer an
 * arbitrarily large file in memory for no benefit.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param orgSlug - Organization scope, when the UI knows one.
 */
export const downloadObject = (bucket: string, key: string, orgSlug?: string): void => {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `/api/v1/buckets/${encodeURIComponent(bucket)}/download/${encoded}`,
    window.location.origin,
  );
  if (orgSlug) url.searchParams.set('org', orgSlug);
  window.location.assign(url.toString());
};
