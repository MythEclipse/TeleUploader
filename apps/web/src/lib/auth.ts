/**
 * Auth state: the state probe, plus sign-in and sign-out.
 *
 * ## Why this is a discriminated union and not a boolean
 *
 * `GET /api/v1/auth/me` is public and its HTTP STATUS is a state probe:
 *
 * | Status | Meaning to the SPA |
 * |---|---|
 * | `200` | identifiable caller (signed in, bearer token, or open deployment) |
 * | `401` | authentication is configured and no credential was presented |
 *
 * Two facts come back on a 200 and they are independent:
 *
 *  - `method` says HOW the caller was identified, including `disabled` for a
 *    deployment with authentication switched off entirely; and
 *  - `organizations` says WHAT they may reach.
 *
 * The old implementation collapsed these into a `readonly` boolean and had to guess
 * the "auth disabled" case from a 404. That guess is what made it possible for the UI
 * to claim read-only on a deployment that would accept a write. Here the server
 * states both facts and the client does not infer.
 *
 * ## Sign-in is a NAVIGATION, not a fetch
 *
 * Google's flow is a top-level redirect: the server 302s to Google, Google 302s back
 * to `/api/v1/auth/google/callback`, and the server 302s into the app with the session
 * cookie set. The SPA cannot observe that with `fetch` — the cookie is HttpOnly and the
 * redirect chain crosses origins — so `signIn` assigns `window.location` and lets the
 * browser do it. That is why there is no `login(token)` here any more.
 */

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
  /** Network failure or an unexpected status. Treated as signed-out. */
  | { readonly kind: 'unknown' };

const UNKNOWN: AuthState = { kind: 'unknown' };

/**
 * Whether the caller may perform writes.
 *
 * True for any identified caller, which includes the open deployment: the server
 * accepts writes there (`requireAuth` is a pass-through), so a read-only UI would be
 * wrong about the deployment rather than cautious about it. An empty organization list
 * is the one exception — nothing can be written to no workspace.
 */
export const canWrite = (state: AuthState): boolean =>
  state.kind === 'signed-in' && state.organizations.length > 0;

/** Whether to show the read-only badge. `unknown` and no-workspace count as read-only. */
export const isReadOnly = (state: AuthState): boolean => !canWrite(state);

/**
 * Whether to render a Sign-in button.
 *
 * Only for a genuine 401. The open-deployment case has nothing to sign into, and the
 * bearer-token case is already authenticated — offering either a login button would
 * link to a page whose only honest content is "this server has authentication
 * disabled".
 */
export const shouldOfferLogin = (state: AuthState): boolean => state.kind === 'signed-out';

/**
 * Whether this deployment has authentication switched off entirely.
 *
 * Informational, not a permission: writes ARE accepted in this mode. It exists so the
 * shell can explain the state instead of looking broken.
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
 * organization, then the first. Returning a definite organization matters: the switcher
 * and the bucket list must agree, and "no org" would render an empty dashboard for a
 * user who has one.
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
    // A slug that matches nothing is a URL the account is not a member of. Falling
    // through to the default here would DISPLAY a tenant the URL did not name, so the
    // caller gets `null` and renders not-found instead.
    if (matched) return matched;
    return null;
  }
  return organizations.find((org) => org.role === 'owner') ?? organizations[0] ?? null;
};

/**
 * Extracts the organization slug from a pathname.
 *
 * The route tree puts the organization first: `/<org>/dashboard` and `/<org>/<bucket>`.
 * `/` and `/login` have no organization segment, so this returns `undefined` and callers
 * fall back to the default.
 *
 * ## Two things this must strip before looking
 *
 * A caller may pass `location.pathname` (already query-free) or a full href. Both are
 * accepted, so a query string is dropped first — otherwise `/login?redirect=/alice`
 * yields the slug `login?redirect=/alice`, and a hash is dropped for the same reason.
 *
 * Reserved segments are then matched explicitly rather than inferred from a leading `/`,
 * because `/login` is a single-segment path that would otherwise read as an organization
 * called `login`. Both cases are covered by tests in `auth.test.ts`.
 *
 * @param pathname - `window.location.pathname`, the router's path, or a full href.
 * @returns The slug, or `undefined`.
 */
export const orgSlugFromPath = (pathname: string): string | undefined => {
  // Strip a query string or fragment if the caller passed an href rather than a path.
  const pathOnly = pathname.split(/[?#]/)[0] ?? '';
  const [first] = pathOnly.split('/').filter(Boolean);
  if (!first) return undefined;
  if (RESERVED_TOP_LEVEL_PATHS.has(first)) return undefined;
  return decodeURIComponent(first);
};

/**
 * Top-level paths that are routes in their own right, not organization slugs.
 *
 * A user whose personal organization were somehow slugged `login` would be shadowed
 * here — but `ensurePersonalOrganization` derives slugs from the email local part and
 * `login`/`api` and friends must not be claimable, so keeping this list authoritative is
 * the correct trade: a broken route is worse than an unreachable org, and the account
 * still has its dashboard at `/<org>/dashboard`.
 */
const RESERVED_TOP_LEVEL_PATHS: ReadonlySet<string> = new Set(['login']);

/**
 * Reads `GET /api/v1/auth/me` and maps the status onto {@link AuthState}.
 *
 * Never throws: an auth probe that rejected would leave the UI unable to decide what to
 * render, which is the "read-only by accident" state this module exists to make
 * explicit.
 *
 * @returns The probed state.
 */
export const probeAuth = async (): Promise<AuthState> => {
  try {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });

    // 401 is the only "authentication is configured and you presented nothing" signal.
    // A 404 would mean the route is missing, which is a deployment bug and must not be
    // read as "public access".
    if (res.status === 401) return { kind: 'signed-out', googleEnabled: true };
    if (!res.ok) return UNKNOWN;

    const body = (await res.json()) as Partial<MeResponse>;
    // `userId` is the one field every 200 carries — including the open deployment, where
    // it is the bootstrap admin id. Its absence means a shape this build cannot read.
    if (typeof body.userId !== 'string') return UNKNOWN;

    return {
      kind: 'signed-in',
      userId: body.userId,
      email: typeof body.email === 'string' ? body.email : '',
      name: typeof body.name === 'string' ? body.name : '',
      avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : null,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      // Passed through verbatim rather than defaulted to 'cookie': `disabled` is the flag
      // that stops the shell from claiming read-only on an open deployment, so guessing
      // here would defeat the point of the server stating it.
      method:
        body.method === 'bearer' || body.method === 'disabled' ? body.method : 'cookie',
      organizations: Array.isArray(body.organizations) ? body.organizations : [],
      googleEnabled: body.googleEnabled === true,
    };
  } catch {
    return UNKNOWN;
  }
};

/**
 * Starts the Google sign-in flow by navigating the browser to it.
 *
 * Deliberately does NOT use `fetch`. The flow is a full-page redirect chain that
 * ends with the server setting an HttpOnly cookie on this origin; fetching it would
 * follow the 302s inside an XHR, land on Google's HTML, and never store the cookie.
 *
 * @param redirectTo - Same-origin path to return to. The server validates it and
 *   refuses anything absolute, so this cannot become an open redirect.
 */
export const signIn = (redirectTo = '/'): void => {
  const target = `/api/v1/auth/google/start?redirect=${encodeURIComponent(redirectTo)}`;
  window.location.assign(target);
};

/**
 * `POST /api/v1/auth/logout`.
 *
 * The server DELETES the session row, so this genuinely revokes: the cookie is dead
 * even if it is replayed. That is the behavioural difference from the previous
 * stateless design, where logout only asked the browser to forget.
 *
 * @throws {ApiError} On a network or server failure.
 */
export const logout = async (): Promise<void> => {
  await http.postEmptyJson<unknown>('/api/v1/auth/logout');
};

/**
 * `POST /api/v1/auth/logout-all` — revokes every session for this account.
 *
 * @returns The number of sessions revoked.
 * @throws {ApiError} On a network or server failure, or when using the bearer token
 *   (which owns no sessions).
 */
export const logoutEverywhere = async (): Promise<number> => {
  const body = await http.postEmptyJson<{ revoked: number }>('/api/v1/auth/logout-all');
  return typeof body.revoked === 'number' ? body.revoked : 0;
};

/** Re-exported so callers get the error type from the same module as the calls. */
export { ApiError };
