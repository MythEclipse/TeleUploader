/**
 * Auth state for the SPA, held in a TanStack Store.
 *
 * ## Why a Store and not `useState` / `useSyncExternalStore`
 *
 * Kana's `no-react-hooks` rule bans every React hook, `useSyncExternalStore`
 * included, and names TanStack Store as the replacement. That is not a stylistic
 * preference here: this state is read by the router's `beforeLoad` guards (plain
 * functions, outside any component) AND by components, so it has to live
 * somewhere both can reach. A Store gives `store.get()` for the guards and
 * `useSelector(store, …)` for components — one source of truth, two access
 * patterns, no provider to forget to mount.
 *
 * ## What the state actually means
 *
 * The server's own answer, not a client guess. `GET /api/v1/auth/me` returns:
 *
 * | Status | Meaning |
 * |---|---|
 * | `200` | an identifiable caller (signed in, bearer token, or open deployment) |
 * | `401` | authentication is configured and no credential was presented |
 *
 * Two facts ride on a 200 and they are independent: `method` says HOW the caller
 * was identified (including `disabled` for a deployment with auth switched off),
 * and `organizations` says WHAT they may reach. Collapsing those into one boolean
 * is what let the earlier UI claim read-only on a deployment that would accept a
 * write.
 *
 * ## Sign-in is a NAVIGATION, not a fetch
 *
 * Google's flow is a top-level redirect: the server 302s to Google, Google 302s
 * back to the callback, and the server 302s into the app with the session cookie
 * set. The SPA cannot observe that with `fetch` — the cookie is HttpOnly and the
 * chain crosses origins — so `signIn` assigns `window.location` and lets the
 * browser do it.
 */

import { Store } from '@tanstack/store';
import { ApiError, http } from './client';
import type { MeResponse, OrganizationMembership } from './types';

/** Auth state, as probed from `GET /api/v1/auth/me`. */
export type AuthState =
  /** 200 — an identifiable caller. `method` says how. */
  | {
      readonly kind: 'signed-in';
      readonly userId: string;
      readonly email: string;
      readonly name: string;
      readonly avatarUrl: string | null;
      readonly expiresAt: string | null;
      readonly method: 'cookie' | 'bearer' | 'disabled';
      /** Organizations this caller may switch between. */
      readonly organizations: readonly OrganizationMembership[];
      /** Whether the server offers Google sign-in. */
      readonly googleEnabled: boolean;
    }
  /** 401 — auth is configured and no credential was presented. */
  | { readonly kind: 'signed-out'; readonly googleEnabled: boolean }
  /** Not probed yet, a network failure, or an unexpected status. */
  | { readonly kind: 'unknown' };

/** The initial state: nothing has been asked yet. */
export const UNKNOWN_AUTH: AuthState = { kind: 'unknown' };

/**
 * The auth store.
 *
 * Module-level, deliberately. A store created inside a component would be a new
 * object on every render, and the router guards read it from outside React
 * entirely.
 */
export const authStore = new Store<AuthState>(UNKNOWN_AUTH);

/** De-duplicates concurrent probes — two guards can fire on one navigation. */
let inFlight: Promise<AuthState> | null = null;

/**
 * Reads `GET /api/v1/auth/me` and maps the status onto {@link AuthState}.
 *
 * Never throws: an auth probe that rejected would leave the UI unable to decide
 * what to render, which is the "read-only by accident" state this module exists
 * to make explicit.
 *
 * @returns The probed state.
 */
export const probeAuth = async (): Promise<AuthState> => {
  try {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });

    // 401 is the only "authentication is configured and you presented nothing"
    // signal. A 404 would mean the route is missing — a deployment bug — and must
    // not be read as "public access".
    if (res.status === 401) {
      // The 401 body carries `googleEnabled`, and reading it is the point: an
      // anonymous visitor is the only one who sees the login page. Defaulting to
      // `true` made an unconfigured deployment render a Sign-in button that
      // dead-ended at a 503. Absent or unparseable leaves it false, which shows
      // the explanatory notice — the safer error, because a hidden button costs a
      // click while a broken one costs trust in the whole page.
      const body = await res.json().catch(() => null);
      return {
        kind: 'signed-out',
        googleEnabled: (body as { googleEnabled?: unknown } | null)?.googleEnabled === true,
      };
    }
    if (!res.ok) return UNKNOWN_AUTH;

    const body = (await res.json()) as Partial<MeResponse>;
    // `userId` is the one field every 200 carries — including the open
    // deployment, where it is the bootstrap admin id.
    if (typeof body.userId !== 'string') return UNKNOWN_AUTH;

    return {
      kind: 'signed-in',
      userId: body.userId,
      email: typeof body.email === 'string' ? body.email : '',
      name: typeof body.name === 'string' ? body.name : '',
      avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : null,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      // Passed through verbatim rather than defaulted to 'cookie': `disabled` is
      // the flag that stops the shell from claiming read-only on an open
      // deployment.
      method: body.method === 'bearer' || body.method === 'disabled' ? body.method : 'cookie',
      organizations: Array.isArray(body.organizations) ? body.organizations : [],
      googleEnabled: body.googleEnabled === true,
    };
  } catch {
    return UNKNOWN_AUTH;
  }
};

/**
 * Probes auth and publishes the result.
 *
 * Concurrent callers share one request: the guards on two nested routes both run
 * on a cold navigation, and two probes would be two identical round trips with a
 * race between their results.
 *
 * @param options - `force` skips the "already signed in" short circuit.
 * @returns The published state.
 */
export const refreshAuth = async (options: { force?: boolean } = {}): Promise<AuthState> => {
  if (inFlight) return inFlight;

  const current = authStore.state;
  // A signed-in state is not re-probed on every navigation — it only changes
  // because of an explicit sign-out or a 401 from a real request, both of which
  // publish through here.
  if (!options.force && current.kind === 'signed-in') return current;

  inFlight = probeAuth()
    .then((next) => {
      authStore.setState(() => next);
      return next;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

/** Publishes a state directly. Used by the sign-out path and by tests. */
export const setAuthState = (next: AuthState): void => {
  authStore.setState(() => next);
};

// ── Derived selectors ───────────────────────────────────────────────────────
//
// Plain functions of the state rather than hooks, so the router guards and the
// components evaluate the same rules. A component reads them with
// `useSelector(authStore, selectX)`.

/** Whether the caller may perform writes. */
export const canWrite = (state: AuthState): boolean =>
  state.kind === 'signed-in' && state.organizations.length > 0;

/** Whether to show the read-only badge. `unknown` and no-workspace count as read-only. */
export const isReadOnly = (state: AuthState): boolean => !canWrite(state);

/** Whether to render a Sign-in button. Only for a genuine 401. */
export const shouldOfferLogin = (state: AuthState): boolean => state.kind === 'signed-out';

/**
 * Whether this deployment has authentication switched off entirely.
 *
 * Informational, not a permission: writes ARE accepted in this mode. It exists so
 * the shell can explain the state instead of looking broken.
 */
export const isOpenDeployment = (state: AuthState): boolean =>
  state.kind === 'signed-in' && state.method === 'disabled';

/** The organizations to render in the switcher. Empty unless signed in. */
export const organizationsOf = (state: AuthState): readonly OrganizationMembership[] =>
  state.kind === 'signed-in' ? state.organizations : [];

/**
 * The organization the UI is currently scoped to.
 *
 * Prefers the one whose slug matches the URL, then the user's personal (owner)
 * organization, then the first. Returning a definite organization matters: the
 * switcher and the bucket list must agree, and "no org" would render an empty
 * dashboard for a user who has one.
 *
 * @param state - The current auth state.
 * @param slug - The `$orgSlug` path segment, when the route has one.
 * @returns The organization, or `null` when the caller has none.
 */
export const activeOrganizationOf = (
  state: AuthState,
  slug?: string,
): OrganizationMembership | null => {
  const organizations = organizationsOf(state);
  if (organizations.length === 0) return null;
  if (slug) {
    const matched = organizations.find((org) => org.slug === slug);
    // A slug that matches nothing is a URL the account is not a member of.
    // Falling through to the default here would DISPLAY a tenant the URL did not
    // name, so the caller gets `null` and renders not-found instead.
    if (matched) return matched;
    return null;
  }
  return organizations.find((org) => org.role === 'owner') ?? organizations[0] ?? null;
};

/**
 * Extracts the organization slug from a pathname.
 *
 * ## Two things this must strip before looking
 *
 * A caller may pass `location.pathname` (already query-free) or a full href. Both
 * are accepted, so a query string is dropped first — otherwise
 * `/login?redirect=/alice` yields the slug `login?redirect=/alice` — and a hash
 * is dropped for the same reason.
 *
 * Reserved segments are then matched explicitly rather than inferred from a
 * leading `/`, because `/login` is a single-segment path that would otherwise
 * read as an organization called `login`.
 *
 * @param pathname - `window.location.pathname`, the router's path, or a full href.
 * @returns The slug, or `undefined`.
 */
export const orgSlugFromPath = (pathname: string): string | undefined => {
  const pathOnly = pathname.split(/[?#]/)[0] ?? '';
  const [first] = pathOnly.split('/').filter(Boolean);
  if (!first) return undefined;
  if (RESERVED_TOP_LEVEL_PATHS.has(first)) return undefined;
  return decodeURIComponent(first);
};

/**
 * Top-level paths that are routes in their own right, not organization slugs.
 *
 * A user whose personal organization were somehow slugged `login` would be
 * shadowed here — but `ensurePersonalOrganization` derives slugs from the email
 * local part and `login`/`api` must not be claimable, so keeping this list
 * authoritative is the correct trade: a broken route is worse than an unreachable
 * org, and the account still reaches its workspace at `/<org>`.
 */
const RESERVED_TOP_LEVEL_PATHS: ReadonlySet<string> = new Set(['login', 'settings']);

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Starts the better-auth Google sign-in flow by navigating the browser to it.
 *
 * ## Why a navigation and not the better-auth client's `signIn.social`
 *
 * `signIn.social` issues a `fetch`, reads the authorize URL from the response,
 * and then assigns `window.location` — which is correct but means the URL is only
 * reachable after a round trip, and a blocked or failed request leaves the user on
 * the login page with no explanation.
 *
 * The server's own `/api/v1/auth/sign-in/social` route is a 302-or-JSON endpoint
 * that builds the same authorize URL. Navigating straight to the hand-written
 * `/api/v1/auth/google/start` is a single top-level request that works with
 * JavaScript disabled and cannot fail halfway — and that route already exists and
 * is tested, so this is the path with the least machinery between the click and
 * Google.
 *
 * @param redirectTo - Same-origin path to return to. The server validates it and
 *   refuses anything absolute, so this cannot become an open redirect.
 */
export const signIn = (redirectTo = '/'): void => {
  const target = `/api/v1/auth/google/start?redirect=${encodeURIComponent(redirectTo)}`;
  window.location.assign(target);
};

/**
 * Signs out and clears client state.
 *
 * The server DELETES the session row, so this genuinely revokes: the cookie is
 * dead even if it is replayed. That is the behavioural difference from the
 * previous stateless design, where logout only asked the browser to forget.
 *
 * State is cleared even when the request fails. A logout that leaves the UI
 * looking signed in is worse than a logout that leaves a stale row server-side:
 * the first lies to the user about the state of their session.
 *
 * @throws {ApiError} On a network or server failure, after clearing local state.
 */
export const logout = async (): Promise<void> => {
  try {
    await http.postEmptyJson<unknown>('/api/v1/auth/logout');
  } finally {
    setAuthState({
      kind: 'signed-out',
      googleEnabled: authStore.state.kind === 'signed-in' ? authStore.state.googleEnabled : true,
    });
  }
};

/**
 * `POST /api/v1/auth/logout-all` — revokes every session for this account.
 *
 * @returns The number of sessions revoked.
 * @throws {ApiError} On a network or server failure, or when using the bearer
 *   token (which owns no sessions).
 */
export const logoutEverywhere = async (): Promise<number> => {
  const body = await http.postEmptyJson<{ revoked: number }>('/api/v1/auth/logout-all');
  setAuthState({ kind: 'signed-out', googleEnabled: true });
  return typeof body.revoked === 'number' ? body.revoked : 0;
};

/** Re-exported so callers get the error type from the same module as the calls. */
export { ApiError };
