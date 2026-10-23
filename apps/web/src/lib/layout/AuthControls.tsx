/**
 * Sign in / sign out / account identity — the session gating in the top bar.
 *
 * ## The mapping
 *
 * | AuthState      | Sign in | Sign out | read-only badge | profile |
 * |----------------|---------|----------|-----------------|---------|
 * | `signed-in`    | no      | yes      | no              | yes     |
 * | `signed-out`   | yes     | no       | yes             | no      |
 * | `unknown`      | no      | no       | yes             | no      |
 *
 * ## Why there is no `useState` here
 *
 * Kana bans React hooks, `useState` included. The one piece of component-local
 * state this component had was the "signing out…" flag, which is now a
 * module-level TanStack `Store` read with `useSelector`. That is a deliberate
 * downgrade in locality for a deliberate reason: the flag drives a `disabled`
 * attribute and a label, and a Store gives both without a hook.
 *
 * The flag is module-level rather than per-instance because there is exactly one
 * auth control on screen — it lives in the app shell's top bar. Two stores for
 * one button would be the only alternative, and it buys nothing.
 *
 * ## Sign out is a revoke, not a cookie clear
 *
 * `logout()` calls `/api/v1/auth/logout`, which DELETES the session row. The
 * cookie is dead even if it is replayed. The navigation happens regardless of the
 * call's outcome: leaving a signed-out-looking UI in front of a live session would
 * be the stale-state bug, and a failed request is worth reporting but not worth
 * stranding the user on a page that claims they are signed in.
 */

import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { logout, useAuthState, useCanWrite, useShouldOfferLogin } from '../auth-store';
import { AppLink } from './AppLink';

/** Where Sign in and Sign out go. */
const LOGIN_HREF = '/login';

/**
 * Whether a sign-out request is in flight.
 *
 * Module-level, see the note in the file header. `false` is the resting state, so
 * a remount after a successful sign-out does not leave a stuck spinner.
 */
const signingOutStore = new Store(false);

/**
 * The signed-in account's label.
 *
 * Prefers the display name, falls back to the email's local part. Both can be
 * empty for a Google account with no profile name, so there is a final fallback
 * rather than rendering a blank button.
 *
 * @param name - Display name from the identity provider.
 * @param email - The account email.
 */
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
              // The URL comes from Google; if it rots the initial still shows.
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="account-name">{accountLabel(state.name, state.email)}</span>
        </span>
      ) : null}

      {!canWrite ? <span className="readonly-badge">read-only</span> : null}

      {offerLogin ? (
        <AppLink className="ghost button" to={LOGIN_HREF}>
          Sign in
        </AppLink>
      ) : null}

      {state.kind === 'signed-in' ? (
        <button
          type="button"
          className="ghost"
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
