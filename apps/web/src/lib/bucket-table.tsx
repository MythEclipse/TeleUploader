/** The bucket list, with create and delete. */

import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { api } from './api';
import { ConfirmDialog, type Notice, NoticeBanner } from './components';
import { formatDate } from './format';
import { keys } from './query-keys';
import type { BucketSummary } from './types';

interface BucketUiState {
  readonly notice: Notice | null;
  readonly confirming: BucketSummary | null;
  readonly pending: string | null;
}

const bucketStore = new Store<BucketUiState>({ notice: null, confirming: null, pending: null });

const patchBucketUi = (change: Partial<BucketUiState>): void => {
  bucketStore.setState((state) => ({ ...state, ...change }));
};

export interface BucketTableProps {
  readonly buckets: readonly BucketSummary[];
  readonly orgSlug: string;
  readonly canWrite: boolean;
  readonly onOpen: (name: string) => void;
}

export function BucketTable({
  buckets,
  orgSlug,
  canWrite,
  onOpen,
}: BucketTableProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const notice = useSelector(bucketStore, (state) => state.notice);
  const confirming = useSelector(bucketStore, (state) => state.confirming);
  const pending = useSelector(bucketStore, (state) => state.pending);

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.bucketList(orgSlug) }),
      queryClient.invalidateQueries({ queryKey: keys.storageUsage(orgSlug) }),
    ]);
  };

  const deleteMutation = useMutation({
    mutationFn: async (bucket: BucketSummary) => {
      patchBucketUi({ pending: bucket.name });
      await api.deleteBucket(bucket.name);
      return bucket.name;
    },
    onSuccess: (name) => {
      patchBucketUi({
        confirming: null,
        pending: null,
        notice: { kind: 'ok', text: `Deleted bucket "${name}".` },
      });
    },
    onError: (error, bucket) => {
      patchBucketUi({
        confirming: null,
        pending: null,
        notice: {
          kind: 'error',
          text: isConflict(error)
            ? `"${bucket.name}" still contains objects. Delete them first.`
            : `Could not delete "${bucket.name}": ${messageOf(error)}`,
        },
      });
    },
    onSettled: () => {
      void invalidate();
    },
  });

  return (
    <div className="px-5 py-4">
      {notice ? (
        <NoticeBanner notice={notice} onDismiss={() => patchBucketUi({ notice: null })} />
      ) : null}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-200">Buckets</h2>
        {canWrite ? <CreateBucketButton orgSlug={orgSlug} onCreated={onOpen} /> : null}
      </div>

      {buckets.length === 0 ? (
        <div className="py-12 text-center text-slate-400">
          <h2 className="text-lg text-slate-300 mb-2">No buckets yet</h2>
          <p>
            {canWrite ? 'Use "New bucket" above to create one.' : 'Sign in to create a bucket.'}
          </p>
        </div>
      ) : (
        <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <caption className="sr-only">Buckets in this workspace</caption>
              <thead>
                <tr className="bg-slate-900/50">
                  <th
                    scope="col"
                    className="text-left text-xs uppercase text-slate-400 font-semibold p-3"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    className="text-right text-xs uppercase text-slate-400 font-semibold p-3"
                  >
                    Objects
                  </th>
                  <th
                    scope="col"
                    className="text-left text-xs uppercase text-slate-400 font-semibold p-3"
                  >
                    Created
                  </th>
                  <th
                    scope="col"
                    className="text-left text-xs uppercase text-slate-400 font-semibold p-3"
                  >
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {buckets.map((bucket) => (
                  <tr key={bucket.id} className="hover:bg-slate-900/30 transition">
                    <th scope="row" className="p-3">
                      <button
                        type="button"
                        className="font-medium text-blue-400 hover:text-blue-300"
                        onClick={() => onOpen(bucket.name)}
                      >
                        {bucket.name}
                      </button>
                    </th>
                    <td className="p-3 text-right text-slate-300">{bucket.objectCount}</td>
                    <td className="p-3 text-slate-500">{formatDate(bucket.createdAt)}</td>
                    <td className="p-3 space-x-2">
                      <button
                        type="button"
                        className="text-slate-400 hover:text-slate-200 px-2 py-1 text-sm"
                        onClick={() => onOpen(bucket.name)}
                      >
                        Open
                      </button>
                      {canWrite ? (
                        <button
                          type="button"
                          className="text-red-400 hover:text-red-300 px-2 py-1 text-sm disabled:opacity-50"
                          disabled={pending === bucket.name}
                          onClick={() => patchBucketUi({ confirming: bucket })}
                        >
                          {pending === bucket.name ? 'Working…' : 'Delete'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirming ? (
        <ConfirmDialog
          title="Delete bucket"
          confirmLabel="Delete bucket"
          busy={pending === confirming.name}
          onCancel={() => patchBucketUi({ confirming: null })}
          onConfirm={() => deleteMutation.mutate(confirming)}
        >
          <p className="text-slate-200">
            Delete the bucket <strong className="text-slate-100">{confirming.name}</strong>? This
            cannot be undone. The server refuses if it still contains objects.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function CreateBucketButton({
  orgSlug,
  onCreated,
}: {
  orgSlug: string;
  onCreated: (name: string) => void;
}): React.JSX.Element {
  const open = useSelector(dialogOpenStore, (value) => value);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const created = await api.createBucket(name);
      return created.name;
    },
    onSuccess: async (name) => {
      await queryClient.invalidateQueries({ queryKey: keys.bucketList(orgSlug) });
      dialogOpenStore.setState(() => false);
      onCreated(name);
    },
  });

  const form = useForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      const trimmed = value.name.trim();
      if (!trimmed) return;
      await createMutation.mutateAsync(trimmed).catch(() => undefined);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        className="inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
        onClick={() => dialogOpenStore.setState(() => true)}
      >
        New bucket
      </button>
    );
  }

  return (
    <ConfirmDialog
      title="Create bucket"
      confirmLabel="Create"
      busy={createMutation.isPending}
      onCancel={() => dialogOpenStore.setState(() => false)}
      onConfirm={() => void form.handleSubmit()}
    >
      <form.Field name="name">
        {(field) => (
          <div className="mb-4">
            <label
              htmlFor="bucket-name"
              className="block text-xs uppercase text-slate-400 font-semibold mb-2"
            >
              Bucket name
            </label>
            <input
              id="bucket-name"
              type="text"
              value={field.state.value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => field.handleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void form.handleSubmit();
              }}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </form.Field>

      <p className="text-sm text-slate-500 mb-4">
        Lowercase, 3-63 characters, no underscores. The server enforces this and reports its own
        message when a name is rejected.
      </p>

      {createMutation.isError ? (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500 text-red-500 rounded-lg text-sm">
          {messageOf(createMutation.error)}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

const dialogOpenStore = new Store(false);

const isConflict = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status === 409) return true;
  return messageOf(error).toLowerCase().includes('not empty');
};

const statusOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) return null;
  if ('status' in error && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  if ('data' in error) {
    const { data } = error as { data?: unknown };
    if (typeof data === 'object' && data !== null && 'status' in data) {
      const status = (data as { status?: unknown }).status;
      if (typeof status === 'number') return status;
    }
  }
  return null;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';
