/**
 * The object browser: the app's main working surface.
 *
 * ## What changed from the previous version, and why
 *
 * The old `FileBrowser` in `routes/index.tsx` held five `useState` values, a
 * `useRef` per timer, and three `useEffect`s — every one of which Kana's
 * `no-react-hooks` rule bans. They are gone, replaced as follows:
 *
 * | Was | Now |
 * |---|---|
 * | `useState<Notice>` | a TanStack `Store` (`browserStore`) |
 * | `useState<ObjectSummary \| null>` (pending delete) | `confirming` in that store |
 * | `useState<string \| null>` (pending key) | `pendingKey` in that store |
 * | `useState<string \| null>` (copied key) | `copiedKey` in that store |
 * | `useState<UploadSlot[]>` | `uploads` in that store |
 * | `useState<string>` + `useRef` + `setTimeout` for the filter box | TanStack Pacer `Debouncer` |
 * | `useEffect` syncing the box to the URL | none — the box is controlled by the URL |
 *
 * ## The filter box no longer needs a sync effect
 *
 * The old code kept the typed text in state and the committed prefix in the URL,
 * then ran an effect to copy the URL back into the box when navigation came from
 * elsewhere (a breadcrumb, a folder row, a shared link). Two sources of truth plus
 * an effect to reconcile them.
 *
 * Here the box's `value` IS the URL's `prefix`, and a keystroke schedules a
 * navigation through a `Debouncer`. There is nothing to reconcile because there is
 * one value. The cost is that a half-typed prefix is normalised on the way out
 * (`asPrefix` adds the trailing slash), which is the behaviour the listing needs
 * anyway — the server matches prefixes literally.
 *
 * ## Upload progress survives navigation
 *
 * An upload outlives this component in one case that matters: navigating to another
 * folder mid-upload unmounts it. A module-level Store keeps the slots alive so the
 * panel reappears with live progress. The XHR is not cancelled — the server has
 * already begun storing, so aborting the client would only lose the report.
 */

import { Debouncer } from '@tanstack/pacer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { api } from './api';
import { ApiError, uploadObject } from './client';
import { Breadcrumb, ConfirmDialog, type Notice, NoticeBanner, ObjectTable } from './components';
import { asPrefix } from './prefix';
import { objectListQuery } from './queries';
import { keys } from './query-keys';
import type { BucketSummary, ObjectSummary } from './types';

/** Page size. `home.html` hardcoded 200 and truncated without saying so. */
export const MAX_KEYS = 200;

/** One file's upload progress. */
interface UploadSlot {
  readonly id: string;
  readonly name: string;
  readonly loaded: number;
  readonly total: number;
  /** `transferring` = bytes to the server. `storing` = buffered, Telegram in flight. */
  readonly phase: 'transferring' | 'storing' | 'done' | 'failed';
  readonly error: string | null;
}

/** Everything the browser renders that is not server data. */
interface BrowserUiState {
  readonly notice: Notice | null;
  readonly confirming: ObjectSummary | null;
  readonly pendingKey: string | null;
  readonly copiedKey: string | null;
  readonly uploads: readonly UploadSlot[];
}

const INITIAL_UI: BrowserUiState = {
  notice: null,
  confirming: null,
  pendingKey: null,
  copiedKey: null,
  uploads: [],
};

/**
 * The browser's local state.
 *
 * Module-level so upload progress survives a route change, and so each field can be
 * read with a narrow `useSelector` instead of subscribing the whole component to
 * every field.
 */
const browserStore = new Store<BrowserUiState>(INITIAL_UI);

/** Replaces some fields, leaving the rest untouched. */
const patchUi = (change: Partial<BrowserUiState>): void => {
  browserStore.setState((state) => ({ ...state, ...change }));
};

/**
 * Human-readable text for a failed call.
 *
 * `503 {"error":"Tenant scope unavailable (missing_organization_membership)"}` is
 * returned by EVERY `/api/v1/*` branch when the caller has no org membership. It is
 * a misconfigured deployment, not an authorisation failure, so it gets its own
 * sentence instead of the raw body.
 *
 * @param error - Whatever was thrown.
 * @returns A message safe to show a user.
 */
export const describeApiError = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return (
        'This server has no tenant scope configured (missing_organization_membership), so it ' +
        "cannot serve any bucket. Ask an administrator to check the account's organization " +
        'membership.'
      );
    }
    return error.message;
  }
  if (error instanceof Error) return error.message || 'Request failed';
  return 'Request failed';
};

/** Props for {@link FileBrowser}. */
export interface FileBrowserProps {
  readonly buckets: readonly BucketSummary[];
  readonly bucket: string;
  readonly prefix: string;
  readonly orgSlug: string;
  readonly canWrite: boolean;
  /** Navigate within the host route's search params. */
  readonly onNavigate: (next: { bucket?: string; prefix?: string }) => void;
}

/**
 * The object browser.
 *
 * The listing comes from `useQuery` on the same options the route's `beforeLoad`
 * prefetched, so on a cold navigation the first paint has rows and on a warm one
 * there is no request at all.
 *
 * @param props - See {@link FileBrowserProps}.
 */
export function FileBrowser({
  buckets,
  bucket,
  prefix,
  orgSlug,
  canWrite,
  onNavigate,
}: FileBrowserProps): React.JSX.Element {
  const queryClient = useQueryClient();

  const notice = useSelector(browserStore, (state) => state.notice);
  const confirming = useSelector(browserStore, (state) => state.confirming);
  const pendingKey = useSelector(browserStore, (state) => state.pendingKey);
  const copiedKey = useSelector(browserStore, (state) => state.copiedKey);
  const uploads = useSelector(browserStore, (state) => state.uploads);

  const listing = useQuery(objectListQuery({ orgSlug }, bucket, prefix, MAX_KEYS));

  /**
   * Debounced navigation for the filter box.
   *
   * TanStack Pacer's `Debouncer` replaces `setTimeout` inside a `useRef`: it owns the
   * timer and exposes `cancel`, so there is no cleanup effect. It is constructed per
   * render rather than once at module scope because it closes over `onNavigate` and
   * `prefix`; no timer is armed until `maybeExecute` runs, so the cost is an object
   * allocation.
   */
  const navigateDebounced = new Debouncer(
    (next: string) => {
      // Navigating within the same prefix must not enter the history stack,
      // otherwise Back walks through every keystroke.
      if (next === prefix) return;
      onNavigate({ prefix: next });
    },
    { wait: 300 },
  );

  /** Refreshes everything a write invalidates: this bucket's listings and its counts. */
  const invalidateAfterWrite = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.objects(orgSlug, bucket) }),
      queryClient.invalidateQueries({ queryKey: keys.bucketList(orgSlug) }),
      queryClient.invalidateQueries({ queryKey: keys.storageUsage(orgSlug) }),
    ]);
  };

  /**
   * Delete, then PROVE it.
   *
   * The delete handler returns `{"success":true}` unconditionally and discards
   * `softDelete()`'s boolean, so a mis-encoded key — or a key that never existed —
   * reports success identically to a real delete. Re-listing the key's own prefix is
   * the only trustworthy signal.
   */
  const deleteMutation = useMutation({
    mutationFn: async (object: ObjectSummary) => {
      patchUi({ pendingKey: object.key });
      await api.deleteObject({ bucket, key: object.key });
      const parent = object.key.includes('/')
        ? object.key.slice(0, object.key.lastIndexOf('/') + 1)
        : '';
      const after = await api.listObjects({
        bucket,
        prefix: parent,
        delimiter: '/',
        maxKeys: MAX_KEYS,
      });
      return { key: object.key, gone: !after.objects.some((o) => o.key === object.key) };
    },
    onSuccess: ({ key, gone }) => {
      patchUi({
        confirming: null,
        pendingKey: null,
        notice: gone
          ? { kind: 'ok', text: `Deleted "${key}".` }
          : {
              kind: 'error',
              text: `The server reported success, but "${key}" is still listed. It was not deleted.`,
            },
      });
    },
    onError: (error) => {
      patchUi({
        confirming: null,
        pendingKey: null,
        notice: { kind: 'error', text: `Delete failed: ${describeApiError(error)}` },
      });
    },
    onSettled: () => {
      void invalidateAfterWrite();
    },
  });

  /**
   * Copies the PUBLIC share link, not the download proxy.
   *
   * `home.html:328` copied the proxy URL. The share URL (`/f/{publicId}`) is the one
   * that means "send this to someone": it is unauthenticated and does not name the
   * bucket. The proxy URL is what the Download button uses.
   */
  const copyLink = async (object: ObjectSummary): Promise<void> => {
    const url = new URL(object.downloadUrl, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      patchUi({ copiedKey: object.key, notice: null });
    } catch {
      // `navigator.clipboard` is unavailable outside a secure context and can be
      // denied by permissions policy. `home.html:328` did `.catch(() => {})`, which
      // looks like the copy succeeded. Show the URL instead.
      patchUi({
        copiedKey: null,
        notice: { kind: 'error', text: `Clipboard unavailable. Copy this link manually: ${url}` },
      });
    }
  };

  /**
   * Uploads each file in sequence, reporting per-file progress.
   *
   * Sequential rather than parallel: the server buffers each body to disk before its
   * first Telegram call, so parallel uploads of large files multiply peak disk usage
   * for no throughput gain against a single upstream.
   */
  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    if (!canWrite) {
      patchUi({ notice: { kind: 'error', text: 'Read-only mode — sign in to upload.' } });
      return;
    }

    const slots: UploadSlot[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      loaded: 0,
      total: file.size,
      phase: 'transferring',
      error: null,
    }));
    patchUi({ notice: null, uploads: slots });

    const patchSlot = (id: string, change: Partial<UploadSlot>): void => {
      patchUi({
        uploads: browserStore.state.uploads.map((slot) =>
          slot.id === id ? { ...slot, ...change } : slot,
        ),
      });
    };

    let failed: string | null = null;

    for (const [index, file] of files.entries()) {
      const id = slots[index]?.id;
      if (id === undefined) continue;

      try {
        // `key` is `prefix + file.name`. The server takes it verbatim, so it is only
        // ever rendered as a text child. Scoped to `orgSlug` — an unscoped upload
        // would land in the caller's default org, not necessarily the one on screen.
        await uploadObject({
          bucket,
          file,
          key: `${prefix}${file.name}`,
          orgSlug,
          onProgress: (loaded, total) => {
            if (!Number.isFinite(total) || total <= 0) return;
            // The last progress event means the bytes are AT the server, not stored:
            // the handler buffers the whole body to /tmp before its first Telegram
            // call. Switch the label so the bar does not sit at 100% implying
            // completion.
            patchSlot(id, { loaded, total, phase: loaded >= total ? 'storing' : 'transferring' });
          },
        });
        patchSlot(id, { phase: 'done', loaded: file.size, total: file.size, error: null });
      } catch (error) {
        patchSlot(id, { phase: 'failed', error: describeApiError(error) });
        failed = file.name;
        break;
      }
    }

    // Successful rows leave the panel; failures stay until dismissed, because a
    // per-file error is the only record of which file failed.
    patchUi({
      uploads: browserStore.state.uploads.filter(
        (slot) => !(slot.phase === 'done' && slot.error === null),
      ),
      notice:
        failed === null
          ? { kind: 'ok', text: `Uploaded ${files.length} file(s) to "${bucket}".` }
          : {
              kind: 'error',
              text: `Upload of "${failed}" failed; files before it were stored.`,
            },
    });

    await invalidateAfterWrite();
  };

  const objects = listing.data?.objects ?? [];
  const prefixes = listing.data?.prefixes ?? [];

  /**
   * `isTruncated` is structurally always `false` — the repository folds the
   * `maxKeys + 1` probe row into `prefixes` before the controller sees it, so
   * `objects.length > maxKeys` is unreachable and `nextContinuationToken` is always
   * `null`. What IS observable is that the server returned at least `MAX_KEYS` rows
   * in total, which means the `LIMIT` was reached and more may exist. That is the
   * condition below, and it is why this page shows a notice rather than a paginator:
   * a paginator built on the dead fields would be a control that cannot work.
   */
  const mayBeTruncated = objects.length + prefixes.length >= MAX_KEYS;
  const hasRows = objects.length > 0 || prefixes.length > 0;

  return (
    <div className="file-browser">
      {notice ? <NoticeBanner notice={notice} onDismiss={() => patchUi({ notice: null })} /> : null}

      {listing.isError ? (
        <p className="error-banner" role="alert">
          {describeApiError(listing.error)}
        </p>
      ) : null}

      <div className="browser-toolbar">
        <label className="filter-field">
          <span className="field-label">Filter prefix</span>
          <input
            type="text"
            // Controlled by the URL: there is no second copy of this value to
            // desynchronise. See the file header.
            value={prefix}
            spellCheck={false}
            autoComplete="off"
            placeholder="a/b/"
            onChange={(event) => navigateDebounced.maybeExecute(asPrefix(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            navigateDebounced.cancel();
            onNavigate({ prefix: '' });
          }}
          disabled={prefix === ''}
        >
          Clear
        </button>

        {buckets.some((candidate) => candidate.name !== bucket) ? (
          <label className="bucket-select">
            <span className="field-label">Switch bucket</span>
            <select
              value=""
              onChange={(event) => {
                const name = event.target.value;
                if (!name) return;
                // Switching resets the prefix — a prefix from another bucket would
                // list nothing and read as data loss.
                navigateDebounced.cancel();
                onNavigate({ bucket: name, prefix: '' });
              }}
            >
              <option value="">— Switch to… —</option>
              {buckets
                .filter((candidate) => candidate.name !== bucket)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.name}>
                    {candidate.name} ({candidate.objectCount})
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

      <p className="field-help">
        Filters by object-key prefix, server-side. Folder and breadcrumb clicks write to the same
        URL, so this box always follows navigation.
      </p>

      <Breadcrumb
        bucket={bucket}
        prefix={prefix}
        onNavigate={(next) => {
          navigateDebounced.cancel();
          onNavigate({ prefix: next });
        }}
      />

      {mayBeTruncated ? (
        <p className="notice-banner" role="status">
          Showing the first {MAX_KEYS} entries of <strong>{bucket}</strong>
          {prefix ? ` under ${prefix}` : ''}. The API offers no usable continuation token — its{' '}
          <code>isTruncated</code> is always <code>false</code> — so entries beyond this page are
          not reachable from here.
        </p>
      ) : null}

      {!hasRows && !listing.isPending ? (
        <div className="empty-state">
          <h2>{prefix ? 'This folder is empty' : 'This bucket is empty'}</h2>
          {canWrite ? <p>Drop files below to upload.</p> : null}
        </div>
      ) : null}

      {hasRows ? (
        <ObjectTable
          objects={objects}
          prefixes={prefixes}
          prefix={prefix}
          bucket={bucket}
          canWrite={canWrite}
          pendingKey={pendingKey}
          copiedKey={copiedKey}
          onEnterPrefix={(next) => {
            navigateDebounced.cancel();
            onNavigate({ prefix: next });
          }}
          onDelete={(object) => patchUi({ confirming: object })}
          onCopyLink={(object) => void copyLink(object)}
          downloadHref={(object) => downloadUrlOf(bucket, object.key, orgSlug)}
        />
      ) : null}

      {canWrite ? <DropZone onFiles={(files) => void uploadFiles(files)} /> : null}

      <UploadPanel slots={uploads} onDismiss={() => patchUi({ uploads: [] })} />

      {confirming ? (
        <ConfirmDialog
          title="Delete object"
          confirmLabel="Delete"
          busy={pendingKey === confirming.key}
          onCancel={() => patchUi({ confirming: null })}
          onConfirm={() => deleteMutation.mutate(confirming)}
        >
          <p>
            Delete <strong>{confirming.key}</strong>? This cannot be undone.
          </p>
          <p className="field-help">
            The API returns <code>{'{"success":true}'}</code> whether or not anything was removed,
            so this dialog reports success only after re-listing the prefix and confirming the key
            is gone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * Builds the absolute download URL for one object.
 *
 * Per-segment encoding, never `encodeURIComponent(key)`: the whole-key form turns
 * `/` into `%2F`, which arrives as a literal character inside the key rather than a
 * separator, and the handler then re-joins the segments — so the key it looks up is
 * `a%2Fb.txt` and no row matches. Returns `404 {"error":"Object not found"}`.
 *
 * @param bucket - The bucket name.
 * @param key - The object key.
 * @param orgSlug - The tenant to scope the request to.
 * @returns An absolute URL.
 */
const downloadUrlOf = (bucket: string, key: string, orgSlug: string): string => {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `/api/v1/buckets/${encodeURIComponent(bucket)}/download/${encoded}`,
    window.location.origin,
  );
  url.searchParams.set('org', orgSlug);
  return url.toString();
};

// ── Dropzone ────────────────────────────────────────────────────────────────

/**
 * Whether a drag is currently over the zone.
 *
 * A Store rather than `useState` (Kana bans it). It is a boolean that drives a
 * class name, so there is nothing to memoise and nothing to persist.
 */
const draggingStore = new Store(false);

/**
 * Click-to-browse and drag-and-drop in one element.
 *
 * A real `<input type="file">` inside a `<label>` rather than a click handler that
 * synthesises one, so the control is keyboard- and screen-reader-operable without
 * extra code. `home.html:355` built the input in JS and called `.click()`.
 */
function DropZone({ onFiles }: { onFiles: (files: readonly File[]) => void }): React.JSX.Element {
  const dragging = useSelector(draggingStore, (value) => value);

  return (
    <label
      className={dragging ? 'dropzone dragover' : 'dropzone'}
      onDragOver={(event) => {
        event.preventDefault();
        draggingStore.setState(() => true);
      }}
      onDragLeave={() => draggingStore.setState(() => false)}
      onDrop={(event) => {
        event.preventDefault();
        draggingStore.setState(() => false);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) onFiles(dropped);
      }}
    >
      <span className="visually-hidden">Upload files</span>📁 Drop files here, or click to browse
      <input
        type="file"
        multiple
        className="visually-hidden"
        onChange={(event) => {
          const picked = event.target.files ? Array.from(event.target.files) : [];
          if (picked.length > 0) onFiles(picked);
          // Reset so re-picking the same file fires `change` again.
          event.target.value = '';
        }}
      />
    </label>
  );
}

// ── Upload progress panel ───────────────────────────────────────────────────

/**
 * Per-file progress, announced politely.
 *
 * The label distinguishes `transferring` from `storing` because the progress bar
 * measures bytes handed to the SERVER, not bytes stored: the handler buffers the
 * whole body to disk before its first Telegram call, so the bar reaches 100% and
 * then waits. Saying "storing…" is the honest reading of that pause.
 */
function UploadPanel({
  slots,
  onDismiss,
}: {
  slots: readonly UploadSlot[];
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
