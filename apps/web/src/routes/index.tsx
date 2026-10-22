/**
 * `/` — The Public Home & File Showcase.
 *
 * ## What this page is
 *
 * 1. An open, unauthenticated public view showing all files shared on TeleUploader.
 * 2. Anyone can search and download public files without needing an account.
 * 3. Shows prominent action controls in the topbar and hero section allowing users
 *    to sign in with Google to enter their own isolated, private S3 workspace.
 */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useAuthState } from '../lib/auth-store';
import { formatDate, formatSize } from '../lib/format';
import { AppLink } from '../lib/layout/AppLink';
import { publicFilesQuery } from '../lib/queries';

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

  return (
    <div className="browser-page public-home">
      <section className="public-hero">
        <div className="hero-content">
          <h1>TeleUploader Public File Explorer</h1>
          <p className="hero-description">
            Browse and download publicly shared files directly through Telegram storage.
            {auth.kind !== 'signed-in' ? (
              <>
                {' '}
                Want your own private S3 buckets and credentials?{' '}
                <AppLink href="/login" className="hero-cta-link">
                  Sign in with Google
                </AppLink>
              </>
            ) : null}
          </p>
        </div>
      </section>

      {query.isError ? (
        <p className="error-banner" role="alert">
          {query.error instanceof Error ? query.error.message : 'Failed to load public files'}
        </p>
      ) : null}

      <div className="panel file-list-panel">
        <div className="panel-header">
          <h2>Public Files ({files.length})</h2>
        </div>

        {files.length === 0 && !query.isPending ? (
          <div className="empty-state">
            <p>No public files available.</p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="file-table">
              <thead>
                <tr>
                  <th scope="col" className="name-col">
                    File Name
                  </th>
                  <th scope="col" className="size-col">
                    Size
                  </th>
                  <th scope="col" className="type-col">
                    Type
                  </th>
                  <th scope="col" className="date-col">
                    Date
                  </th>
                  <th scope="col" className="actions-col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.public_id} className="file-row">
                    <td className="name-cell" title={file.file_name}>
                      <span className="file-icon" aria-hidden="true">
                        {file.mime_type.startsWith('image/')
                          ? '🖼️'
                          : file.mime_type.startsWith('video/')
                            ? '🎬'
                            : file.mime_type.startsWith('audio/')
                              ? '🎵'
                              : '📄'}
                      </span>
                      <span className="file-name-text">{file.file_name}</span>
                    </td>
                    <td className="size-cell">{formatSize(file.size_bytes)}</td>
                    <td className="type-cell">{file.file_type || file.mime_type}</td>
                    <td className="date-cell">{formatDate(file.created_at)}</td>
                    <td className="actions-cell">
                      <a
                        href={file.download_url}
                        target="_blank"
                        rel="noreferrer"
                        className="button small"
                        download={file.file_name}
                      >
                        Download
                      </a>
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => {
                          void navigator.clipboard.writeText(file.download_url);
                        }}
                        title="Copy direct download link"
                      >
                        Copy Link
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data?.next_cursor ? (
          <div className="pagination-bar">
            <AppLink
              href={`/?cursor=${encodeURIComponent(data.next_cursor)}`}
              className="button secondary"
            >
              Next Page →
            </AppLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Route;
