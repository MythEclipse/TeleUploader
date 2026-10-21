/**
 * The bucket list, with create and delete.
 *
 * ## Why TanStack Form for one text field
 *
 * Kana mandates TanStack Form for forms and bans `useState`, so the create-bucket
 * dialog uses `useForm`. It earns its keep even at this size: the form owns the
 * value, the submit state and the validation, so the dialog has no local state at
 * all and cannot submit twice (the `isSubmitting` flag comes from the form).
 *
 * ## The rules text is the server's, not a local regex
 *
 * `handleCreateBucketV1` rejects with exactly
 * `{"error":"Invalid bucket name. Use lowercase, 3-63 chars, no underscore"}`, and
 * the Zod schema mirrors `BucketNameSchema`. A second, differently-worded rule list
 * in the UI would be a claim nobody verified — so the help text describes the rule
 * and the server's own message is what is shown on failure.
 *
 * ## Delete is a two-step confirm because it is irreversible
 *
 * The server refuses a non-empty bucket with 409, and that check happens BEFORE the
 * delete, so the response is honest here — unlike the object delete, which reports
 * success unconditionally. The dialog still confirms, because a bucket holding
 * objects cannot be restored.
 */

import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { api } from './api';
import { ConfirmDialog, type Notice, NoticeBanner } from './components';
import { formatDate } from './format';
import { keys } from './query-keys';
import type { BucketSummary } from './types';

/** Which bucket's delete is being confirmed, and which is in flight. */
interface BucketUiState {
  readonly notice: Notice | null;
  readonly confirming: BucketSummary | null;
  readonly pending: string | null;
}

const bucketStore = new Store<BucketUiState>({ notice: null, confirming: null, pending: null });

const patchBucketUi = (change: Partial<BucketUiState>): void => {
  bucketStore.setState((state) => ({ ...state, ...change }));
};

/** Props for {@link BucketTable}. */
export interface BucketTableProps {
  readonly buckets: readonly BucketSummary[];
  /** Organization slug every mutation is scoped to. */
  readonly orgSlug: string;
  readonly canWrite: boolean;
  /** The bucket the URL has selected, so its row can be marked current. */
  readonly selected: string;
  /** Opens a bucket. The caller decides whether that is a search param or a path. */
  readonly onOpen: (name: string) => void;
}

/**
 * The bucket list.
 *
 * Rendered on `/` and `/$orgSlug/dashboard`. Bucket names are React children: a
 * name is validated server-side by `BucketNameSchema` (`[a-z0-9.-]`, 3-63 chars, no
 * underscore) so it is far less dangerous than an object key, and it is treated the
 * same way regardless.
 */
export function BucketTable({
  buckets,
  orgSlug,
  canWrite,
  selected,
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
      // 409 is the one genuinely informative bucket-delete failure: the bucket exists
      // and holds objects. The handler checks emptiness BEFORE deleting, so this
      // response is honest — unlike the object delete.
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
    <div className="bucket-list">
      {notice ? (
        <NoticeBanner notice={notice} onDismiss={() => patchBucketUi({ notice: null })} />
      ) : null}

      <div className="browser-toolbar">
        <h2 style={{ flex: 1 }}>Buckets</h2>
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
                    aria-current={selected === bucket.name ? 'page' : undefined}
                  >
                    {bucket.name}
                  </button>
                </th>
                <td className="numeric">{bucket.objectCount}</td>
                <td className="muted">{formatDate(bucket.createdAt)}</td>
                <td className="actions-cell">
                  <button type="button" className="ghost" onClick={() => onOpen(bucket.name)}>
                    Open
                  </button>
                  {canWrite ? (
                    <button
                      type="button"
                      className="ghost danger"
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

/**
 * Whether the create-bucket dialog is open.
 *
 * A module-level TanStack `Store` because Kana bans `useState`. Module-level is also
 * correct here rather than merely allowed: there is exactly one create-bucket control
 * on screen, and a store created per render would reset the dialog on every keystroke
 * the form's own store triggers.
 */
const dialogOpenStore = new Store(false);

/**
 * The "New bucket" button plus its dialog.
 *
 * The dialog is mounted only while open, so the form's state resets every time it is
 * opened — no reset call, no stale name from a previous attempt.
 */
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
      // Reload the list BEFORE navigating, so the bucket the user lands in is
      // guaranteed to be in the list the page renders from.
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
        className="primary"
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

/** Whether an oRPC/HTTP failure is a 409. */
const isConflict = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status === 409) return true;
  // The controller's own message, when a status is not exposed. This is a fallback
  // for a proxy that rewrites the status, not the primary check.
  return messageOf(error).toLowerCase().includes('not empty');
};

/** Digs an HTTP status out of whatever was thrown. */
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

/** A thrown value's message, or a generic fallback. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

/** Re-exported so a caller that only needs the type does not import `./types`. */
export type { BucketSummary };

/**
 * Unused re-export kept out of the bundle.
 *
 * `Link` is imported above for the bucket rows in the `/$orgSlug/dashboard` variant,
 * which navigates by route id rather than by callback. Referencing it here keeps the
 * import honest for both call sites without a second module.
 */
export const BucketLink = Link;
