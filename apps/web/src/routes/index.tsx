/** Public home — / — file showcase + public files table. */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Copy, Download, Files, ShieldCheck, Zap } from 'lucide-react';
import { useAuthState } from '../lib/auth-store';
import { FileTypeIcon } from '../lib/components';
import { formatDate, formatSize } from '../lib/format';
import { publicFilesQuery } from '../lib/queries';
import { QuickUpload } from '../lib/quick-upload';

export interface HomeSearch {
  cursor?: string;
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
  }),

  beforeLoad: async ({ context, search }) => {
    await context.queryClient.ensureQueryData(publicFilesQuery(search.cursor));
  },

  component: PublicHomeRoute,
});

function PublicHomeRoute(): React.JSX.Element {
  const { cursor } = Route.useSearch();
  const auth = useAuthState();
  const query = useQuery(publicFilesQuery(cursor));
  const data = query.data;
  const files = data?.files ?? [];

  const error = query.error instanceof Error ? query.error.message : null;
  const signedOut = auth.kind !== 'signed-in';

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <section className="relative isolate overflow-hidden border-b border-border py-14 sm:py-20">
        <div className="absolute inset-0 -z-10 bg-grid opacity-40" aria-hidden="true" />

        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-card">
            <ShieldCheck className="size-3 text-primary" aria-hidden="true" />
            Files served straight from Telegram storage
          </span>

          <h1 className="mt-4 text-3xl font-bold tracking-tight text-gradient sm:text-4xl">
            Public file explorer
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-[0.9375rem] leading-relaxed text-muted-foreground">
            Browse and download files shared publicly through this deployment. Every file is
            addressable by a direct link — no account needed.
          </p>

          <QuickUpload />

          {signedOut ? (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Link
                to="/login"
                search={{ redirect: '' }}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-surface-hover"
              >
                Sign in with Google
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <span className="text-[0.8125rem] text-muted-foreground">
                to get private buckets and S3 credentials
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {error ? (
        <div
          className="mt-8 rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <section aria-labelledby="public-files-heading" className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="public-files-heading"
            className="flex items-center gap-2 text-[0.9375rem] font-semibold text-foreground"
          >
            <Files className="size-4 text-subtle-foreground" aria-hidden="true" />
            Public files
          </h2>
          <span className="text-[0.8125rem] text-muted-foreground">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          {query.isPending ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3 px-1 py-2.5">
                  <div className="size-8 animate-pulse rounded-lg bg-surface-hover" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-surface-hover" />
                  <div className="ml-auto h-3 w-16 animate-pulse rounded bg-surface-hover" />
                </div>
              ))}
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
              <div className="mb-3 flex size-11 items-center justify-center rounded-full border border-border bg-surface-muted text-subtle-foreground">
                <Files className="size-5" aria-hidden="true" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">No public files yet</h3>
              <p className="mt-1 max-w-sm text-[0.8125rem] text-muted-foreground">
                Nothing has been shared publicly on this deployment.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Publicly shared files</caption>
                <thead className="bg-surface-muted/70">
                  <tr>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Name
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Size
                    </th>
                    <th
                      scope="col"
                      className="hidden px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground sm:table-cell"
                    >
                      Type
                    </th>
                    <th
                      scope="col"
                      className="hidden px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground sm:table-cell"
                    >
                      Shared
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {files.map((file) => (
                    <tr
                      key={file.public_id}
                      className="transition-colors hover:bg-surface-hover/60"
                    >
                      <td className="max-w-0 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <FileTypeIcon mimeType={file.mime_type} />
                          <span
                            className="truncate font-medium text-foreground"
                            title={file.file_name}
                          >
                            {file.file_name}
                          </span>
                        </div>
                      </td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-right text-muted-foreground">
                        {formatSize(file.size_bytes)}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground sm:table-cell">
                        {file.file_type || file.mime_type}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground sm:table-cell">
                        {formatDate(file.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(file.download_url);
                            }}
                            aria-label={`Copy link for ${file.file_name}`}
                            title="Copy direct link"
                            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                          >
                            <Copy className="size-3.5" aria-hidden="true" />
                          </button>
                          <a
                            href={file.download_url}
                            target="_blank"
                            rel="noreferrer"
                            download={file.file_name}
                            aria-label={`Download ${file.file_name}`}
                            title="Download"
                            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                          >
                            <Download className="size-3.5" aria-hidden="true" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data?.next_cursor ? (
            <div className="flex justify-end border-t border-border bg-surface-muted/60 px-4 py-3">
              <Link
                to="/"
                search={{ cursor: data.next_cursor }}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-surface-hover"
              >
                Next page
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          ) : null}
        </div>
      </section>

      {signedOut ? (
        <section className="mt-10 grid gap-3 sm:grid-cols-3">
          {[
            {
              icon: ShieldCheck,
              title: 'Private by default',
              body: 'Each workspace gets its own buckets and its own keys.',
            },
            {
              icon: Zap,
              title: 'S3-compatible',
              body: 'Point aws-cli, rclone or a registry client straight at it.',
            },
            {
              icon: Files,
              title: 'Direct links',
              body: 'Every file has a stable URL you can share or script against.',
            },
          ].map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-border bg-surface p-4 shadow-card"
            >
              <item.icon className="size-4 text-primary" aria-hidden="true" />
              <h3 className="mt-2 text-[0.8125rem] font-semibold text-foreground">{item.title}</h3>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
                {item.body}
              </p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export default Route;
