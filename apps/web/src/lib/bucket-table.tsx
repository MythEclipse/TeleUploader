/**
 * The bucket list, with create and delete.
 */

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
    <div className="browser-page">
      {notice ? (
        <NoticeBanner notice={notice} onDismiss={() => patchBucketUi({ notice: null })} />
      ) : null}

      <div className="browser-toolbar">
        <h2 className="browser-toolbar-title">Buckets</h2>
        {canWrite ? <CreateBucketButton orgSlug={orgSlug} onCreated={onOpen} /> : null}
      </div>

      {buckets.length === 0 ? (
        <div className="empty-state">
          <h2>No buckets yet</h2>
          <p>
            {canWrite ? 'Use "New bucket" above to create one.' : 'Sign in to create a bucket.'}
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="table-responsive">
            <table className="file-table">
              <caption className="visually-hidden">Buckets in this workspace</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="numeric">
                    Objects
                  </th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((bucket) => (
                  <tr key={bucket.id}>
                    <th scope="row" className="name-cell">
                      <button
                        type="button"
                        className="bucket-link"
                        onClick={() => onOpen(bucket.name)}
                      >
                        {bucket.name}
                      </button>
                    </th>
                    <td className="numeric">{bucket.objectCount}</td>
                    <td className="muted">{formatDate(bucket.createdAt)}</td>
                    <td className="actions-cell">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => onOpen(bucket.name)}
                      >
                        Open
                      </button>
                      {canWrite ? (
                        <button
                          type="button"
                          className="btn-ghost danger"
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
          <p>
            Delete the bucket <strong>{confirming.name}</strong>? This cannot be undone. The server
            refuses if it still contains objects.
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
        className="btn-primary"
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
          <label className="dialog-field">
            <span className="field-label">Bucket name</span>
            <input
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
            />
          </label>
        )}
      </form.Field>

      <p className="field-help">
        Lowercase, 3-63 characters, no underscores. The server enforces this and reports its own
        message when a name is rejected.
      </p>

      {createMutation.isError ? (
        <p className="notice-banner error" role="alert">
          {messageOf(createMutation.error)}
        </p>
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
