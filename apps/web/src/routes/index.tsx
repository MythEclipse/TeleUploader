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
    <div className="pb-16">
      <section className="bg-slate-100 border border-slate-200 rounded-xl p-8 mb-8 text-center bg-gradient-to-b from-slate-100 to-white">
        <h1 className="text-3xl font-bold text-slate-900 mb-3">TeleUploader Public File Explorer</h1>
        <p className="text-slate-600 max-w-lg mx-auto">
          Browse and download publicly shared files directly through Telegram storage.
          {auth.kind !== 'signed-in' ? (
            <>
              {' '}
              Want your own private S3 buckets and credentials?{' '}
              <AppLink to="/login" className="text-blue-600 font-semibold hover:underline">
                Sign in with Google
              </AppLink>
            </>
          ) : null}
        </p>
      </section>

      {error ? (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg" role="alert">
          {error}
        </div>
      ) : null}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="text-lg font-semibold text-slate-900">Public Files ({files.length})</h2>
        </div>

        {files.length === 0 && !query.isPending ? (
          <div className="p-12 text-center text-slate-500">No public files available.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 font-semibold">File Name</th>
                  <th className="px-4 py-3 font-semibold">Size</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {files.map((file) => (
                  <tr key={file.public_id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        {file.mime_type.startsWith('image/')
                          ? '🖼️'
                          : file.mime_type.startsWith('video/')
                            ? '🎬'
                            : file.mime_type.startsWith('audio/')
                              ? '🎵'
                              : '📄'}
                        <span className="font-medium text-slate-900 truncate max-w-xs" title={file.file_name}>
                          {file.file_name}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatSize(file.size_bytes)}</td>
                    <td className="px-4 py-3 text-slate-600">{file.file_type || file.mime_type}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDate(file.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <a
                          href={file.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                          download={file.file_name}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                          onClick={() => {
                            void navigator.clipboard.writeText(file.download_url);
                          }}
                          title="Copy direct download link"
                        >
                          Copy Link
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data?.next_cursor ? (
          <div className="px-4 py-4 border-t border-slate-200 bg-slate-50 text-center">
            <AppLink
              to={`/?cursor=${encodeURIComponent(data.next_cursor)}`}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-blue-700 bg-blue-100 hover:bg-blue-200 rounded-md transition-colors"
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
