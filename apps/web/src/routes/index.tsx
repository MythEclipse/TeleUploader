/** Public home — / — file showcase + public files table. */

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

  const error = query.error instanceof Error ? query.error.message : null;

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
                <AppLink to="/login" className="btn btn-primary">
                  Sign in with Google
                </AppLink>
              </>
            ) : null}
          </p>
        </div>
      </section>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Public Files ({files.length})</h2>
        </div>
        <div className="card-content">
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
                          className="btn btn-secondary btn-sm"
                          download={file.file_name}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
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
        </div>
        <div className="card-footer">
          {data?.next_cursor ? (
            <AppLink
              to={`/?cursor=${encodeURIComponent(data.next_cursor)}`}
              className="btn btn-primary"
            >
              Next Page →
            </AppLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Route;
