/**
 * Login / Logout / read-only badge — the admin gating from `home.html`'s
 * `applyAdminUI`, reproduced on the three-state probe instead of a boolean.
 *
 * The mapping, from `home.html:196-203`, re-derived against §1.2:
 *
 * | AuthState        | Login | Logout | read-only badge |
 * |------------------|-------|--------|-----------------|
 * | `admin`          | no    | yes    | no              |
 * | `readonly`       | yes   | no     | yes             |
 * | `auth-disabled`  | no    | yes    | no              |
 * | `unknown`        | no    | no     | yes             |
 *
 * `auth-disabled` matches `admin` because the server really does accept writes
 * (`requireAuth` is a pass-through with an empty `ADMIN_API_TOKEN`) — showing a
 * Login button there would be a control that cannot work.
 */

import { useAuthState, signOut, useCanWrite, useShouldOfferLogin } from '../auth-store';
import { AppLink } from './AppLink';

/**
 * Where Login and Logout go.
 *
 * `AppLink`, not TanStack's typed `<Link to>` — see that component for why
 * (`to="/login"` does not typecheck until `src/routes/login.tsx` exists, and
 * that file is owned by another lane).
 */
const LOGIN_HREF = '/login';

export const AuthControls = (): React.JSX.Element => {
  const state = useAuthState();
  const canWrite = useCanWrite();
  const offerLogin = useShouldOfferLogin();

  const busy = state.kind === 'unknown';

  if (busy) {
    return <span className="auth-status">Checking access…</span>;
  }

  return (
    <>
      {!canWrite ? <span className="readonly-badge">read-only</span> : null}

      {offerLogin ? (
        <AppLink className="ghost button" href={LOGIN_HREF}>
          Login
        </AppLink>
      ) : null}

      {canWrite ? (
        <button
          type="button"
          className="ghost"
          title="Clears this browser's cookie. Sessions are stateless HMAC blobs, so a captured cookie still works after logout."
          onClick={() => {
            // Drop the local session first, then leave. `signOut` swallows its
            // own network failure — the cookie is cleared locally either way.
            void signOut().then(() => {
              window.location.assign(LOGIN_HREF);
            });
          }}
        >
          Logout
        </button>
      ) : null}
    </>
  );
};
