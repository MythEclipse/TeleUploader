/** Sign in / sign out / account identity — the session gating in the top bar. */

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
    return <span className="text-sm text-slate-400">Checking session…</span>;
  }

  return (
    <>
      {state.kind === 'signed-in' ? (
        <div className="flex items-center gap-2" title={state.email}>
          {state.avatarUrl ? (
            <img
              className="w-6 h-6 rounded-full border border-slate-600"
              src={state.avatarUrl}
              alt=""
              width={24}
              height={24}
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="text-sm text-slate-300 truncate max-w-[140px]">
            {accountLabel(state.name, state.email)}
          </span>
        </div>
      ) : null}

      {!canWrite ? (
        <span className="px-2 py-0.5 bg-slate-800 border border-slate-600 rounded text-xs text-slate-500">
          read-only
        </span>
      ) : null}

      {offerLogin ? (
        <AppLink
          className="px-3 py-1.5 bg-slate-700 text-white rounded-md hover:bg-slate-600 text-sm transition"
          to={LOGIN_HREF}
        >
          Sign in
        </AppLink>
      ) : null}

      {state.kind === 'signed-in' ? (
        <button
          type="button"
          className="px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-60 text-sm transition"
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
