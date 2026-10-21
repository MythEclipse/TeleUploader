/**
 * Shared presentational primitives for the file manager.
 *
 * ## Why these moved out of `routes/index.tsx`
 *
 * They were defined inside the index route and imported BY the bucket route, which
 * worked but made the route file 1468 lines and coupled "the table component" to
 * "the `/` page". Under Kana's layering they are cross-route UI, so they belong in
 * `lib/` where both routes and any future one can reach them without importing a
 * route module (which the router plugin's tree then also imports, for no reason).
 *
 * Every component here is presentational: it takes data and callbacks and holds no
 * server state. The state that used to live in `useState` inside these components
 * moved to TanStack Query (server data) or a TanStack Store (local flags) — see the
 * note on each.
 *
 * ## Object keys are hostile input
 *
 * Every key rendered below is a React child or an attribute value set through JSX,
 * never a string interpolated into markup. That is the whole defence: React escapes
 * children, and `home.html`'s `textContent → innerHTML` "escaper" did not escape
 * quotes, which turned one apostrophe in a key into executable script.
 */

import { displayKey, displayPrefix, formatDate, formatSize } from './format';
import type { ObjectSummary } from './types';

// ── Notices ─────────────────────────────────────────────────────────────────

/** A banner message. `error` is styled and announced as an alert. */
export interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

/**
 * One dismissible message.
 *
 * `role="alert"` on the error arm only: a success notice announced assertively
 * interrupts a screen reader mid-sentence, while a failure genuinely is urgent.
 */
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
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button type="button" className="ghost" onClick={onDismiss} aria-label="Dismiss message">
        Dismiss
      </button>
    </p>
  );
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────

/**
 * The prefix trail: bucket → a/ → b/.
 *
 * `home.html` built this by string-concatenating `onclick` handlers around each
 * accumulated prefix, so a prefix containing an apostrophe broke out of the inline
 * handler. Here every segment is a `<button>` with a bound handler and a React text
 * child.
 *
 * @param bucket - The bucket name, always the first (non-link) crumb.
 * @param prefix - The current prefix; `''` renders nothing at all.
 * @param onNavigate - Called with the prefix to jump to.
 */
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

/** Props for {@link ObjectTable}. */
export interface ObjectTableProps {
  readonly objects: readonly ObjectSummary[];
  readonly prefixes: readonly string[];
  readonly prefix: string;
  readonly bucket: string;
  readonly canWrite: boolean;
  /** Key whose delete is in flight, so its row's button can show progress. */
  readonly pendingKey: string | null;
  /** Key whose share link was just copied, for the transient "Copied" label. */
  readonly copiedKey: string | null;
  readonly onEnterPrefix: (prefix: string) => void;
  readonly onDelete: (object: ObjectSummary) => void;
  readonly onCopyLink: (object: ObjectSummary) => void;
  /**
   * The absolute download URL for one key.
   *
   * Passed in rather than built here because the URL needs the organization slug,
   * and the download route is a plain navigation (the response is the file itself),
   * so it must be an `<a href>` and not a fetch. Keeping the builder at the call site
   * means this component has no opinion about routing.
   */
  readonly downloadHref: (object: ObjectSummary) => string;
}

/**
 * Folders first, then objects — each already ordered by the server.
 *
 * Folders are a distinct row type rather than a special object because the API
 * reports them in a separate `prefixes[]` array: they have no size and no
 * timestamp, and rendering them as objects would require inventing both.
 */
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
                  unanchored `replace` that mangled a key containing the prefix text
                  mid-name. */}
              <button type="button" className="folder-link" onClick={() => onEnterPrefix(folder)}>
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
                {/* The full key, as a text child. `home.html:314-317` put this same
                    untrusted string into inline handlers. */}
                <span className="object-key" title={object.key}>
                  {object.key}
                </span>
              </th>
              <td className="numeric">{formatSize(object.sizeBytes)}</td>
              <td className="muted">{formatDate(object.lastModified)}</td>
              <td className="actions-cell">
                <a
                  className="ghost button"
                  href={downloadHref(object)}
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

// ── Confirm dialog ──────────────────────────────────────────────────────────

/**
 * An accessible replacement for `confirm()`.
 *
 * ## Focus is moved to the confirm button on mount
 *
 * A modal that opens with focus still on the trigger is operable by keyboard only
 * if the user tabs forward into it, and Escape would reach the page behind. The
 * `ref` + `autoFocus`-free approach is deliberate: React's `autoFocus` on a button
 * inside a portal-less overlay does not always win against the browser's focus
 * restoration, so the ref assignment is the reliable form.
 *
 * ## No React hooks
 *
 * `useRef` and `useEffect` are both banned by Kana. The focus call happens in the
 * ref callback instead, which runs exactly once when the node is attached — the
 * same timing `useEffect(…, [])` provided, without a hook.
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
  return (
    <div className="modal-overlay">
      {/*
        The Escape handler lives on the DIALOG, not on the overlay. Biome's
        `noStaticElementInteractions` flagged `onKeyDown` on a plain `<div>` — correctly,
        because a static element is not focusable, so the key never reaches it. The fix
        is not a suppression: `role="dialog"` plus `tabIndex={-1}` makes this a real,
        focusable dialog surface, which is what a modal should have been anyway. The
        confirm button takes focus (see its ref), so a keystroke inside the dialog bubbles
        to here and Escape works for keyboard users.
      */}
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
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary danger"
            onClick={onConfirm}
            disabled={busy}
            ref={(node) => {
              // Runs when the node attaches, and again with `null` on unmount —
              // `?.` makes the second call a no-op.
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
