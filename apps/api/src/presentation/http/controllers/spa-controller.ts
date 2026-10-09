import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { config } from '../../../env';
import logger from '../../../infrastructure/observability/logger';

/**
 * Static SPA serving (P4).
 *
 * Replaces `home.html` + `home-controller.ts`. The old controller located a
 * single file by walking up from the module directory, which is why it 500'd in
 * production (deploy.sh never shipped it). The SPA is a DIRECTORY, so the
 * failure mode is inverted: a missing directory is detected and reported, and
 * the request falls through to the existing 404 rather than throwing.
 *
 * Two invariants make this safe to bolt onto the live app:
 *
 * 1. `WEB_DIST_PATH` is OPTIONAL. When it is unset this module returns `null`
 *    from every resolver and every handler falls through to today's behaviour.
 *    A backend-only deploy must not be broken by a dashboard that was never built.
 * 2. Resolution is LAZY and never throws. `env.ts` throws at import time, and
 *    `src/index.ts` imports it transitively before `serve()`. A missing SPA must
 *    not stop the service booting.
 */

/**
 * Extension to Content-Type. Deliberately a fixed map rather than the `mime`
 * package: 11 entries is smaller than the dependency, and a dependency that
 * changes its table between versions is a way for a client's `Content-Type`
 * parse to change without a commit.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Unknown extensions are served as octet-stream, never as guessable text. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;

/**
 * Boot-time state: whether the configured SPA directory exists, and whether we
 * already warned about it. The warning is emitted ONCE — a per-request warn
 * would flood the log on exactly the traffic pattern that matters (an asset
 * sweep from a stale HTML file).
 */
let spaChecked = false;
let spaUsable = false;

const resolveDistDir = (): string | null => {
  const configured = config.webDistPath;
  if (!configured) return null;
  return resolve(configured);
};

/**
 * Resolve the SPA root, or `null` when there is no usable SPA.
 *
 * Cached after the first call. A `null` here means "behave exactly as this
 * service behaved before P4" — it is NOT an error state.
 */
export const resolveSpaRoot = (): string | null => {
  if (spaChecked) return spaUsable ? resolveDistDir() : null;

  spaChecked = true;
  const root = resolveDistDir();
  if (!root) {
    // Unset is the normal backend-only case. Not a warning.
    spaUsable = false;
    return null;
  }

  if (!existsSync(resolve(root, 'index.html'))) {
    logger.warn(
      `WEB_DIST_PATH is set to "${root}" but no index.html is there — serving the API without the dashboard`,
    );
    spaUsable = false;
    return null;
  }

  spaUsable = true;
  return root;
};

/** Test seam: forget the cached boot probe so a new WEB_DIST_PATH takes effect. */
export const resetSpaCache = (): void => {
  spaChecked = false;
  spaUsable = false;
};

/**
 * Resolve a request path to a file inside `root`, refusing anything that
 * escapes it.
 *
 * Path traversal is a live requirement, not a hypothetical: an unguarded
 * `join(root, reqPath)` serves `GET /assets/../../src/env.ts`, and `env.ts`
 * holds `S3_SECRET_KEY`. `resolve` collapses `..` and the prefix assertion then
 * catches whatever survived.
 *
 * @param root - Absolute SPA directory.
 * @param reqPath - URL pathname, with or without a leading slash.
 * @returns The absolute file path, or `null` if it escapes `root`.
 */
export const resolveWithinRoot = (root: string, reqPath: string): string | null => {
  // A NUL byte truncates the path at the syscall layer on some platforms.
  if (reqPath.includes('\0')) return null;
  const decoded = safeDecode(reqPath);
  if (decoded === null) return null;
  const normalizedRoot = resolve(root);
  const resolved = resolve(normalizedRoot, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) return null;
  return resolved;
};

/** Percent-decode, refusing malformed sequences rather than throwing. */
const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** True when `path` names an existing regular file. */
const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * Serve one file from the SPA directory.
 *
 * @param reqPath - URL pathname to serve, e.g. `/assets/index-abc.js`.
 * @returns A Response, or `null` when there is no SPA or no such file. `null`
 *   means "not handled" — the caller falls through to its own 404.
 */
export const serveSpaFile = async (reqPath: string): Promise<Response | null> => {
  const root = resolveSpaRoot();
  if (!root) return null;

  const filePath = resolveWithinRoot(root, reqPath);
  if (!filePath || !filePath.startsWith(root + sep)) return null;
  if (!(await isFile(filePath))) return null;

  const body = await readFile(filePath);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': contentTypeFor(filePath),
      // Vite emits content-hashed filenames under /assets, so they are safe to
      // cache hard; index.html must never be, or a deploy is invisible to
      // anyone who visited before it.
      'cache-control': filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
};

/**
 * Serve the SPA shell for a client-side route (a deep link like `/acme/logs`).
 *
 * @returns The index.html Response, or `null` when there is no SPA.
 */
export const serveSpaIndex = async (): Promise<Response | null> => {
  const root = resolveSpaRoot();
  if (!root) return null;
  return serveSpaFile('/index.html');
};
