/** The bucket list, with create and delete. */

import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { Database, Plus } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrap,
} from '../components/ui/table';
import { api } from './api';
import { ConfirmDialog, EmptyState, type Notice, NoticeBanner } from './components';
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
    <section aria-label="Buckets">
      {notice ? (
        <NoticeBanner notice={notice} onDismiss={() => patchBucketUi({ notice: null })} />
      ) : null}

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[0.9375rem] font-semibold text-foreground">Buckets</h2>
        {canWrite && buckets.length > 0 ? (
          <CreateBucketButton orgSlug={orgSlug} onCreated={onOpen} />
        ) : null}
      </div>

      {buckets.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={<Database className="size-5" />}
            title="No buckets yet"
            description={
              canWrite
                ? 'Create a bucket to start uploading files into this workspace.'
                : 'Sign in to create a bucket.'
            }
            action={
              canWrite ? <CreateBucketButton orgSlug={orgSlug} onCreated={onOpen} /> : undefined
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <TableWrap>
            <Table>
              <caption className="sr-only">Buckets in this workspace</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Objects</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((bucket) => (
                  <TableRow key={bucket.id}>
                    <TableCell className="p-0">
                      <button
                        type="button"
                        onClick={() => onOpen(bucket.name)}
                        className="flex w-full items-center gap-2.5 px-4 py-3 text-left font-medium text-foreground transition-colors hover:text-primary"
                      >
                        <Database
                          className="size-3.5 shrink-0 text-subtle-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{bucket.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {bucket.objectCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      {formatDate(bucket.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onOpen(bucket.name)}>
                          Open
                        </Button>
                        {canWrite ? (
                          <Button
                            variant="dangerGhost"
                            size="sm"
                            disabled={pending === bucket.name}
                            onClick={() => patchBucketUi({ confirming: bucket })}
                          >
                            {pending === bucket.name ? 'Working…' : 'Delete'}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </div>
      )}

      {confirming ? (
        <ConfirmDialog
          title="Delete bucket"
          description="This cannot be undone."
          confirmLabel="Delete bucket"
          busy={pending === confirming.name}
          onCancel={() => patchBucketUi({ confirming: null })}
          onConfirm={() => deleteMutation.mutate(confirming)}
        >
          <p className="text-foreground">
            Delete the bucket <strong className="font-semibold">{confirming.name}</strong>?
          </p>
          <p className="mt-2 text-[0.8125rem] text-muted-foreground">
            The server refuses if the bucket still contains objects.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
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

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        icon={<Plus />}
        onClick={() => dialogOpenStore.setState(() => true)}
      >
        New bucket
      </Button>

      {open ? (
        <ConfirmDialog
          title="Create bucket"
          description="Lowercase, 3–63 characters, no underscores."
          confirmLabel="Create"
          tone="primary"
          busy={createMutation.isPending}
          onCancel={() => dialogOpenStore.setState(() => false)}
          onConfirm={() => void form.handleSubmit()}
        >
          <form.Field name="name">
            {(field) => (
              <Field
                label="Bucket name"
                htmlFor="bucket-name"
                hint="The server enforces its own naming rules and reports its message when a name is rejected."
              >
                <Input
                  id="bucket-name"
                  type="text"
                  value={field.state.value}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => field.handleChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    void form.handleSubmit();
                  }}
                />
              </Field>
            )}
          </form.Field>

          {createMutation.isError ? (
            <p
              className="mt-3 rounded-lg border border-danger/35 bg-danger-soft px-3 py-2 text-[0.8125rem] text-danger"
              role="alert"
            >
              {messageOf(createMutation.error)}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
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
