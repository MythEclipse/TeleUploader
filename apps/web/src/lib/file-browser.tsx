/**
 * The object browser: the app's main working surface.
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

export const MAX_KEYS = 200;

interface UploadSlot {
  readonly id: string;
  readonly name: string;
  readonly loaded: number;
  readonly total: number;
  readonly phase: 'transferring' | 'storing' | 'done' | 'failed';
  readonly error: string | null;
}

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

const browserStore = new Store<BrowserUiState>(INITIAL_UI);

const patchUi = (change: Partial<BrowserUiState>): void => {
  browserStore.setState((state) => ({ ...state, ...change }));
};

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

export interface FileBrowserProps {
  readonly buckets: readonly BucketSummary[];
  readonly bucket: string;
  readonly prefix: string;
  readonly orgSlug: string;
  readonly canWrite: boolean;
  readonly onNavigate: (next: { bucket?: string; prefix?: string }) => void;
}

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

  const navigateDebounced = new Debouncer(
    (next: string) => {
      if (next === prefix) return;
      onNavigate({ prefix: next });
    },
    { wait: 300 },
  );

  const invalidateAfterWrite = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.objects(orgSlug, bucket) }),
      queryClient.invalidateQueries({ queryKey: keys.bucketList(orgSlug) }),
      queryClient.invalidateQueries({ queryKey: keys.storageUsage(orgSlug) }),
    ]);
  };

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
          : { kind: 'error', text: `The server reported success, but "${key}" is still listed.` },
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

  const copyLink = async (object: ObjectSummary): Promise<void> => {
    const url = new URL(object.downloadUrl, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      patchUi({ copiedKey: object.key, notice: null });
    } catch {
      patchUi({
        copiedKey: null,
        notice: { kind: 'error', text: `Clipboard unavailable. Copy this link manually: ${url}` },
      });
    }
  };

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
        await uploadObject({
          bucket,
          file,
          key: `${prefix}${file.name}`,
          orgSlug,
          onProgress: (loaded, total) => {
            if (!Number.isFinite(total) || total <= 0) return;
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

    patchUi({
      uploads: browserStore.state.uploads.filter(
        (slot) => !(slot.phase === 'done' && slot.error === null),
      ),
      notice:
        failed === null
          ? { kind: 'ok', text: `Uploaded ${files.length} file(s) to "${bucket}".` }
          : { kind: 'error', text: `Upload of "${failed}" failed; files before it were stored.` },
    });

    await invalidateAfterWrite();
  };

  const objects = listing.data?.objects ?? [];
  const prefixes = listing.data?.prefixes ?? [];

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
            value={prefix}
            spellCheck={false}
            autoComplete="off"
            placeholder="a/b/"
            onChange={(event) => navigateDebounced.maybeExecute(asPrefix(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="btn-ghost"
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

const downloadUrlOf = (bucket: string, key: string, orgSlug: string): string => {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `/api/v1/buckets/${encodeURIComponent(bucket)}/download/${encoded}`,
    window.location.origin,
  );
  url.searchParams.set('org', orgSlug);
  return url.toString();
};

const draggingStore = new Store(false);

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
      <button type="button" className="btn-ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
