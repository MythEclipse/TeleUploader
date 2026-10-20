/**
 * Module-level auth store.
 *
 * Lives here, not in `routes/__root.tsx`, because every route needs it: the root
 * renders the profile chrome, the file browser renders gated controls, and the login
 * route redirects based on it. Putting it in the root would make it a prop-drilling
 * tree or a context provider each route file must remember to mount.
 *
 * Implemented with `useSyncExternalStore` rather than a context so the state is
 * readable from non-React code (the XHR upload callbacks, the router's
 * `beforeLoad` guards) through the same source of truth.
 */

import { useSyncExternalStore } from 'react';
import { useRouterState } from '@tanstack/react-router';
import {
  activeOrganizationOf,
  canWrite,
  isReadOnly,
  isOpenDeployment,
  logout,
  logoutEverywhere,
  organizationsOf,
  orgSlugFromPath,
  probeAuth,
  shouldOfferLogin,
  signIn,
} from './auth';
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
 * Idempotent and safe from an effect: concurrent callers share one request. Never
 * rejects — a failed probe yields `{kind:'unknown'}`, which the UI renders as
 * read-only.
 *
 * @returns The settled state.
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
 * Begins Google sign-in.
 *
 * A navigation, not a fetch — see `./auth.ts`. It does not mutate the store because
 * the page is about to leave; the callback redirects back and `refreshAuth` picks up
 * the new session on arrival.
 *
 * @param redirectTo - Same-origin path to return to.
 */
export const beginSignIn = (redirectTo = '/'): void => {
  signIn(redirectTo);
};

/**
 * Revokes this session server-side and publishes `signed-out`.
 *
 * @throws {ApiError} If the server call fails. The caller decides whether to
 *   navigate anyway — leaving the cookie in place while showing a signed-out UI
 *   would be the stale-state bug this store avoids.
 */
export const signOut = async (): Promise<AuthState> => {
  await logout();
  return setState({ kind: 'signed-out', googleEnabled: true });
};

/**
 * Revokes every session for this account.
 *
 * @returns The number of sessions revoked.
 * @throws {ApiError} On failure.
 */
export const signOutEverywhere = async (): Promise<number> => {
  const revoked = await logoutEverywhere();
  setState({ kind: 'signed-out', googleEnabled: true });
  return revoked;
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
 * Whether the write UI should render.
 *
 * Derives from {@link useAuthState} rather than reading `state` directly, so the
 * subscription is real: reading the module variable without subscribing would return
 * a value that never re-renders when the probe resolves.
 */
export const useCanWrite = (): boolean => canWrite(useAuthState());

/** Read-only badge visibility. `unknown` counts as read-only. */
export const useIsReadOnly = (): boolean => isReadOnly(useAuthState());

/** Whether to render the Sign-in affordance. */
export const useShouldOfferLogin = (): boolean => shouldOfferLogin(useAuthState());

/** The organizations this account belongs to. Empty unless signed in. */
export const useOrganizations = () => organizationsOf(useAuthState());

/**
 * The organization the UI is scoped to, derived from the CURRENT URL.
 *
 * Reads the pathname from the router rather than taking a `slug` argument from each
 * caller. That is the fix for a real defect in the first draft of this file: the
 * switcher called `useActiveOrganization()` with no argument, so on
 * `/<org-b>/dashboard` it fell back to the account's personal organization and displayed
 * org A while the page showed org B's buckets. Deriving from the router means the
 * switcher, the shell and the page cannot disagree, because there is one source.
 *
 * @returns The organization named by the URL, or the default when the URL names none,
 *   or `null` when the URL names one the account is not a member of.
 */
export const useActiveOrganization = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return activeOrganizationOf(useAuthState(), orgSlugFromPath(pathname));
};

/** Whether this deployment runs with authentication switched off entirely. */
export const useIsOpenDeployment = (): boolean => isOpenDeployment(useAuthState());

/** Re-exported so route files import auth types from one place. */
export type { AuthState };
export { ApiError, canWrite, isReadOnly, shouldOfferLogin };
