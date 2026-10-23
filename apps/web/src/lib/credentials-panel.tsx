/**
 * The S3 credentials panel: issue, list and revoke key pairs.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { api } from './api';
import { ConfirmDialog, type Notice, NoticeBanner } from './components';
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
    <section aria-label="S3 credentials">
      <h2>S3 credentials</h2>
      <p className="field-help">
        Each workspace has its own key pairs. The secret is shown once when issued and cannot be
        read again — revoke and issue a new pair if it is lost.
      </p>

      {notice ? <NoticeBanner notice={notice} onDismiss={() => patchUi({ notice: null })} /> : null}

      {issued ? (
        <div className="upload-panel" role="status">
          <h3>Copy this secret now — it will not be shown again</h3>
          <table className="file-table">
            <tbody>
              <tr>
                <th scope="row">Access key</th>
                <td>
                  <code>{issued.credential.accessKey}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Secret key</th>
                <td>
                  <code>{issued.secretKey}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Label</th>
                <td>{issued.credential.label}</td>
              </tr>
            </tbody>
          </table>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-primary"
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
            </button>
            <button type="button" className="btn-ghost" onClick={() => patchUi({ issued: null })}>
              I have saved it
            </button>
          </div>
        </div>
      ) : null}

      <div className="browser-toolbar">
        <span className="spacer" style={{ flex: 1 }} />
        {canWrite ? (
          <button
            type="button"
            className="btn-primary"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? 'Issuing…' : 'Issue new key pair'}
          </button>
        ) : null}
      </div>

      {list.isError ? (
        <p className="error-banner" role="alert">
          Could not list credentials: {messageOf(list.error)}
        </p>
      ) : null}

      {credentials.length === 0 && !list.isPending ? (
        <div className="empty-state">
          <h2>No key pairs yet</h2>
          <p>
            {canWrite
              ? 'Issue one to reach these buckets from aws-cli, rclone or the Docker registry client.'
              : 'Sign in to issue a key pair.'}
          </p>
        </div>
      ) : null}

      {credentials.length > 0 ? (
        <div className="panel">
          <div className="table-responsive">
            <table className="file-table">
              <caption className="visually-hidden">S3 key pairs for this workspace</caption>
              <thead>
                <tr>
                  <th scope="col">Access key</th>
                  <th scope="col">Label</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr key={credential.id}>
                    <th scope="row">
                      <code>{credential.accessKey}</code>
                    </th>
                    <td>{credential.label}</td>
                    <td className="muted">
                      {credential.lastUsedAt ? formatDate(credential.lastUsedAt) : 'never'}
                    </td>
                    <td className="muted">{formatDate(credential.createdAt)}</td>
                    <td className="actions-cell">
                      {canWrite ? (
                        <button
                          type="button"
                          className="btn-ghost danger"
                          disabled={pendingId === credential.id}
                          onClick={() => patchUi({ confirming: credential })}
                        >
                          {pendingId === credential.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Revoke key pair"
          confirmLabel="Revoke"
          busy={pendingId === confirming.id}
          onCancel={() => patchUi({ confirming: null })}
          onConfirm={() => revokeMutation.mutate(confirming)}
        >
          <p>
            Revoke <code>{confirming.accessKey}</code>? Any client using it will immediately get
            403. This cannot be undone — issue a new pair to restore access.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';
