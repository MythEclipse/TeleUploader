/** The object browser: the app's main working surface. */

import { Debouncer } from '@tanstack/pacer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { CloudUpload, FolderOpen, Search, Upload, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/primitive';
import { api } from './api';
import { ApiError, uploadObject } from './client';
import {
  Breadcrumb,
  ConfirmDialog,
  EmptyState,
  type Notice,
  NoticeBanner,
  ObjectTable,
} from './components';
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
  const otherBuckets = buckets.filter((candidate) => candidate.name !== bucket);

  return (
    <section aria-label={`Files in ${bucket}`}>
      {notice ? <NoticeBanner notice={notice} onDismiss={() => patchUi({ notice: null })} /> : null}

      {listing.isError ? (
        <div
          className="mb-4 flex items-start gap-2.5 rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] text-danger"
          role="alert"
        >
          {describeApiError(listing.error)}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="relative flex-1 basis-56">
          <span className="sr-only">Filter prefix</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={prefix}
            spellCheck={false}
            autoComplete="off"
            placeholder="Filter by prefix, e.g. images/2026/"
            aria-label="Filter by object key prefix"
            onChange={(event) => navigateDebounced.maybeExecute(asPrefix(event.target.value))}
            className="h-9 w-full rounded-lg border border-border-strong bg-surface pl-9 pr-8 text-sm text-foreground placeholder:text-subtle-foreground transition-[border-color,box-shadow] focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {prefix ? (
            <button
              type="button"
              aria-label="Clear prefix filter"
              onClick={() => {
                navigateDebounced.cancel();
                onNavigate({ prefix: '' });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </label>

        {otherBuckets.length > 0 ? (
          <label className="shrink-0">
            <span className="sr-only">Switch bucket</span>
            <select
              value=""
              aria-label="Switch bucket"
              onChange={(event) => {
                const name = event.target.value;
                if (!name) return;
                navigateDebounced.cancel();
                onNavigate({ bucket: name, prefix: '' });
              }}
              className="h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground transition-[border-color,box-shadow] focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Switch bucket…</option>
              {otherBuckets.map((candidate) => (
                <option key={candidate.id} value={candidate.name}>
                  {candidate.name} ({candidate.objectCount})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {canWrite ? (
          <label className="shrink-0">
            <span className="sr-only">Upload files</span>
            <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-surface-hover">
              <Upload className="size-4" aria-hidden="true" />
              Upload
            </span>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(event) => {
                const picked = event.target.files ? Array.from(event.target.files) : [];
                if (picked.length > 0) void uploadFiles(picked);
                event.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>

      <Breadcrumb
        bucket={bucket}
        prefix={prefix}
        onNavigate={(next) => {
          navigateDebounced.cancel();
          onNavigate({ prefix: next });
        }}
      />

      {mayBeTruncated ? (
        <div className="mb-4 rounded-lg border border-warning/35 bg-warning-soft px-3.5 py-2.5 text-[0.8125rem] text-warning">
          Showing the first {MAX_KEYS} entries of <strong>{bucket}</strong>
          {prefix ? ` under ${prefix}` : ''}. The API offers no usable continuation token, so
          entries beyond this page are not reachable from here.
        </div>
      ) : null}

      {listing.isPending && !hasRows ? (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3 px-1 py-2">
              <div className="size-8 animate-pulse rounded-lg bg-surface-hover" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-surface-hover" />
              <div className="ml-auto h-3 w-16 animate-pulse rounded bg-surface-hover" />
            </div>
          ))}
        </div>
      ) : null}

      {!hasRows && !listing.isPending ? (
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={<FolderOpen className="size-5" />}
            title={prefix ? 'This folder is empty' : 'This bucket is empty'}
            description={
              canWrite
                ? 'Drop files anywhere on this panel to upload them.'
                : 'No objects here yet. Uploads require a writable session.'
            }
          />
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

      {canWrite ? <DropZone prefix={prefix} onFiles={(files) => void uploadFiles(files)} /> : null}

      <UploadPanel slots={uploads} onDismiss={() => patchUi({ uploads: [] })} />

      {confirming ? (
        <ConfirmDialog
          title="Delete object"
          description="This cannot be undone."
          confirmLabel="Delete"
          busy={pendingKey === confirming.key}
          onCancel={() => patchUi({ confirming: null })}
          onConfirm={() => deleteMutation.mutate(confirming)}
        >
          <p className="text-foreground">
            Delete <strong className="font-semibold">{confirming.key}</strong>?
          </p>
          <p className="mt-2 text-[0.8125rem] text-muted-foreground">
            The API returns{' '}
            <code className="rounded bg-surface-muted px-1.5 py-0.5">{'{"success":true}'}</code>{' '}
            whether or not anything was removed, so this dialog reports success only after
            re-listing the prefix and confirming the key is gone.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
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

function DropZone({
  onFiles,
  prefix,
}: {
  onFiles: (files: readonly File[]) => void;
  prefix: string;
}): React.JSX.Element {
  const dragging = useSelector(draggingStore, (value) => value);

  return (
    <label
      className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
        dragging
          ? 'border-primary bg-primary-soft'
          : 'border-border-strong bg-surface/50 hover:border-primary/60 hover:bg-surface-hover/50'
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
      <CloudUpload
        className={`mb-2 size-6 ${dragging ? 'text-primary' : 'text-subtle-foreground'}`}
        aria-hidden="true"
      />
      <span className="text-[0.8125rem] font-medium text-foreground">Drop files to upload</span>
      <span className="mt-0.5 text-xs text-muted-foreground">
        or click to browse{prefix ? ` — saved under ${prefix}` : ''}
      </span>
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
    <section
      className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-card"
      aria-live="polite"
      aria-label="Upload progress"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-[0.8125rem] font-semibold text-foreground">Uploading</h3>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {slots.map((slot) => {
          const pct =
            slot.total > 0 ? Math.min(100, Math.round((slot.loaded / slot.total) * 100)) : 0;
          const label =
            slot.phase === 'storing'
              ? 'Storing…'
              : slot.phase === 'done'
                ? 'Stored'
                : slot.phase === 'failed'
                  ? 'Failed'
                  : `${pct}%`;
          const tone =
            slot.phase === 'failed' ? 'danger' : slot.phase === 'done' ? 'success' : 'primary';

          return (
            <li key={slot.id} className="px-4 py-2.5">
              <div className="mb-1.5 flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">
                  {slot.name}
                </span>
                <span
                  className={`shrink-0 text-xs tabular ${
                    slot.phase === 'failed' ? 'text-danger' : 'text-muted-foreground'
                  }`}
                >
                  {label}
                </span>
              </div>
              <Progress value={pct} tone={tone} />
              {slot.error ? <p className="mt-1.5 text-xs text-danger">{slot.error}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
