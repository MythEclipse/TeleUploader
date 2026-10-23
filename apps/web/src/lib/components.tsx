/**
 * Shared presentational primitives for the file manager.
 */

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
    <p
      className={cn('notice-banner', notice.kind)}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button type="button" className="btn-ghost" onClick={onDismiss} aria-label="Dismiss message">
        Dismiss
      </button>
    </p>
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
    <div className="panel">
      <div className="table-responsive">
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
                    <span className="object-key" title={object.key}>
                      {object.key}
                    </span>
                  </th>
                  <td className="numeric">{formatSize(object.sizeBytes)}</td>
                  <td className="muted">{formatDate(object.lastModified)}</td>
                  <td className="actions-cell">
                    <a
                      className="btn-secondary"
                      href={downloadHref(object)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Download. This route returns the file itself, so it opens in a new tab rather than navigating the app."
                    >
                      Download
                    </a>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => onCopyLink(object)}
                      title={`Copy the public share link for ${object.key}`}
                    >
                      {copiedKey === object.key ? 'Copied' : 'Copy link'}
                    </button>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn-ghost danger"
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
    </div>
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
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      >
        <h3>{title}</h3>
        {children}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary danger"
            onClick={onConfirm}
            disabled={busy}
            ref={(node) => {
              node?.focus();
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
