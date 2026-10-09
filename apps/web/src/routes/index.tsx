/**
 * `/` — the file browser. This replaces `home.html`'s inline `<script>`, which was
 * 1:1 with the eleven controls that file enumerated (bucket select, new bucket,
 * credentials, search, breadcrumb, object list, dropzone, progress overlay, the
 * delete/download/copy-link row actions, and the auth gate over all of them).
 *
 * ## Everything below the fold is shared with the bucket route
 *
 * {@link FileBrowser} and everything it renders is **exported** and imported by
 * `routes/$orgSlug/bucketName.tsx`, which differs only in where the bucket name
 * comes from (the path instead of `?bucket=`). The contract asks for exactly that
 * sharing (§1.1: "Shares components with `index.tsx`; differs only in that the
 * bucket comes from the path").
 *
 * It lives here rather than in `src/components/` because this lane owns exactly
 * two files. The export is already the seam, so moving it out later is mechanical.
 *
 * **`FileBrowser` takes its listing as a prop and never calls
 * `Route.useLoaderData()`.** That is load-bearing: `useLoaderData` is bound to the
 * route that declares it, so a shared component that called it would read the
 * *index* route's data even while rendered inside the bucket route. Passing the
 * listing down is what makes the sharing correct rather than merely convenient.
 *
 * ## Bucket and prefix live in SEARCH PARAMS, and the filter box writes to them
 *
 * `home.html:289-293`:
 *
 * ```js
 * const searchVal = document.getElementById('searchInput').value;
 * const prefix = searchVal || currentPrefix;
 * ```
 *
 * read on every load, while `navigateTo` (home.html:288) set `currentPrefix` but
 * never cleared the box. So once the user typed a filter, every later navigation
 * was silently overridden by the stale input, the breadcrumb disagreed with the
 * rendered rows, and there was no way out but clearing the box by hand.
 *
 * Here there is exactly one source of truth: `?prefix=`. Typing debounces into a
 * navigation; clicking a folder or a breadcrumb segment navigates too; the input
 * is resynchronised from the URL whenever the URL changes to a *different*
 * prefix. The bug is not fixed, it is unrepresentable — there is no second copy
 * of the prefix for the two views to disagree about.
 *
 * ## Prefixes are normalised to end in `/`
 *
 * Every prefix this API produces is a directory prefix with a trailing slash
 * (`handleListObjectsV1` folds on `delimiter='/'` and emits
 * `prefix + relativeKey.slice(0, slashIndex + 1)`). Normalising in
 * {@link asPrefix} means `?prefix=a/b` and `?prefix=a/b/` are the same URL, so a
 * hand-typed or hand-pasted link cannot address a different view than the one the
 * breadcrumb describes. The box shows the normalised value, so what is displayed
 * is exactly what was sent.
 *
 * ## Security: object keys are untrusted server input
 *
 * `handleUploadObjectV1` takes `formData.get('key')` **verbatim**
 * (`web-api-controller.ts:201`) — no schema, no sanitisation. `home.html` then
 * interpolated that raw key into `onclick="downloadObject('${obj.key}')"`, and its
 * `escapeHtml` (textContent → innerHTML) does not escape quotes, so one
 * apostrophe in a key terminates the string literal and the next attribute becomes
 * live. That is a confirmed stored XSS.
 *
 * Every key, prefix and bucket name below is rendered as a React text child and
 * every handler is a React event prop. There is no `dangerouslySetInnerHTML` and
 * no handler built by string concatenation anywhere in this file.
 */

import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanWrite } from '../lib/auth-store';
import { ApiError } from '../lib/client';
import {
  assertDeleted,
  createBucket as createBucketRequest,
  deleteBucket,
  deleteObject,
  listBuckets,
  listObjects,
  objectDownloadUrl,
  shareUrl,
  uploadObject,
} from '../lib/endpoints';
import { displayKey, displayPrefix, formatDate, formatSize } from '../lib/format';
import { listOrgs } from '../lib/orgs';
import NotFound from '../lib/layout/NotFound';
import type { BucketSummary, ListObjectsResponse, ObjectSummary } from '../lib/types';

// ─────── Constants and shared types ───────

/**
 * Page size for `GET /api/v1/buckets/{b}/objects`.
 *
 * `home.html` hardcoded `max-keys=200` and truncated without saying so.
 * `MAX_KEYS` is used in three places that MUST agree: the listing request, the
 * truncation notice, and {@link assertDeleted}'s re-list. If they drift, a
 * deleted key that falls outside the re-list window reads as "deleted" when it
 * is not.
 */
export const MAX_KEYS = 200;

/** Query-parameter names are kebab-case on the wire; this is the URL-side view. */
export interface BrowserSearch {
  /** Bucket name. `''` means "no bucket selected". Ignored on the bucket route. */
  bucket: string;
  /** Directory prefix, always `''` or ending in `/`. */
  prefix: string;
}

/** What a route loader hands to the components. */
export interface BrowserData {
  buckets: BucketSummary[];
  /** The selected bucket's listing, or `null` when none is selected. */
  listing: ListObjectsResponse | null;
  /** The selected bucket does not exist (`404 Bucket not found`). */
  missingBucket: boolean;
  /** The read itself failed. Rendered in place, so the shell chrome survives. */
  error: { status: number; message: string } | null;
  /** Slug for `/$orgSlug/...` links, from `../lib/orgs` — not hardcoded here. */
  orgSlug: string;
}

/** A banner message. `error` is styled and announced as an alert. */
export interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * Normalises a raw search-param value into a directory prefix.
 *
 * Non-strings, and the empty string, become `''`. Anything else gains a trailing
 * `/` if it lacks one.
 */
export const asPrefix = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.endsWith('/') ? value : `${value}/`;
};

/** Normalises a raw search-param value into a bucket name (`''` when unset). */
const asBucketName = (value: unknown): string => (typeof value === 'string' ? value : '');

const emptyData = (orgSlug: string): BrowserData => ({
  buckets: [],
  listing: null,
  missingBucket: false,
  error: null,
  orgSlug,
});

/**
 * Human-readable text for an API failure.
 *
 * `503 {"error":"Tenant scope unavailable (missing_organization_membership)"}`
 * (web-api-controller.ts:414-422) is returned by **every** `/api/v1/*` branch when
 * the bootstrap admin has no org membership. It is a misconfigured deployment, not
 * an authorisation failure and not a generic server error, so it gets its own
 * sentence instead of the raw body.
 */
const describeApiError = (error: unknown): { status: number; message: string } => {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return {
        status: error.status,
        message:
          'This server has no tenant scope configured (missing_organization_membership), ' +
          'so it cannot serve any bucket. Ask an administrator to check the bootstrap ' +
          "admin's organization membership.",
      };
    }
    return { status: error.status, message: error.message };
  }
  if (error instanceof Error) return { status: 0, message: error.message || 'Request failed' };
  return { status: 0, message: 'Request failed' };
};

/**
 * The loader body shared by both routes.
 *
 * Errors are **returned, not thrown**, on purpose. A throw reaches `__root.tsx`'s
 * `errorComponent`, which replaces the whole document body — the user loses the
 * top bar and has no way back. Returning them lets the page render its own
 * failure state inside the shell.
 */
export const loadBrowser = async (bucket: string, prefix: string): Promise<BrowserData> => {
  const orgs = await listOrgs();
  const orgSlug = orgs[0]?.slug ?? '';

  if (!bucket) {
    try {
      return { ...emptyData(orgSlug), buckets: await listBuckets() };
    } catch (error) {
      return { ...emptyData(orgSlug), error: describeApiError(error) };
    }
  }

  try {
    // Both reads are independent and both are public: `app.ts:296` registers
    // `app.get('/api/v1/*', adapt(handleWebApiV1))` with no auth wrapper.
    const [buckets, listing] = await Promise.all([
      listBuckets(),
      listObjects(bucket, { prefix, maxKeys: MAX_KEYS }),
    ]);
    return { buckets, listing, missingBucket: false, error: null, orgSlug };
  } catch (error) {
    const described = describeApiError(error);
    // `handleListObjectsV1` 404s with `{"error":"Bucket not found"}` before it
    // looks at any object. That is a routing outcome (the link is stale), not a
    // failure of the page, so it gets its own field.
    if (described.status === 404) {
      const buckets = await listBuckets().catch(() => [] as BucketSummary[]);
      return { buckets, listing: null, missingBucket: true, error: null, orgSlug };
    }
    return { buckets: [], listing: null, missingBucket: false, error: described, orgSlug };
  }
};

// ─────── `/` ───────

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): BrowserSearch => ({
    bucket: asBucketName(search.bucket),
    prefix: asPrefix(search.prefix),
  }),
  // Re-runs the loader whenever either param changes, so the listing follows the
  // URL and nothing else.
  loaderDeps: ({ search }: { search: BrowserSearch }) => ({
    bucket: search.bucket,
    prefix: search.prefix,
  }),
  loader: ({ deps }: { deps: { bucket: string; prefix: string } }) =>
    loadBrowser(deps.bucket, deps.prefix),
  component: IndexRoute,
});

function IndexRoute(): React.JSX.Element {
  const { bucket, prefix } = Route.useSearch();
  const data = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  // Hoisted, unconditionally. This hook was previously called inside the JSX
  // ternary below, which is a conditional hook call: selecting a bucket flips
  // the rendered branch and React would report "Rendered more hooks than during
  // the previous render" and unmount the tree.
  const canWrite = useCanWrite();

  const selectBucket = useCallback(
    (name: string) => {
      // Switching bucket resets the prefix: a prefix from another bucket would
      // list nothing and look like data loss.
      void navigate({ search: { bucket: name, prefix: '' } });
    },
    [navigate],
  );

  const createBucket = useCallback(
    async (name: string) => {
      // Re-throws so the dialog stays open and shows the server's own 400/409
      // message. `createBucket` succeeds with 201 and is otherwise transparent.
      await createBucketRequest(name);
      // Navigate into the new bucket only after the reload, so the listing the
      // user lands on is guaranteed to include it.
      await router.invalidate();
      selectBucket(name);
    },
    [router, selectBucket],
  );

  if (data.missingBucket) {
    return (
      <NotFound
        title="Bucket not found"
        detail={`No bucket named "${bucket}" exists on this server. It may have been deleted, or the link may belong to a different deployment.`}
      />
    );
  }

  return (
    <div className="browser-page">
      <BucketToolbar
        buckets={data.buckets}
        selected={bucket}
        onSelect={selectBucket}
        disabled={data.error !== null}
        // `useCanWrite()`, NOT a re-derived boolean: `auth-disabled` (the 404 arm
        // of the `/auth/me` probe) means `requireAuth` is a pass-through and the
        // server WILL accept the create. Hiding the control there would misdescribe
        // the deployment; showing it in `readonly` would offer a call that 401s.
        onCreate={canWrite ? createBucket : undefined}
      />

      {data.error ? (
        <p className="error-banner" role="alert">
          {data.error.message}
        </p>
      ) : bucket ? (
        <FileBrowser
          buckets={data.buckets}
          bucket={bucket}
          prefix={prefix}
          listing={data.listing}
          orgSlug={data.orgSlug}
          // Merged against the current search because `validateSearch` makes both
          // params REQUIRED: TanStack types `search` as `{bucket, prefix}` with
          // no `?`, and navigating with a `Partial` fails with TS2322. Merging
          // is also the correct semantics — `FileBrowser` only ever sends the
          // half it means to change, and the other half is carried forward
          // rather than reset.
          onNavigate={(next) =>
            void navigate({ search: { ...{ bucket, prefix }, ...next } })
          }
        />
      ) : (
        <BucketTable
          buckets={data.buckets}
          orgSlug={data.orgSlug}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

// ─────── Shared: the bucket toolbar ───────

export interface BucketToolbarProps {
  buckets: BucketSummary[];
  selected: string;
  onSelect: (name: string) => void;
  disabled: boolean;
  /**
   * Invoked with the name to create. Provided by the caller so this component
   * stays presentational and the parent decides where a freshly created bucket
   * lands (the index route navigates to it; the bucket route has no business
   * creating one).
   */
  onCreate?: (name: string) => Promise<void>;
}

/**
 * The bucket `<select>` plus the "New bucket" button — `home.html` had both in
 * the top bar (`#bucketSelect` at :157 and `#newBucketBtn` at :159), and the
 * value lives in the URL here, so a refresh and a shared link both land on the
 * same bucket.
 */
export function BucketToolbar({
  buckets,
  selected,
  onSelect,
  disabled,
  onCreate,
}: BucketToolbarProps): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (!onCreate) {
    return (
      <div className="browser-toolbar">
        <BucketSelect buckets={buckets} selected={selected} onSelect={onSelect} disabled={disabled} />
      </div>
    );
  }

  return (
    <>
      <div className="browser-toolbar">
        <BucketSelect buckets={buckets} selected={selected} onSelect={onSelect} disabled={disabled} />
        <button
          type="button"
          className="ghost"
          disabled={disabled || creating}
          onClick={() => setCreating(true)}
        >
          New bucket
        </button>
      </div>

      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

      {creating ? (
        <CreateBucketDialog
          onCancel={() => setCreating(false)}
          onCreate={async (name) => {
            try {
              await onCreate(name);
              setCreating(false);
              setNotice({ kind: 'ok', text: `Created bucket "${name}".` });
            } catch (error) {
              const described = describeApiError(error);
              // `handleCreateBucketV1` returns these verbatim and they are both
              // accurate and actionable, so they are surfaced as-is rather than
              // replaced with a generic failure. 400 is an invalid name, 409 is
              // a duplicate.
              setNotice({ kind: 'error', text: described.message });
              throw described;
            }
          }}
        />
      ) : null}
    </>
  );
}

function BucketSelect({
  buckets,
  selected,
  onSelect,
  disabled,
}: {
  buckets: BucketSummary[];
  selected: string;
  onSelect: (name: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <label className="bucket-select">
      <span className="field-label">Bucket</span>
      <select
        value={selected}
        disabled={disabled || buckets.length === 0}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">— Select bucket —</option>
        {buckets.map((bucket) => (
          <option key={bucket.id} value={bucket.name}>
            {bucket.name} ({bucket.objectCount})
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The create-bucket form — `home.html:358-364`'s `#bucketNameInput` modal,
 * rebuilt as a real dialog.
 *
 * The rules text is transcribed from `BucketNameSchema`'s own error, not from a
 * regex written here, because `handleCreateBucketV1` rejects with exactly
 * `{"error":"Invalid bucket name. Use lowercase, 3-63 chars, no underscore"}`
 * (web-api-controller.ts:93-95) and a second, differently-worded rule list in
 * the UI would be a claim nobody verified. The server's message is the one shown
 * on failure.
 */
function CreateBucketDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <ConfirmDialog
      title="Create bucket"
      confirmLabel="Create"
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setBusy(true);
        // The parent re-throws on failure so the dialog stays open with the
        // server's message on screen; `finally` always clears `busy`.
        void onCreate(trimmed).catch(() => undefined).finally(() => setBusy(false));
      }}
    >
      <label className="dialog-field">
        <span className="field-label">Bucket name</span>
        <input
          type="text"
          value={name}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || busy) return;
            setBusy(true);
            void onCreate(trimmed).catch(() => undefined).finally(() => setBusy(false));
          }}
        />
      </label>
      <p className="field-help">
        Lowercase, 3-63 characters, no underscores. The server enforces this and reports
        its own message when a name is rejected.
      </p>
    </ConfirmDialog>
  );
}

// ─────── Shared: the bucket list ───────

export interface BucketTableProps {
  buckets: BucketSummary[];
  orgSlug: string;
  canWrite: boolean;
}

/**
 * The bucket list, rendered at `/` when no bucket is selected.
 *
 * Names are React children. A bucket name is validated server-side by
 * `BucketNameSchema` (`[a-z0-9.-]`, 3-63 chars, no underscore) so it is far less
 * dangerous than an object key, and it is treated the same way regardless.
 */
export function BucketTable({ buckets, orgSlug, canWrite }: BucketTableProps): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BucketSummary | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const onDelete = useCallback(
    async (bucket: BucketSummary) => {
      setPending(bucket.name);
      try {
        await deleteBucket(bucket.name);
        setConfirming(null);
        setNotice({ kind: 'ok', text: `Deleted bucket "${bucket.name}".` });
        await router.invalidate();
      } catch (error) {
        const described = describeApiError(error);
        setConfirming(null);
        // 409 is the one genuinely informative bucket-delete failure: the bucket
        // exists and holds objects. `handleDeleteBucketV1` checks emptiness
        // BEFORE deleting, so this response is honest — unlike the object delete.
        setNotice({
          kind: 'error',
          text:
            described.status === 409
              ? `"${bucket.name}" still contains objects. Delete them first.`
              : `Could not delete "${bucket.name}": ${described.message}`,
        });
      } finally {
        setPending(null);
      }
    },
    [router],
  );

  if (buckets.length === 0) {
    return (
      <div className="empty-state">
        <h2>No buckets yet</h2>
        <p>
          {canWrite
            ? 'This deployment has no buckets. Use "New bucket" above to create one.'
            : 'This deployment has no buckets. Sign in as an administrator to create one.'}
        </p>
      </div>
    );
  }

  return (
    <div className="bucket-list">
      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

      <table className="file-table">
        <caption className="visually-hidden">Buckets in this deployment</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="numeric">
              Objects
            </th>
            <th scope="col">Created</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.id}>
              <th scope="row" className="name-cell">
                <Link
                  // Route ID, not URL path: the tree emits
                  // `id: '/$orgSlug/bucketName'` and
                  // `path: '/$orgSlug/$bucketName'`, and `to` takes the id.
                  // The path form fails `tsc` with TS2820.
                  to="/$orgSlug/bucketName"
                  params={{ orgSlug, bucketName: bucket.name }}
                  search={{ prefix: '' }}
                  className="bucket-link"
                >
                  {bucket.name}
                </Link>
              </th>
              <td className="numeric">{bucket.objectCount}</td>
              <td className="muted">{formatDate(bucket.createdAt)}</td>
              <td className="actions-cell">
                {canWrite ? (
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={pending === bucket.name}
                    onClick={() => setConfirming(bucket)}
                  >
                    {pending === bucket.name ? 'Working…' : 'Delete'}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {confirming ? (
        <ConfirmDialog
          title="Delete bucket"
          confirmLabel="Delete bucket"
          busy={pending === confirming.name}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void onDelete(confirming)}
        >
          <p>
            Delete the bucket <strong>{confirming.name}</strong>? This cannot be undone. The
            server refuses if it still contains objects.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

// ─────── Shared: the file browser ───────

export interface FileBrowserProps {
  buckets: BucketSummary[];
  /** Bucket being browsed. Non-empty by contract — callers guarantee it. */
  bucket: string;
  /** Current directory prefix. `''` or ending in `/`. */
  prefix: string;
  /**
   * The listing, passed in rather than read with `Route.useLoaderData()`.
   * `useLoaderData` is bound to the route that declares it, so a shared component
   * calling it would read the wrong route's data whenever it is rendered from the
   * other of these two routes.
   */
  listing: ListObjectsResponse | null;
  /** Org slug, used for nothing but symmetry with the bucket route. */
  orgSlug: string;
  /**
   * Navigate to a new place. Receives the next search params for the host route:
   * on `/` that is `{bucket, prefix}`, on the bucket route `{prefix}`.
   */
  onNavigate: (search: Partial<BrowserSearch>) => void;
}

/**
 * The object browser: filter, breadcrumb, listing, dropzone, upload progress,
 * delete, download, copy link.
 *
 * Download and copy-link are deliberately **not** routed through the JSON client.
 * `GET /api/v1/buckets/{b}/download/{k}` returns binary with `Content-Disposition`
 * and CORS `*`, so it is a plain `<a href>` the browser follows with its own
 * cookie jar — which also keeps both working for a logged-out visitor, exactly as
 * in `home.html`.
 */
export function FileBrowser({
  buckets,
  bucket,
  prefix,
  listing,
  onNavigate,
}: FileBrowserProps): React.JSX.Element {
  const canWrite = useCanWrite();
  const router = useRouter();

  const objects = listing?.objects ?? [];
  const prefixes = listing?.prefixes ?? [];

  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ObjectSummary | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadSlot[]>([]);

  // The filter box holds the text being typed; the URL holds the committed
  // prefix. See the file header for why these two cannot disagree.
  const [filterText, setFilterText] = useState(prefix);
  const filterRef = useRef(filterText);
  filterRef.current = filterText;
  const lastCommitted = useRef(prefix);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A navigation from outside the box (breadcrumb, folder row, a shared link)
    // must win, so the box adopts the URL. The exception is the user still typing
    // the same filter without its trailing slash — resyncing there would move the
    // caret mid-word.
    if (asPrefix(prefix) === asPrefix(filterRef.current)) return;
    lastCommitted.current = prefix;
    setFilterText(prefix);
  }, [prefix]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const onFilterChange = useCallback(
    (raw: string) => {
      setFilterText(raw);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const next = asPrefix(raw);
        // Navigating within the same prefix is a no-op, so it must not enter the
        // history stack — otherwise Back walks through every keystroke.
        if (next === lastCommitted.current) return;
        lastCommitted.current = next;
        onNavigate({ prefix: next });
      }, 300);
    },
    [onNavigate],
  );

  const onClearFilter = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setFilterText('');
    lastCommitted.current = '';
    onNavigate({ prefix: '' });
  }, [onNavigate]);

  const onNavigateToPrefix = useCallback(
    (next: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setFilterText(next);
      lastCommitted.current = next;
      onNavigate({ prefix: next });
    },
    [onNavigate],
  );

  /**
   * Delete, then **prove** it.
   *
   * `handleDeleteObjectV1` returns `{"success":true}` unconditionally and
   * discards `softDelete()`'s boolean (web-api-controller.ts:236-245), so a
   * mis-encoded key, or a key that never existed, reports success identically to
   * a real delete. {@link assertDeleted} re-lists the key's own prefix and is the
   * only trustworthy signal. It is paired with the truncation notice below
   * because a key outside the re-list window also reads as "gone".
   */
  const onConfirmDelete = useCallback(
    async (object: ObjectSummary) => {
      setPendingKey(object.key);
      try {
        await deleteObject(bucket, object.key);
        const gone = await assertDeleted(bucket, object.key, { maxKeys: MAX_KEYS });
        setPendingDelete(null);
        if (gone) {
          setNotice({ kind: 'ok', text: `Deleted "${object.key}".` });
        } else {
          setNotice({
            kind: 'error',
            text:
              `The server reported success, but "${object.key}" is still listed. ` +
              'It was not deleted.',
          });
        }
        await router.invalidate();
      } catch (error) {
        const described = describeApiError(error);
        setPendingDelete(null);
        setNotice({
          kind: 'error',
          text:
            described.status === 401
              ? 'Sign in as an administrator to delete.'
              : `Delete failed: ${described.message}`,
        });
      } finally {
        setPendingKey(null);
      }
    },
    [bucket, router],
  );

  /**
   * Copies the **public share link** (`ObjectSummary.downloadUrl`, i.e.
   * `${BASE_URL}/f/{publicId}`), not the admin download proxy.
   *
   * `home.html:328` copied the proxy URL. The share URL is the one that means
   * "send this to someone": it is an unauthenticated `GET /f/:publicId` and does
   * not name the bucket. The proxy URL is still what the Download button uses.
   * Both facts are recorded here rather than left to be re-discovered.
   */
  const onCopyLink = useCallback(async (object: ObjectSummary) => {
    const url = shareUrl(object.downloadUrl);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(object.key);
      setNotice(null);
    } catch {
      // `navigator.clipboard` is unavailable outside a secure context and can be
      // denied by permissions policy. `home.html:328` did `.catch(() => {})`,
      // which looks like the copy succeeded. Show the URL instead.
      setCopied(null);
      setNotice({
        kind: 'error',
        text: `Clipboard unavailable. Copy this link manually: ${url}`,
      });
    }
  }, []);

  const onUpload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      if (!canWrite) {
        setNotice({
          kind: 'error',
          text: 'Read-only mode — sign in as an administrator to upload.',
        });
        return;
      }

      setNotice(null);
      const slots: UploadSlot[] = list.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        loaded: 0,
        total: file.size,
        phase: 'transferring',
        error: null,
      }));
      setUploads(slots);

      let failed: string | null = null;

      for (const [index, file] of list.entries()) {
        const id = slots[index]?.id;
        if (id === undefined) continue;
        const patch = (change: Partial<UploadSlot>) =>
          setUploads((current) =>
            current.map((slot) => (slot.id === id ? { ...slot, ...change } : slot)),
          );

        try {
          // `key` is `prefix + file.name`, matching home.html:341. The server
          // takes it verbatim, so it is only ever rendered as a text child.
          await uploadObject(bucket, file, `${prefix}${file.name}`, (loaded, total) => {
            if (total === null) return;
            // The last progress event means the bytes are AT the server, not
            // stored: `handleUploadObjectV1` buffers the whole body to /tmp before
            // its first Telegram call. Switch the label so the bar does not sit at
            // 100% implying completion.
            patch({ loaded, total, phase: loaded >= total ? 'storing' : 'transferring' });
          });
          patch({ phase: 'done', loaded: file.size, total: file.size, error: null });
        } catch (error) {
          const described = describeApiError(error);
          patch({ phase: 'failed', error: described.message });
          failed = file.name;
          break;
        }
      }

      // Successful rows leave the panel; failures stay until dismissed, because
      // a per-file error is the only record of which file failed.
      setUploads((current) =>
        current.filter((slot) => !(slot.phase === 'done' && slot.error === null)),
      );
      await router.invalidate();

      setNotice(
        failed === null
          ? { kind: 'ok', text: `Uploaded ${list.length} file(s) to "${bucket}".` }
          : {
              kind: 'error',
              text: `Upload of "${failed}" failed; files before it were stored.`,
            },
      );
    },
    [bucket, canWrite, prefix, router],
  );

  /**
   * `isTruncated` is structurally always `false` — `listByPrefix` folds the
   * `maxKeys + 1` probe row into `prefixes` before the controller sees it, and the
   * controller then does `objects.slice(0, maxKeys)`
   * (file-repository.ts:155-175, web-api-controller.ts:154-156), so
   * `objects.length > maxKeys` is unreachable. `nextContinuationToken` is always
   * `null` for the same reason.
   *
   * What IS observable is that the server returned at least `MAX_KEYS` rows in
   * total, which means the `LIMIT` was reached and more may exist. That is the
   * condition below, and it is why this page shows a notice instead of a
   * paginator: a paginator built on the dead fields is a control that cannot work.
   */
  const mayBeTruncated = objects.length + prefixes.length >= MAX_KEYS;

  const hasRows = objects.length > 0 || prefixes.length > 0;

  const otherBuckets = useMemo(
    () => buckets.filter((candidate) => candidate.name !== bucket),
    [buckets, bucket],
  );

  return (
    <div className="file-browser">
      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

      <div className="browser-toolbar">
        <label className="filter-field">
          <span className="field-label">Filter prefix</span>
          <input
            type="text"
            value={filterText}
            spellCheck={false}
            autoComplete="off"
            placeholder="a/b/"
            onChange={(event) => onFilterChange(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost"
          onClick={onClearFilter}
          disabled={filterText === ''}
        >
          Clear
        </button>

        {otherBuckets.length > 0 ? (
          <label className="bucket-select">
            <span className="field-label">Switch bucket</span>
            <select
              value=""
              onChange={(event) => {
                const name = event.target.value;
                if (!name) return;
                // Switching resets the prefix — a prefix from another bucket
                // would list nothing and read as data loss.
                setFilterText('');
                lastCommitted.current = '';
                onNavigate({ bucket: name, prefix: '' });
              }}
            >
              <option value="">— Switch to… —</option>
              {otherBuckets.map((candidate) => (
                <option key={candidate.id} value={candidate.name}>
                  {candidate.name} ({candidate.objectCount})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <p className="field-help">
        Filters by object-key prefix, server-side. Folder and breadcrumb clicks write to the
        same URL, so this box always follows navigation.
      </p>

      <Breadcrumb bucket={bucket} prefix={prefix} onNavigate={onNavigateToPrefix} />

      {mayBeTruncated ? (
        <p className="notice-banner" role="status">
          Showing the first {MAX_KEYS} entries of <strong>{bucket}</strong>
          {prefix ? ` under ${prefix}` : ''}. The API offers no usable continuation token —
          its <code>isTruncated</code> is always <code>false</code> — so entries beyond this
          page are not reachable from here.
        </p>
      ) : null}

      {!hasRows ? (
        <div className="empty-state">
          <h2>{prefix ? 'This folder is empty' : 'This bucket is empty'}</h2>
          {canWrite ? <p>Drop files below to upload.</p> : null}
        </div>
      ) : (
        <ObjectTable
          objects={objects}
          prefixes={prefixes}
          prefix={prefix}
          bucket={bucket}
          canWrite={canWrite}
          pendingKey={pendingKey}
          copiedKey={copied}
          onEnterPrefix={onNavigateToPrefix}
          onDelete={setPendingDelete}
          onCopyLink={(object) => void onCopyLink(object)}
        />
      )}

      {canWrite ? <DropZone onFiles={(files) => void onUpload(files)} /> : null}

      <UploadPanel slots={uploads} onDismiss={() => setUploads([])} />

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete object"
          confirmLabel="Delete"
          busy={pendingKey === pendingDelete.key}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void onConfirmDelete(pendingDelete)}
        >
          <p>
            Delete <strong>{pendingDelete.key}</strong>? This cannot be undone.
          </p>
          <p className="field-help">
            The API returns <code>{'{"success":true}'}</code> whether or not anything was
            removed, so this dialog reports success only after re-listing the prefix and
            confirming the key is gone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

// ─────── Shared: breadcrumb ───────

export interface BreadcrumbProps {
  bucket: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}

/**
 * `home.html:280-286` built this by string-concatenating `onclick` handlers
 * around each accumulated prefix, so a prefix containing an apostrophe broke out
 * of the inline handler. Here every segment is a `<button>` with a bound handler,
 * and the label is a React child.
 */
export function Breadcrumb({
  bucket,
  prefix,
  onNavigate,
}: BreadcrumbProps): React.JSX.Element | null {
  const parts = prefix.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const segments: { label: string; prefix: string }[] = [{ label: bucket, prefix: '' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated += `${part}/`;
    segments.push({ label: part, prefix: accumulated });
  }

  return (
    <nav className="breadcrumb" aria-label="Object key prefix">
      <ol>
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={segment.prefix || 'bucket'}>
              {last ? (
                <span aria-current="page">{segment.label}</span>
              ) : (
                <button type="button" onClick={() => onNavigate(segment.prefix)}>
                  {segment.label}
                </button>
              )}
              {last ? null : (
                <span className="sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─────── Shared: the object table ───────

export interface ObjectTableProps {
  objects: ObjectSummary[];
  prefixes: string[];
  prefix: string;
  bucket: string;
  canWrite: boolean;
  pendingKey: string | null;
  copiedKey: string | null;
  onEnterPrefix: (prefix: string) => void;
  onDelete: (object: ObjectSummary) => void;
  onCopyLink: (object: ObjectSummary) => void;
}

export function ObjectTable({
  objects,
  prefixes,
  prefix,
  bucket,
  canWrite,
  pendingKey,
  copiedKey,
  onEnterPrefix,
  onDelete,
  onCopyLink,
}: ObjectTableProps): React.JSX.Element {
  return (
    <table className="file-table">
      <caption className="visually-hidden">
        Objects and folders in {bucket}
        {prefix ? ` under ${prefix}` : ''}
      </caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col" className="numeric">
            Size
          </th>
          <th scope="col">Modified</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {prefixes.map((folder) => (
          <tr key={folder} className="folder-row">
            <th scope="row" className="name-cell">
              {/* `displayPrefix` always ends in `/`; `home.html:311` used an
                  unanchored `replace` that mangled a key containing the prefix
                  text mid-name. */}
              <button
                type="button"
                className="folder-link"
                onClick={() => onEnterPrefix(folder)}
              >
                <span aria-hidden="true">🗂</span> {displayPrefix(folder, prefix)}
              </button>
            </th>
            <td className="numeric muted" aria-hidden="true">
              —
            </td>
            <td className="muted" />
            <td className="actions-cell" />
          </tr>
        ))}

        {objects.map((object) => {
          const busy = pendingKey === object.key;
          return (
            <tr key={object.key}>
              <th scope="row" className="name-cell">
                <span className="object-name">
                  <span aria-hidden="true">📄</span> {displayKey(object.key, prefix)}
                </span>
                {/* The full key, as a text child. `home.html:314-317` put this
                    same untrusted string into inline handlers. */}
                <span className="object-key" title={object.key}>
                  {object.key}
                </span>
              </th>
              <td className="numeric">{formatSize(object.sizeBytes)}</td>
              <td className="muted">{formatDate(object.lastModified)}</td>
              <td className="actions-cell">
                <a
                  className="ghost button"
                  href={objectDownloadUrl(bucket, object.key)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Download. This route returns the file itself, so it opens in a new tab rather than navigating the app."
                >
                  Download
                </a>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onCopyLink(object)}
                  title={`Copy the public share link for ${object.key}`}
                >
                  {copiedKey === object.key ? 'Copied' : 'Copy link'}
                </button>
                {canWrite ? (
                  <button
                    type="button"
                    className="ghost danger"
                    disabled={busy}
                    onClick={() => onDelete(object)}
                  >
                    {busy ? 'Working…' : 'Delete'}
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─────── Shared: dropzone and upload progress ───────

interface UploadSlot {
  id: string;
  name: string;
  loaded: number;
  total: number;
  /** `transferring` = bytes to the server. `storing` = buffered, Telegram in flight. */
  phase: 'transferring' | 'storing' | 'done' | 'failed';
  error: string | null;
}

/**
 * Click-to-browse and drag-and-drop in one element.
 *
 * A real `<input type="file">` inside a `<label>` rather than a click handler
 * that synthesises one, so the control is keyboard- and screen-reader-operable
 * without extra code. `home.html:355` built the input in JS and called
 * `.click()`.
 */
function DropZone({ onFiles }: { onFiles: (files: FileList) => void }): React.JSX.Element {
  const [dragging, setDragging] = useState(false);

  return (
    <label
      className={dragging ? 'dropzone dragover' : 'dropzone'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
      }}
    >
      <span className="visually-hidden">Upload files</span>
      📁 Drop files here, or click to browse
      <input
        type="file"
        multiple
        className="visually-hidden"
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) {
            onFiles(event.target.files);
          }
          // Reset so re-picking the same file fires `change` again.
          event.target.value = '';
        }}
      />
    </label>
  );
}

function UploadPanel({
  slots,
  onDismiss,
}: {
  slots: UploadSlot[];
  onDismiss: () => void;
}): React.JSX.Element | null {
  if (slots.length === 0) return null;

  return (
    <section className="upload-panel" aria-live="polite" aria-label="Upload progress">
      <ul>
        {slots.map((slot) => {
          const pct =
            slot.total > 0 ? Math.min(100, Math.round((slot.loaded / slot.total) * 100)) : 0;
          const label =
            slot.phase === 'storing'
              ? 'transfer complete — storing…'
              : slot.phase === 'done'
                ? 'stored'
                : slot.phase === 'failed'
                  ? 'failed'
                  : 'uploading…';
          return (
            <li key={slot.id} className={`upload-slot ${slot.phase}`}>
              <span className="upload-name">{slot.name}</span>
              <progress value={pct} max={100} aria-label={`${slot.name}: ${label}`} />
              <span className="upload-status">
                {label}
                {slot.phase === 'transferring' ? ` ${pct}%` : ''}
                {slot.error ? ` — ${slot.error}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

// ─────── Shared: notices and the confirm dialog ───────

export function NoticeBanner({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <p
      className={notice.kind === 'error' ? 'notice-banner error' : 'notice-banner ok'}
      role="alert"
    >
      {notice.text}
      <button type="button" className="ghost" onClick={onDismiss} aria-label="Dismiss message">
        Dismiss
      </button>
    </p>
  );
}

/**
 * An accessible replacement for `confirm()`.
 *
 * `home.html:329` called `confirm(\`Delete "${key}"?\`)` — formatting the key into a
 * native string is safe, but the dialog carries no explanation of what the server
 * actually guarantees, which matters here because it returns `success: true`
 * unconditionally. `home.html:184` also carries a comment claiming Escape closes
 * the modal; grep finds no such handler, so that comment is stale and is **not**
 * ported as a requirement — the Escape handling below is an improvement, not a
 * regression against something that existed.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="modal-overlay"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary danger"
            onClick={onConfirm}
            disabled={busy}
            ref={confirmRef}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Route;