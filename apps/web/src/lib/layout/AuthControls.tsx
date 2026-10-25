/** Sign in / sign out / account identity — the session gating in the top bar. */

import { useSelector } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { LogOut } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { logout, useAuthState, useCanWrite, useShouldOfferLogin } from '../auth-store';
import { AppLink } from './AppLink';

const LOGIN_HREF = '/login';

const signingOutStore = new Store(false);

const accountLabel = (name: string, email: string): string => {
  if (name.trim().length > 0) return name;
  const localPart = email.split('@')[0];
  return localPart && localPart.length > 0 ? localPart : email;
};

/** First letter of the display name, for the avatar fallback. */
const initialOf = (label: string): string => label.trim().charAt(0).toUpperCase() || '?';

export const AuthControls = (): React.JSX.Element => {
  const state = useAuthState();
  const canWrite = useCanWrite();
  const offerLogin = useShouldOfferLogin();
  const signingOut = useSelector(signingOutStore, (value) => value);

  if (state.kind === 'unknown') {
    return (
      <span
        className="inline-block size-6 animate-pulse rounded-full bg-surface-hover"
        role="status"
        aria-label="Checking session"
      />
    );
  }

  const label = state.kind === 'signed-in' ? accountLabel(state.name, state.email) : '';

  return (
    <>
      {state.kind === 'signed-in' ? (
        <div className="flex items-center gap-1.5" title={state.email}>
          {state.avatarUrl ? (
            <img
              className="size-6 rounded-full border border-border object-cover"
              src={state.avatarUrl}
              alt=""
              width={24}
              height={24}
              referrerPolicy="no-referrer"
            />
          ) : (
            <span
              className="flex size-6 items-center justify-center rounded-full bg-primary-soft text-[0.6875rem] font-semibold text-primary"
              aria-hidden="true"
            >
              {initialOf(label)}
            </span>
          )}
          <span className="hidden max-w-32 truncate text-[0.8125rem] font-medium text-foreground sm:inline">
            {label}
          </span>
        </div>
      ) : null}

      {!canWrite ? (
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[0.6875rem] font-medium text-subtle-foreground">
          read-only
        </span>
      ) : null}

      {offerLogin ? (
        <AppLink
          to={LOGIN_HREF}
          className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-[0.8125rem] font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
        >
          Sign in
        </AppLink>
      ) : null}

      {state.kind === 'signed-in' ? (
        <Button
          variant="ghost"
          size="iconSm"
          disabled={signingOut}
          aria-label="Sign out"
          title="Sign out — revokes this session on the server"
          icon={<LogOut />}
          onClick={() => {
            signingOutStore.setState(() => true);
            void logout()
              .catch(() => undefined)
              .finally(() => {
                signingOutStore.setState(() => false);
                window.location.assign(LOGIN_HREF);
              });
          }}
        />
      ) : null}
    </>
  );
};
