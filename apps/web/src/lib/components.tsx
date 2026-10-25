/**
 * Shared presentational primitives for the file manager.
 *
 * Every colour here resolves through a semantic token from `index.css`, so the
 * same markup is correct in light and dark. Icons come from `lucide-react`
 * rather than emoji: emoji render differently on every OS and carry no stroke
 * weight that matches the type.
 */

import {
  Check,
  Copy,
  Download,
  FileArchive,
  FileAudio,
  FileCode,
  type File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent } from '../components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from '../components/ui/table';
import { formatDate, formatSize } from './format';
import type { ObjectSummary } from './types';
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
  const isError = notice.kind === 'error';

  return (
    <div
      className={cn(
        'mb-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[0.8125rem]',
        isError
          ? 'border-danger/35 bg-danger-soft text-danger'
          : 'border-success/35 bg-success-soft text-success',
      )}
      role={isError ? 'alert' : 'status'}
    >
      {isError ? (
        <TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Check className="mt-px size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 break-words">{notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="-my-1 -mr-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full border border-border bg-surface-muted text-subtle-foreground">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-[0.8125rem] text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
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
    <nav aria-label="Object key prefix" className="mb-3">
      <ol className="flex flex-wrap items-center gap-0.5 text-[0.8125rem]">
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={segment.prefix || 'bucket'} className="flex items-center gap-0.5">
              {last ? (
                <span aria-current="page" className="px-1.5 py-1 font-medium text-foreground">
                  {segment.label}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onNavigate(segment.prefix)}
                    className="rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    {segment.label}
                  </button>
                  <span aria-hidden="true" className="text-subtle-foreground">
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── File type icon ──────────────────────────────────────────────────────────

const ICON_BY_PREFIX: readonly { match: string; icon: typeof FileIcon; tone: string }[] = [
  { match: 'image/', icon: FileImage, tone: 'text-[oklch(0.62_0.16_300)]' },
  { match: 'video/', icon: FileVideo, tone: 'text-[oklch(0.62_0.17_20)]' },
  { match: 'audio/', icon: FileAudio, tone: 'text-[oklch(0.64_0.14_330)]' },
  { match: 'text/csv', icon: FileSpreadsheet, tone: 'text-[oklch(0.6_0.13_155)]' },
  { match: 'application/pdf', icon: FileText, tone: 'text-[oklch(0.6_0.18_25)]' },
  { match: 'application/zip', icon: FileArchive, tone: 'text-[oklch(0.64_0.13_75)]' },
  { match: 'application/json', icon: FileCode, tone: 'text-[oklch(0.62_0.14_200)]' },
];

/** A tinted file glyph chosen from the MIME type, so rows scan by type. */
export function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}): React.JSX.Element {
  const match = ICON_BY_PREFIX.find((entry) => mimeType.startsWith(entry.match));
  const Icon = match?.icon ?? FileText;

  return (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted',
        className,
      )}
      aria-hidden="true"
    >
      <Icon className={cn('size-4', match?.tone ?? 'text-muted-foreground')} />
    </span>
  );
}

// ── Object table ────────────────────────────────────────────────────────────

export interface ObjectTableProps {
  readonly objects: readonly ObjectSummary[];
  readonly prefixes: readonly string[];
  readonly prefix: string;
  readonly bucket: string;
  readonly canWrite: boolean;
  readonly pendingKey: string | null;
  readonly copiedKey: string | null;
  readonly onEnterPrefix: (prefix: string) => void;
  readonly onDelete: (object: ObjectSummary) => void;
  readonly onCopyLink: (object: ObjectSummary) => void;
  readonly downloadHref: (object: ObjectSummary) => string;
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
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <TableWrap>
        <Table>
          <caption className="sr-only">
            Objects and folders in {bucket}
            {prefix ? ` under ${prefix}` : ''}
          </caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="hidden sm:table-cell">Modified</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prefixes.map((folder) => (
              <TableRow key={folder}>
                <TableCell colSpan={1} className="p-0">
                  <button
                    type="button"
                    onClick={() => onEnterPrefix(folder)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:text-foreground"
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted"
                      aria-hidden="true"
                    >
                      <Folder className="size-4 text-primary" />
                    </span>
                    <span className="truncate font-medium text-foreground">
                      {displayPrefix(folder, prefix)}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-right text-subtle-foreground">—</TableCell>
                <TableCell className="hidden text-subtle-foreground sm:table-cell">—</TableCell>
                <TableCell />
              </TableRow>
            ))}

            {objects.map((object) => {
              const busy = pendingKey === object.key;
              const copied = copiedKey === object.key;

              return (
                <TableRow key={object.key}>
                  <TableCell className="max-w-0">
                    <div className="flex items-center gap-3">
                      <FileTypeIcon mimeType={object.mimeType} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground" title={object.key}>
                          {displayKey(object.key, prefix)}
                        </p>
                        <p
                          className="truncate font-mono text-[0.6875rem] text-subtle-foreground"
                          title={object.key}
                        >
                          {object.key}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-right">
                    {formatSize(object.sizeBytes)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">
                    {formatDate(object.lastModified)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="iconSm"
                        onClick={() => onCopyLink(object)}
                        aria-label={copied ? 'Link copied' : `Copy link for ${object.fileName}`}
                        title={copied ? 'Copied' : 'Copy public share link'}
                        className={copied ? 'text-success' : undefined}
                        icon={copied ? <Check /> : <Copy />}
                      />
                      <a
                        href={downloadHref(object)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Download"
                        aria-label={`Download ${object.fileName}`}
                        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                      </a>
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="iconSm"
                          disabled={busy}
                          onClick={() => onDelete(object)}
                          aria-label={`Delete ${object.fileName}`}
                          title="Delete"
                          className="hover:bg-danger-soft hover:text-danger"
                          icon={<Trash2 />}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableWrap>
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
  description,
  confirmLabel,
  busy,
  tone = 'danger',
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  busy: boolean;
  tone?: 'danger' | 'primary';
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <Dialog open={true} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              size="sm"
              onClick={onConfirm}
              disabled={busy}
              autoFocus
            >
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
