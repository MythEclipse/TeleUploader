/** The object browser: the app's main working surface. */

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
    <div className="px-5 py-4">
      {notice ? <NoticeBanner notice={notice} onDismiss={() => patchUi({ notice: null })} /> : null}

      {listing.isError ? (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500 text-red-500 rounded-lg" role="alert">
          {describeApiError(listing.error)}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-4 items-center">
        <label className="flex flex-col gap-1 min-w-[200px]">
          <span className="text-xs uppercase text-slate-400 font-semibold">Filter prefix</span>
          <input
            type="text"
            value={prefix}
            spellCheck={false}
            autoComplete="off"
            placeholder="a/b/"
            onChange={(event) => navigateDebounced.maybeExecute(asPrefix(event.target.value))}
            className="px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <button
          type="button"
          className="px-3 py-1.5 text-slate-400 hover:text-slate-200 disabled:opacity-50 text-sm"
          onClick={() => {
            navigateDebounced.cancel();
            onNavigate({ prefix: '' });
          }}
          disabled={prefix === ''}
        >
          Clear
        </button>

        {buckets.some((candidate) => candidate.name !== bucket) ? (
          <label className="flex flex-col gap-1 min-w-[160px]">
            <span className="text-xs uppercase text-slate-400 font-semibold">Switch bucket</span>
            <select
              value=""
              onChange={(event) => {
                const name = event.target.value;
                if (!name) return;
                navigateDebounced.cancel();
                onNavigate({ bucket: name, prefix: '' });
              }}
              className="px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

      <p className="text-sm text-slate-500 mb-4">
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
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500 text-amber-500 rounded-lg text-sm">
          Showing the first {MAX_KEYS} entries of <strong className="text-amber-400">{bucket}</strong>
          {prefix ? ` under ${prefix}` : ''}. The API offers no usable continuation token — its{' '}
          <code className="bg-slate-900 px-1.5 py-0.5 rounded text-amber-400">isTruncated</code> is always <code className="bg-slate-900 px-1.5 py-0.5 rounded text-amber-400">false</code> — so entries beyond this page are
          not reachable from here.
        </div>
      ) : null}

      {!hasRows && !listing.isPending ? (
        <div className="py-12 text-center text-slate-400">
          <h2 className="text-lg text-slate-300 mb-2">{prefix ? 'This folder is empty' : 'This bucket is empty'}</h2>
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
          <p className="text-slate-200">
            Delete <strong className="text-slate-100">{confirming.key}</strong>? This cannot be undone.
          </p>
          <p className="text-sm text-slate-500 mt-2">
            The API returns <code className="bg-slate-900 px-1.5 py-0.5 rounded text-slate-400">{"{\"success\":true}"}</code> whether or not anything was removed,
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
      className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition mb-4 ${
        dragging ? 'border-blue-500 bg-blue-500/10 text-blue-400' : 'border-slate-600 text-slate-400 hover:border-slate-500 hover:bg-slate-800/50'
      }`}
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
      <span className="sr-only">Upload files</span>
      📁 Drop files here, or click to browse
      <input
        type="file"
        multiple
        className="sr-only"
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
    <section className="mb-4 p-4 bg-slate-800 border border-slate-700 rounded-lg" aria-live="polite" aria-label="Upload progress">
      <ul className="space-y-3">
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
            <li key={slot.id} className="flex items-center gap-3">
              <span className="flex-1 text-sm text-slate-300 truncate">{slot.name}</span>
              <progress value={pct} max={100} className="w-24 h-2 rounded-full overflow-hidden" aria-label={`${slot.name}: ${label}`}>
                <div className="relative w-full h-full bg-slate-700 rounded-full">
                  <div className={`h-full rounded-full transition-all duration-200 ${slot.phase === 'done' ? 'bg-green-500' : slot.phase === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                </div>
              </progress>
              <span className="text-xs text-slate-400 min-w-[80px]">
                {label}
                {slot.phase === 'transferring' ? ` ${pct}%` : ''}
                {slot.error ? ` — ${slot.error}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex justify-end">
        <button type="button" className="px-3 py-1.5 text-slate-400 hover:text-slate-200 text-sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
