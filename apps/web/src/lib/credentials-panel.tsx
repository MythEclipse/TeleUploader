/**
 * The S3 credentials panel: issue, list and revoke key pairs.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { Check, Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
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
import { credentialsQuery } from './queries';
import { keys } from './query-keys';
import type { CreateCredentialResponse, CredentialSummary } from './types';

interface CredentialUiState {
  readonly issued: CreateCredentialResponse | null;
  readonly notice: Notice | null;
  readonly confirming: CredentialSummary | null;
  readonly pendingId: string | null;
}

const credentialStore = new Store<CredentialUiState>({
  issued: null,
  notice: null,
  confirming: null,
  pendingId: null,
});

const patchUi = (change: Partial<CredentialUiState>): void => {
  credentialStore.setState((state) => ({ ...state, ...change }));
};

export interface CredentialsPanelProps {
  readonly orgSlug: string;
  readonly canWrite: boolean;
}

export function CredentialsPanel({ orgSlug, canWrite }: CredentialsPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const issued = useSelector(credentialStore, (state) => state.issued);
  const notice = useSelector(credentialStore, (state) => state.notice);
  const confirming = useSelector(credentialStore, (state) => state.confirming);
  const pendingId = useSelector(credentialStore, (state) => state.pendingId);

  const list = useQuery(credentialsQuery({ orgSlug }));
  const credentials = list.data?.credentials ?? [];

  const createMutation = useMutation({
    mutationFn: async () => api.createCredential(),
    onSuccess: (created) => {
      patchUi({ issued: created, notice: null });
    },
    onError: (error) => {
      patchUi({ notice: { kind: 'error', text: `Could not issue a key: ${messageOf(error)}` } });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.credentials(orgSlug) });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (credential: CredentialSummary) => {
      patchUi({ pendingId: credential.id });
      await api.deleteCredential(credential.id);
      return credential.accessKey;
    },
    onSuccess: (accessKey) => {
      patchUi({
        confirming: null,
        pendingId: null,
        notice: { kind: 'ok', text: `Revoked ${accessKey}. Clients using it now get 403.` },
      });
    },
    onError: (error) => {
      patchUi({
        confirming: null,
        pendingId: null,
        notice: { kind: 'error', text: `Could not revoke: ${messageOf(error)}` },
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.credentials(orgSlug) });
    },
  });

  return (
    <section aria-label="S3 credentials" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold text-foreground">S3 credentials</h2>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] text-muted-foreground">
            Each workspace has its own key pairs. The secret is shown once when issued and cannot be
            read again — revoke and issue a new pair if it is lost.
          </p>
        </div>
        {canWrite ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Plus />}
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? 'Issuing…' : 'Issue new key pair'}
          </Button>
        ) : null}
      </div>

      {notice ? <NoticeBanner notice={notice} onDismiss={() => patchUi({ notice: null })} /> : null}

      {issued ? (
        <div
          className="overflow-hidden rounded-xl border border-warning/40 bg-warning-soft"
          role="status"
        >
          <div className="flex items-center gap-2 border-b border-warning/30 px-4 py-2.5">
            <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
            <h3 className="text-[0.8125rem] font-semibold text-warning">
              Copy this secret now — it will not be shown again
            </h3>
          </div>

          <dl className="divide-y divide-warning/20">
            <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <dt className="w-28 shrink-0 text-xs font-medium text-warning/80">Access key</dt>
              <dd className="min-w-0 flex-1">
                <code className="block truncate rounded bg-surface/60 px-2 py-1 text-[0.8125rem] text-foreground">
                  {issued.credential.accessKey}
                </code>
              </dd>
            </div>
            <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <dt className="w-28 shrink-0 text-xs font-medium text-warning/80">Secret key</dt>
              <dd className="min-w-0 flex-1">
                <code className="block truncate rounded bg-surface/60 px-2 py-1 text-[0.8125rem] text-foreground">
                  {issued.secretKey}
                </code>
              </dd>
            </div>
            <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <dt className="w-28 shrink-0 text-xs font-medium text-warning/80">Label</dt>
              <dd className="text-[0.8125rem] text-foreground">{issued.credential.label ?? '—'}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-warning/30 px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              icon={<Copy />}
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    `AWS_ACCESS_KEY_ID=${issued.credential.accessKey}\nAWS_SECRET_ACCESS_KEY=${issued.secretKey}`,
                  )
                  .then(() =>
                    patchUi({ notice: { kind: 'ok', text: 'Environment variables copied.' } }),
                  )
                  .catch(() =>
                    patchUi({
                      notice: {
                        kind: 'error',
                        text: 'Clipboard unavailable — select the values above and copy manually.',
                      },
                    }),
                  );
              }}
            >
              Copy as env vars
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Check />}
              onClick={() => patchUi({ issued: null })}
            >
              I have saved it
            </Button>
          </div>
        </div>
      ) : null}

      {list.isError ? (
        <p
          className="rounded-lg border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-[0.8125rem] text-danger"
          role="alert"
        >
          Could not list credentials: {messageOf(list.error)}
        </p>
      ) : null}

      {credentials.length === 0 && !list.isPending ? (
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={<KeyRound className="size-5" />}
            title="No key pairs yet"
            description={
              canWrite
                ? 'Issue one to reach these buckets from aws-cli, rclone or the Docker registry client.'
                : 'Sign in to issue a key pair.'
            }
          />
        </div>
      ) : null}

      {credentials.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <TableWrap>
            <Table>
              <caption className="sr-only">S3 key pairs for this workspace</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Access key</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="hidden sm:table-cell">Last used</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell>
                      <code className="rounded bg-surface-muted px-1.5 py-0.5 text-[0.8125rem] text-foreground">
                        {credential.accessKey}
                      </code>
                    </TableCell>
                    <TableCell>
                      {credential.label ? (
                        credential.label
                      ) : (
                        <Badge variant="outline">env-seeded</Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      {credential.lastUsedAt ? (
                        formatDate(credential.lastUsedAt)
                      ) : (
                        <span className="text-subtle-foreground">never</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      {formatDate(credential.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        {canWrite ? (
                          <Button
                            variant="dangerGhost"
                            size="sm"
                            icon={<Trash2 />}
                            disabled={pendingId === credential.id}
                            onClick={() => patchUi({ confirming: credential })}
                          >
                            {pendingId === credential.id ? 'Revoking…' : 'Revoke'}
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
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Revoke key pair"
          description="Any client using this key gets 403 immediately."
          confirmLabel="Revoke"
          busy={pendingId === confirming.id}
          onCancel={() => patchUi({ confirming: null })}
          onConfirm={() => revokeMutation.mutate(confirming)}
        >
          <p className="text-foreground">
            Revoke{' '}
            <code className="rounded bg-surface-muted px-1.5 py-0.5">{confirming.accessKey}</code>?
          </p>
          <p className="mt-2 text-[0.8125rem] text-muted-foreground">
            This cannot be undone — issue a new pair to restore access.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';
