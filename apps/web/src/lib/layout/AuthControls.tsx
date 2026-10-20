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
 * ## What changed from the single-token version
 *
 * The old component showed a `Logout` button for the `auth-disabled` state too,
 * because with an empty `ADMIN_API_TOKEN` the server accepted writes and hiding the
 * control "would be a lie about what the deployment can do". That arm is gone: a
 * signed-out visitor is genuinely signed out now, so there is nothing to log out of.
 *
 * It also renders the account's identity, because there is one — a real email and
 * display name from Google. The previous version could not: the session carried a
 * hardcoded `"admin"` string.
 */

import { useState } from 'react';
import { signOut, useAuthState, useCanWrite, useShouldOfferLogin } from '../auth-store';
import { AppLink } from './AppLink';

/** Where Sign in and Sign out go. See the note on `AppLink` below. */
const LOGIN_HREF = '/login';

/**
 * The signed-in account's label.
 *
 * Prefers the display name, falls back to the email's local part. Both can be empty
 * for a Google account with no profile name, so there is a final fallback rather than
 * rendering a blank button.
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
  const [signingOut, setSigningOut] = useState(false);

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
        <AppLink className="ghost button" href={LOGIN_HREF}>
          Sign in
        </AppLink>
      ) : null}

      {canWrite ? (
        <button
          type="button"
          className="ghost"
          disabled={signingOut}
          title="Signs out and revokes this session on the server."
          onClick={() => {
            setSigningOut(true);
            // The server DELETES the session row, so this genuinely revokes — unlike
            // the old stateless cookie, where logout only cleared the browser's copy.
            // Navigate regardless of the call's outcome: leaving a signed-out UI in
            // front of a live cookie would be the stale-state bug.
            void signOut()
              .catch(() => undefined)
              .finally(() => {
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
