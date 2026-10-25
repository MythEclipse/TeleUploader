/**
 * Quick upload — the public homepage's unauthenticated upload surface.
 *
 * ## What this talks to
 *
 * `POST /api/upload`, the deployment's public data plane. No session, no
 * bucket, no tenant: the file lands in the shared public listing and gets a
 * `/f/:public_id` link. This is a different contract from the dashboard's
 * bucket upload, which is why it calls `uploadPublicFile` rather than
 * `uploadObject`.
 *
 * ## Why a TanStack Store and not component state
 *
 * The project bans React state hooks. Progress arrives from an XHR callback
 * several times a second, so the state also has to be readable from that
 * callback without a stale closure — a module-level store gives the callback a
 * stable `setState` and re-renders only the subscribers.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import {
  Check,
  ChevronDown,
  CloudUpload,
  Copy,
  Link2,
  Loader2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/primitive';
import { ApiError, type PublicUploadResult, uploadPublicFile } from './client';
import { formatSize } from './format';

/** One in-flight or finished upload. */
interface Slot {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly loaded: number;
  readonly phase: 'sending' | 'storing' | 'done' | 'failed';
  readonly error: string | null;
  readonly result: PublicUploadResult | null;
}

interface QuickUploadState {
  readonly open: boolean;
  readonly dragging: boolean;
  readonly slots: readonly Slot[];
  readonly copiedId: string | null;
}

const store = new Store<QuickUploadState>({
  open: false,
  dragging: false,
  slots: [],
  copiedId: null,
});

/**
 * Abort handles for in-flight uploads, keyed by slot id.
 *
 * Deliberately outside the store: an `AbortController` is not render data, and
 * putting it in state would make every progress tick produce a new store object
 * holding the same controller.
 */
const controllers = new Map<string, AbortController>();

const patch = (change: Partial<QuickUploadState>): void => {
  store.setState((state) => ({ ...state, ...change }));
};

/** One file per call: the endpoint accepts a single `file` field. */
const uploadOne = async (
  file: File,
  id: string,
  signal: AbortSignal,
): Promise<PublicUploadResult | null> => {
  const patchSlot = (change: Partial<Slot>): void => {
    patch({
      slots: store.state.slots.map((slot) => (slot.id === id ? { ...slot, ...change } : slot)),
    });
  };

  try {
    const result = await uploadPublicFile({
      file,
      signal,
      onProgress: (loaded, total) => {
        if (!Number.isFinite(total) || total <= 0) return;
        patchSlot({ loaded, phase: loaded >= total ? 'storing' : 'sending' });
      },
    });
    patchSlot({ phase: 'done', loaded: file.size, result, error: null });
    return result;
  } catch (error) {
    // `uploadPublicFile` reports a user-triggered abort as ApiError(0, "cancelled"),
    // so the message is what distinguishes it from a real network failure.
    const cancelled = error instanceof ApiError && error.message.toLowerCase().includes('cancel');
    patchSlot({
      phase: 'failed',
      error: cancelled ? 'Cancelled.' : messageOf(error),
    });
    return null;
  }
};

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message || 'Upload failed';
  return 'Upload failed';
};

/**
 * Extracts the dropped files from a transfer.
 *
 * Reads `files` first and falls back to `items`, because some environments
 * (synthetic drag events, certain Linux file managers, and Safari with
 * `webkitGetAsEntry`) populate `items` while leaving `files` empty. Reading only
 * `files` silently drops the drop.
 */
const filesFromTransfer = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return [];

  const fromFiles = Array.from(transfer.files ?? []);
  if (fromFiles.length > 0) return fromFiles;

  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
};

/**
 * Opens the hidden file picker.
 *
 * A plain DOM lookup instead of a ref: this project bans React hooks including
 * `useRef`, and the input is a singleton inside this panel.
 */
const pickFile = (): void => {
  const input = document.getElementById('quick-upload-input');
  if (input instanceof HTMLInputElement) input.click();
};

/**
 * The public upload panel.
 *
 * Renders a disclosure in the hero. Collapsed by default so the page still
 * reads as a file listing first; opening it reveals a drop target and a file
 * picker that both feed the same queue.
 */
export function QuickUpload(): React.JSX.Element {
  const queryClient = useQueryClient();
  const open = useSelector(store, (state) => state.open);
  const dragging = useSelector(store, (state) => state.dragging);
  const slots = useSelector(store, (state) => state.slots);
  const copiedId = useSelector(store, (state) => state.copiedId);

  const active = slots.some((slot) => slot.phase === 'sending' || slot.phase === 'storing');

  const start = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;

    const newSlots: Slot[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      size: file.size,
      loaded: 0,
      phase: 'sending',
      error: null,
      result: null,
    }));
    patch({ slots: [...store.state.slots, ...newSlots], open: true });

    // Sequential, not parallel: the endpoint writes to one Telegram chat, and
    // concurrent multi-hundred-MB streams make per-file progress meaningless.
    for (const [index, file] of files.entries()) {
      const slot = newSlots[index];
      if (slot === undefined) continue;
      const controller = new AbortController();
      controllers.set(slot.id, controller);
      await uploadOne(file, slot.id, controller.signal);
      controllers.delete(slot.id);
    }

    await queryClient.invalidateQueries({ queryKey: ['public-files'] });
  };

  const copyLink = async (slot: Slot): Promise<void> => {
    if (!slot.result) return;
    try {
      await navigator.clipboard.writeText(slot.result.download_url);
      patch({ copiedId: slot.id });
    } catch {
      patch({ copiedId: null });
    }
  };

  return (
    <section
      aria-label="Quick upload"
      className="mx-auto mt-6 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface text-left shadow-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => patch({ open: !open })}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface-hover/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Upload className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.8125rem] font-semibold text-foreground">Quick upload</span>
          <span className="block text-xs text-muted-foreground">
            No account needed — files go to the public listing and get a shareable link.
          </span>
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-subtle-foreground transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="border-t border-border p-4">
          {/* A real <button> for the click path; the hidden input lives outside it,
              because an <input> inside a <button> is invalid HTML and steals the
              click. Drop handling sits on the button so the whole target is live. */}
          <input
            id="quick-upload-input"
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => {
              const picked = event.target.files ? Array.from(event.target.files) : [];
              if (picked.length > 0) void start(picked);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Drop a file here, or choose one"
            onDragOver={(event) => {
              event.preventDefault();
              patch({ dragging: true });
            }}
            onDragLeave={() => patch({ dragging: false })}
            onDrop={(event) => {
              event.preventDefault();
              // Read the files BEFORE touching state: `dataTransfer` is only valid
              // during dispatch, and React recycles the synthetic event.
              const dropped = filesFromTransfer(event.dataTransfer);
              patch({ dragging: false });
              if (dropped.length > 0) void start(dropped);
            }}
            onClick={pickFile}
            className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${
              dragging
                ? 'border-primary bg-primary-soft'
                : 'border-border-strong hover:border-primary/60 hover:bg-surface-hover/50'
            }`}
          >
            <CloudUpload
              className={`mb-2 size-6 ${dragging ? 'text-primary' : 'text-subtle-foreground'}`}
              aria-hidden="true"
            />
            <span className="text-[0.8125rem] font-medium text-foreground">Drop a file here</span>
            <span className="mt-0.5 text-xs text-muted-foreground">or click to choose one</span>
          </button>

          {slots.length > 0 ? (
            <ul className="mt-3 space-y-2" aria-live="polite">
              {slots.map((slot) => {
                const pct =
                  slot.size > 0 ? Math.min(100, Math.round((slot.loaded / slot.size) * 100)) : 0;
                const done = slot.phase === 'done';
                const failed = slot.phase === 'failed';
                const copied = copiedId === slot.id;

                return (
                  <li
                    key={slot.id}
                    className="rounded-lg border border-border bg-surface-muted/50 px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      {done ? (
                        <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                      ) : failed ? (
                        <TriangleAlert
                          className="size-3.5 shrink-0 text-danger"
                          aria-hidden="true"
                        />
                      ) : (
                        <Loader2
                          className="size-3.5 shrink-0 animate-spin text-primary"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">
                        {slot.name}
                      </span>
                      <span className="shrink-0 text-xs text-subtle-foreground tabular">
                        {formatSize(slot.size)}
                      </span>
                    </div>

                    {done || failed ? null : (
                      <Progress
                        className="mt-2"
                        value={pct}
                        tone={slot.phase === 'storing' ? 'success' : 'primary'}
                      />
                    )}

                    {failed && slot.error ? (
                      <p className="mt-1.5 text-xs text-danger">{slot.error}</p>
                    ) : null}

                    {done || failed ? null : (
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground tabular">
                          {slot.phase === 'storing' ? 'Storing…' : `${pct}%`}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => controllers.get(slot.id)?.abort()}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}

                    {done && slot.result ? (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <a
                          href={slot.result.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          <Link2 className="size-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">{slot.result.download_url}</span>
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto h-7 px-2 text-xs"
                          icon={copied ? <Check /> : <Copy />}
                          onClick={() => void copyLink(slot)}
                        >
                          {copied ? 'Copied' : 'Copy link'}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="mt-3 flex items-start justify-between gap-3">
            <p className="text-xs leading-relaxed text-subtle-foreground">
              Anyone with the link can download it. Photos up to 10 MB, other files up to 2 GB.
            </p>
            {slots.length > 0 && !active ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<X />}
                className="shrink-0"
                onClick={() => patch({ slots: [], copiedId: null })}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
