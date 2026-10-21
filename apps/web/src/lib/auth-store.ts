/**
 * React bindings for the auth store.
 *
 * ## Why this file is a thin layer and not a store
 *
 * The state itself lives in `./auth.ts` as a TanStack `Store`, because the
 * router's `beforeLoad` guards are plain functions that run outside any
 * component and must read the same value the UI renders. This module only adds
 * the React read path.
 *
 * ## Why `useSelector` and not React hooks
 *
 * Kana's `no-react-hooks` rule bans every React hook, and it names the exact
 * replacements used here:
 *
 *   - `useState`            → a TanStack `Store`, read with `useSelector`
 *   - `useSyncExternalStore` → `useSelector`, which implements it internally
 *   - `useEffect`           → route `beforeLoad` / `useQuery`
 *   - `useMemo`             → a selector function
 *   - `useCallback`         → a plain function in the render closure
 *
 * The previous version of this file used `useSyncExternalStore` directly, which
 * is banned by name. Each `useX` export below is a SELECTOR over the store
 * rather than a hook with its own state, so a component subscribes to exactly
 * the slice it renders and a change to an unrelated field does not re-render it.
 *
 * ## Selectors are stable, so no memoisation is needed
 *
 * Every selector is a module-level constant. `useSelector` compares the selected
 * value, not the function, so passing a fresh closure on each render would still
 * be correct — but a stable reference is what lets the comparison be a plain
 * `Object.is` on primitives and `null`/object identity.
 */

import { useSelector } from '@tanstack/react-store';
import {
  type AuthState,
  activeOrganizationOf,
  authStore,
  canWrite,
  isOpenDeployment,
  isReadOnly,
  logout,
  logoutEverywhere,
  organizationsOf,
  refreshAuth,
  setAuthState,
  shouldOfferLogin,
  signIn,
} from './auth';
import type { OrganizationMembership } from './types';

/** The whole auth state. Prefer a narrower selector where one exists. */
export const useAuthState = (): AuthState => useSelector(authStore, (state) => state);

/** Whether the caller may write. */
export const useCanWrite = (): boolean => useSelector(authStore, canWrite);

/** Whether the write controls should be replaced by a read-only notice. */
export const useIsReadOnly = (): boolean => useSelector(authStore, isReadOnly);

/** Whether to render a Sign-in button. */
export const useShouldOfferLogin = (): boolean => useSelector(authStore, shouldOfferLogin);

/** Whether this deployment runs with authentication disabled entirely. */
export const useIsOpenDeployment = (): boolean => useSelector(authStore, isOpenDeployment);

/** The organizations available in the switcher. */
export const useOrganizations = (): readonly OrganizationMembership[] =>
  useSelector(authStore, organizationsOf);

/**
 * The organization the UI is scoped to.
 *
 * Reads the slug from the store rather than taking it as an argument, because the
 * active organization is a function of BOTH the memberships and the current URL,
 * and threading the URL through every caller is how the switcher and the bucket
 * list drift apart.
 *
 * @param slug - The `$orgSlug` route param, when the route has one.
 */
export const useActiveOrganization = (slug?: string): OrganizationMembership | null =>
  useSelector(authStore, (state) => activeOrganizationOf(state, slug));

/** Whether the tenant list has loaded at least once (signed in or signed out). */
export const useAuthResolved = (): boolean =>
  useSelector(authStore, (state) => state.kind !== 'unknown');

export {
  activeOrganizationOf,
  canWrite,
  isOpenDeployment,
  isReadOnly,
  logout,
  logoutEverywhere,
  organizationsOf,
  refreshAuth,
  setAuthState,
  shouldOfferLogin,
  signIn,
};
