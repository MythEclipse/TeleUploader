/**
 * Sign in / sign out / account identity — the session gating in the top bar.
 */

import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { logout, useAuthState, useCanWrite, useShouldOfferLogin } from '../auth-store';
import { AppLink } from './AppLink';

const LOGIN_HREF = '/login';

const signingOutStore = new Store(false);

const accountLabel = (name: string, email: string): string => {
  if (name.trim().length > 0) return name;
  const localPart = email.split('@')[0];
  return localPart && localPart.length > 0 ? localPart : email;
};

export const AuthControls = (): React.JSX.Element => {
  const state = useAuthState();
  const canWrite = useCanWrite();
  const offerLogin = useShouldOfferLogin();
  const signingOut = useSelector(signingOutStore, (value) => value);

  if (state.kind === 'unknown') {
    return <span className="auth-status">Checking session…</span>;
  }

  return (
    <>
      {state.kind === 'signed-in' ? (
        <span className="account" title={state.email}>
          {state.avatarUrl ? (
            <img
              className="avatar"
              src={state.avatarUrl}
              alt=""
              width={24}
              height={24}
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="account-name">{accountLabel(state.name, state.email)}</span>
        </span>
      ) : null}

      {!canWrite ? <span className="readonly-badge">read-only</span> : null}

      {offerLogin ? (
        <AppLink className="btn-ghost" to={LOGIN_HREF}>
          Sign in
        </AppLink>
      ) : null}

      {state.kind === 'signed-in' ? (
        <button
          type="button"
          className="btn-ghost"
          disabled={signingOut}
          title="Signs out and revokes this session on the server."
          onClick={() => {
            signingOutStore.setState(() => true);
            void logout()
              .catch(() => undefined)
              .finally(() => {
                signingOutStore.setState(() => false);
                window.location.assign(LOGIN_HREF);
              });
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      ) : null}
    </>
  );
};
