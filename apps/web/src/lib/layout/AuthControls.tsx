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
    return <span className="text-sm text-slate-500">Checking session…</span>;
  }

  return (
    <>
      {state.kind === 'signed-in' ? (
        <span className="flex items-center gap-2 text-sm text-slate-700" title={state.email}>
          {state.avatarUrl ? (
            <img
              className="w-6 h-6 rounded-full object-cover"
              src={state.avatarUrl}
              alt=""
              width={24}
              height={24}
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span className="max-w-[160px] truncate">{accountLabel(state.name, state.email)}</span>
        </span>
      ) : null}

      {!canWrite ? <span className="px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded-full border border-slate-200">read-only</span> : null}

      {offerLogin ? (
        <AppLink className="px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md" to={LOGIN_HREF}>
          Sign in
        </AppLink>
      ) : null}

      {state.kind === 'signed-in' ? (
        <button
          type="button"
          className="px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md disabled:opacity-60 disabled:cursor-not-allowed"
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
