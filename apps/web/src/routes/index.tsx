/** Public home — / — file showcase + public files table. */

import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useAuthState } from '../lib/auth-store';
import { formatDate, formatSize } from '../lib/format';
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
    <div className="p-5">
      <section className="max-w-4xl mx-auto mb-8 text-center">
        <h1 className="text-3xl font-bold mb-2">TeleUploader Public File Explorer</h1>
        <p className="text-slate-400 max-w-2xl mx-auto">
          Browse and download publicly shared files directly through Telegram storage.
          {auth.kind !== 'signed-in' ? (
            <div className="mt-4">
              Want your own private S3 buckets and credentials?{' '}
              <a href="/login" className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                Sign in with Google
              </a>
            </div>
          ) : null}
        </p>
      </section>

      {error ? (
        <div className="max-w-4xl mx-auto mb-4 p-4 bg-red-500/10 border border-red-500 text-red-500 rounded-lg" role="alert">
          {error}
        </div>
      ) : null}

      <div className="max-w-4xl mx-auto bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-700 bg-slate-900/50">
          <h2 className="font-semibold">Public Files ({files.length})</h2>
        </div>
        <div className="p-4">
          {files.length === 0 && !query.isPending ? (
            <div className="py-12 text-center text-slate-400">
              No public files available.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-slate-900/50">
                    <th className="text-left text-xs uppercase text-slate-400 font-semibold p-3">File Name</th>
                    <th className="text-left text-xs uppercase text-slate-400 font-semibold p-3">Size</th>
                    <th className="text-left text-xs uppercase text-slate-400 font-semibold p-3">Type</th>
                    <th className="text-left text-xs uppercase text-slate-400 font-semibold p-3">Date</th>
                    <th className="text-left text-xs uppercase text-slate-400 font-semibold p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.public_id} className="hover:bg-slate-900/30 transition">
                      <td className="p-3">
                        <span className="mr-2">{file.mime_type.startsWith('image/') ? '🖼️' : file.mime_type.startsWith('video/') ? '🎬' : file.mime_type.startsWith('audio/') ? '🎵' : '📄'}</span>
                        <span className="font-medium break-all" title={file.file_name}>{file.file_name}</span>
                      </td>
                      <td className="p-3">{formatSize(file.size_bytes)}</td>
                      <td className="p-3">{file.file_type || file.mime_type}</td>
                      <td className="p-3">{formatDate(file.created_at)}</td>
                      <td className="p-3 space-x-2">
                        <a
                          href={file.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center justify-center px-3 py-1.5 bg-slate-700 text-white rounded-lg hover:bg-slate-600 text-sm transition"
                          download={file.file_name}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center px-3 py-1.5 bg-transparent text-slate-300 rounded-lg hover:bg-slate-700 text-sm transition"
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
        <div className="p-3 border-t border-slate-700 bg-slate-900/50 flex justify-end">
          {data?.next_cursor ? (
            <a
              href={`/?cursor=${encodeURIComponent(data.next_cursor)}`}
              className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              Next Page →
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Route;
