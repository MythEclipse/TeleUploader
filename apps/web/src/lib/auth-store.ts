/**
 * Module-level auth store.
 *
 * Lives here, not in `routes/__root.tsx`, because the contract requires it
 * there (§1.1: "Auth state lives in a module-level store, not here") and because
 * every route needs it: the root renders admin-gated chrome, the file browser
 * renders admin-gated controls, and the login route redirects based on it.
 * Putting it in the root would make it a prop-drilling tree or a context
 * provider that route files must each remember to mount.
 *
 * Implemented with `useSyncExternalStore` rather than a context so that the
 * state is readable from non-React code (the XHR upload callbacks, the router's
 * `beforeLoad` guards) through the same source of truth.
 */

import { useSyncExternalStore } from 'react';
import { canWrite, isReadOnly, login, logout, probeAuth, shouldOfferLogin } from './auth';
import type { AuthState } from './auth';
import { ApiError } from './client';

const UNKNOWN: AuthState = { kind: 'unknown' };

let state: AuthState = UNKNOWN;
/** De-duplicates concurrent probes — StrictMode double-invokes effects. */
let inFlight: Promise<AuthState> | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const setState = (next: AuthState): AuthState => {
  state = next;
  emit();
  return next;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = (): AuthState => state;

/**
 * Re-probes `GET /api/v1/auth/me` and publishes the result.
 *
 * Idempotent and safe to call from an effect: concurrent callers share one
 * request. Never rejects — a failed probe yields `{kind:'unknown'}`, which the
 * UI renders as read-only.
 */
export const refreshAuth = (): Promise<AuthState> => {
  inFlight ??= probeAuth()
    .then(setState)
    .catch(() => setState(UNKNOWN))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/**
 * Logs in and publishes the resulting state.
 *
 * @throws {ApiError} On a rejected token, a rate limit, or a successful login
 *   whose cookie the browser refused to store (the `Secure`-over-http trap).
 */
export const signIn = async (token: string): Promise<AuthState> => {
  const next = await login(token);
  return setState(next);
};

/**
 * Logs out and publishes `{kind:'readonly'}`.
 *
 * Note what this does NOT do: it does not invalidate the old cookie server-side.
 * Sessions are a stateless HMAC blob with no revocation store, so a captured
 * cookie still works after logout (contract gotcha 13). The UI must not present
 * logout as securing the session.
 */
export const signOut = async (): Promise<AuthState> => {
  await logout();
  return setState({ kind: 'readonly' });
};

/** Test/reset seam: returns to the pre-probe state without a network call. */
export const resetAuthStore = (): void => {
  inFlight = null;
  setState(UNKNOWN);
};

// ─────── React bindings ───────

/** Subscribes to the auth state. */
export const useAuthState = (): AuthState => useSyncExternalStore(subscribe, snapshot, snapshot);

/**
 * Whether the admin UI should render. `true` for `auth-disabled` too — the
 * server accepts the write when `ADMIN_API_TOKEN` is empty, so hiding the
 * control would misdescribe the deployment.
 *
 * Derives from {@link useAuthState} rather than reading `state` directly, so the
 * subscription is real: reading the module variable without subscribing would
 * return a value that never re-renders when the probe resolves.
 */
export const useCanWrite = (): boolean => canWrite(useAuthState());

/** Read-only badge visibility. `unknown` counts as read-only. */
export const useIsReadOnly = (): boolean => isReadOnly(useAuthState());

/** Whether to render the Login button. Never shown when auth is disabled. */
export const useShouldOfferLogin = (): boolean => shouldOfferLogin(useAuthState());

/** Re-exported so route files import auth types from one place. */
export type { AuthState };
export { ApiError, canWrite, isReadOnly, shouldOfferLogin };
