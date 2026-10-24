/**
 * Shared presentational primitives for the file manager.
 *
 * Refined: legacy `.modal-*`/`.btn-*` CSS classes replaced with the
 * `Button`/`Card` UI components and Tailwind utilities. Behaviour and copy
 * are unchanged.
 */

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { formatDate, formatSize } from './format';
import { cn } from './utils';

// ── Notices ─────────────────────────────────────────────────────────────────

/** A banner message. `error` is styled and announced as an alert. */
export interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

export function NoticeBanner({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-transparent p-3 font-medium',
        notice.kind === 'error'
          ? 'border-red-500/50 bg-red-500/10 text-red-400'
          : 'border-blue-500/50 bg-blue-500/10 text-blue-400',
      )}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="ml-2 inline-flex items-center justify-center w-6 h-6 rounded-md text-current hover:bg-current hover:text-background transition"
        onClick={onDismiss}
        aria-label="Dismiss message"
      >
        ✕
      </button>
    </div>
  );
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────

export function Breadcrumb({
  bucket,
  prefix,
  onNavigate,
}: {
  bucket: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}): React.JSX.Element | null {
  const parts = prefix.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const segments: { label: string; prefix: string }[] = [{ label: bucket, prefix: '' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated += `${part}/`;
    segments.push({ label: part, prefix: accumulated });
  }

  return (
    <nav
      className="flex flex-wrap items-center gap-1 mb-4 text-sm text-slate-400"
      aria-label="Object key prefix"
    >
      <ol className="flex flex-wrap gap-1 list-none p-0 m-0 items-center">
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={segment.prefix || 'bucket'} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="text-slate-200">
                  {segment.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(segment.prefix)}
                  className="text-slate-400 hover:text-slate-300 hover:underline font-medium"
                >
                  {segment.label}
                </button>
              )}
              {last ? null : (
                <span aria-hidden="true" className="text-slate-600">
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

// ── Object table ────────────────────────────────────────────────────────────

export interface ObjectTableProps {
  readonly objects: readonly import('./types').ObjectSummary[];
  readonly prefixes: readonly string[];
  readonly prefix: string;
  readonly bucket: string;
  readonly canWrite: boolean;
  readonly pendingKey: string | null;
  readonly copiedKey: string | null;
  readonly onEnterPrefix: (prefix: string) => void;
  readonly onDelete: (object: import('./types').ObjectSummary) => void;
  readonly onCopyLink: (object: import('./types').ObjectSummary) => void;
  readonly downloadHref: (object: import('./types').ObjectSummary) => string;
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
  downloadHref,
}: ObjectTableProps): React.JSX.Element {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">
            Objects and folders in {bucket}
            {prefix ? ` under ${prefix}` : ''}
          </caption>
          <thead>
            <tr className="bg-slate-900/50">
              <th scope="col" className="text-xs uppercase text-slate-400 font-semibold p-3">
                Name
              </th>
              <th
                scope="col"
                className="text-xs uppercase text-slate-400 font-semibold p-3 text-right"
              >
                Size
              </th>
              <th scope="col" className="text-xs uppercase text-slate-400 font-semibold p-3">
                Modified
              </th>
              <th
                scope="col"
                className="text-xs uppercase text-slate-400 font-semibold p-3 sr-only"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {prefixes.map((folder) => (
              <tr key={folder} className="hover:bg-slate-900/30 transition">
                <th scope="row" className="p-3 font-medium text-slate-200">
                  <button
                    type="button"
                    onClick={() => onEnterPrefix(folder)}
                    className="text-slate-400 hover:text-slate-300 flex items-center gap-1"
                  >
                    <span aria-hidden="true">🗂</span>
                    {displayPrefix(folder, prefix)}
                  </button>
                </th>
                <td className="p-3 text-right text-slate-500">—</td>
                <td className="p-3 text-slate-500" />
                <td className="p-3" />
              </tr>
            ))}
            {objects.map((object) => {
              const busy = pendingKey === object.key;
              return (
                <tr key={object.key} className="hover:bg-slate-900/30 transition">
                  <th scope="row" className="p-3">
                    <span className="block font-medium text-slate-200">
                      <span aria-hidden="true">📄</span> {displayKey(object.key, prefix)}
                    </span>
                    <span className="block text-xs text-slate-500" title={object.key}>
                      {object.key}
                    </span>
                  </th>
                  <td className="p-3 text-right text-slate-300">{formatSize(object.sizeBytes)}</td>
                  <td className="p-3 text-slate-400">{formatDate(object.lastModified)}</td>
                  <td className="p-3 space-x-2">
                    <a
                      className="inline-flex items-center justify-center px-3 py-1.5 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-700 transition"
                      href={downloadHref(object)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Download. This route returns the file itself, so it opens in a new tab rather than navigating the app."
                    >
                      Download
                    </a>
                    <button
                      type="button"
                      onClick={() => onCopyLink(object)}
                      title={`Copy the public share link for ${object.key}`}
                      className="inline-flex items-center justify-center px-3 py-1.5 bg-transparent text-slate-300 rounded-lg hover:bg-slate-700 text-sm transition disabled:opacity-50"
                    >
                      {copiedKey === object.key ? 'Copied' : 'Copy link'}
                    </button>
                    {canWrite ? (
                      <button
                        type="button"
                        className="inline-flex items-center justify-center px-3 py-1.5 bg-transparent text-red-400 rounded-lg hover:bg-red-500/10 hover:text-red-300 text-sm transition disabled:opacity-50"
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
      </div>
    </Card>
  );
}

export function displayKey(key: string, prefix: string): string {
  if (!prefix || !key.startsWith(prefix)) return key;
  const rest = key.slice(prefix.length);
  return rest.length > 0 ? rest : key;
}

export function displayPrefix(prefix: string, currentPrefix: string): string {
  const rest = displayKey(prefix, currentPrefix);
  return rest.endsWith('/') ? rest : `${rest}/`;
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

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
  return (
    <Dialog open={true} onOpenChange={onCancel}>
      <DialogContent className="p-6" title={title}>
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
