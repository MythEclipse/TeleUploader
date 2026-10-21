/**
 * Unit tests for the dashboard's pure auth logic.
 *
 * Run with: `bun test apps/web/src/lib/auth.test.ts`
 *
 * ## Why these live here and not in vitest
 *
 * `apps/web` has no test runner of its own — `apps/api` owns `vitest.config.ts` and its
 * suite mocks the database. The functions under test here are PURE (no React, no fetch,
 * no DOM), so `bun test` runs them directly with no config, no jsdom, and no new
 * dependency in the workspace.
 *
 * ## What is actually being defended
 *
 * These four functions decide which tenant the UI shows and whether it offers write
 * controls. Both are places where a plausible-looking implementation is wrong in a way
 * that looks fine:
 *
 *  - `orgSlugFromPath` must not read `/login` as an organization called `login`;
 *  - `activeOrganizationOf` must return `null` for a slug the account is not a member of,
 *    never silently fall back to a different tenant;
 *  - `canWrite` must be true for an OPEN deployment, where the server accepts writes;
 *  - `probeAuth` must pass `method` through verbatim rather than defaulting to `cookie`;
 *  - `probeAuth` must READ `googleEnabled` off a 401 instead of assuming Google works.
 */

import { describe, expect, test } from 'bun:test';
import type { AuthState } from './auth';
import {
  activeOrganizationOf,
  canWrite,
  isOpenDeployment,
  isReadOnly,
  organizationsOf,
  orgSlugFromPath,
  probeAuth,
  shouldOfferLogin,
} from './auth';

/** A signed-in cookie session with the given memberships. */
const signedIn = (
  organizations: readonly {
    id: string;
    slug: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
  }[],
  method: 'cookie' | 'bearer' | 'disabled' = 'cookie',
): AuthState => ({
  kind: 'signed-in',
  userId: 'user-1',
  email: 'person@example.com',
  name: 'A Person',
  avatarUrl: null,
  expiresAt: null,
  method,
  organizations,
  googleEnabled: true,
});

const personal = { id: 'o1', slug: 'alice', name: 'Alice', role: 'owner' as const };
const team = { id: 'o2', slug: 'team', name: 'Team', role: 'member' as const };

describe('orgSlugFromPath', () => {
  test('reads the first segment of an organization route', () => {
    expect(orgSlugFromPath('/alice/dashboard')).toBe('alice');
    expect(orgSlugFromPath('/team/photos')).toBe('team');
    expect(orgSlugFromPath('/alice')).toBe('alice');
  });

  test('returns undefined for the root path', () => {
    expect(orgSlugFromPath('/')).toBeUndefined();
    expect(orgSlugFromPath('')).toBeUndefined();
  });

  test('does NOT read /login as an organization called login', () => {
    // Without the reserved list this would be `'login'`, and `activeOrganizationOf` would
    // then return null on the login page — rendering "no workspace" in the top bar of the
    // one page a signed-out visitor sees.
    expect(orgSlugFromPath('/login')).toBeUndefined();
    expect(orgSlugFromPath('/login?redirect=%2Falice')).toBeUndefined();
  });

  test('decodes a percent-encoded slug', () => {
    expect(orgSlugFromPath('/a%20b/dashboard')).toBe('a b');
  });
});

describe('activeOrganizationOf', () => {
  test('follows the slug in the URL, not the personal organization', () => {
    // The defect this guards: picking `role === 'owner'` unconditionally showed org A's
    // name on org B's dashboard.
    expect(activeOrganizationOf(signedIn([personal, team]), 'team')?.slug).toBe('team');
  });

  test('falls back to the personal organization when the URL names none', () => {
    expect(activeOrganizationOf(signedIn([team, personal]))?.slug).toBe('alice');
  });

  test('falls back to the first when no organization is owned', () => {
    expect(activeOrganizationOf(signedIn([team]), undefined)?.slug).toBe('team');
  });

  test('returns null for a slug the account is NOT a member of', () => {
    // Returning the default here would DISPLAY a tenant the URL did not name. The caller
    // renders "no workspace" instead.
    expect(activeOrganizationOf(signedIn([personal]), 'someone-elses-org')).toBeNull();
  });

  test('returns null when there are no organizations at all', () => {
    expect(activeOrganizationOf(signedIn([]))).toBeNull();
  });

  test('returns null when signed out', () => {
    expect(activeOrganizationOf({ kind: 'signed-out', googleEnabled: true })).toBeNull();
  });
});

describe('canWrite', () => {
  test('is true for a cookie session with a workspace', () => {
    expect(canWrite(signedIn([personal]))).toBe(true);
  });

  test('is true for an OPEN deployment, because the server accepts the write', () => {
    // The whole point of the `disabled` method: `requireAuth` is a pass-through, so a
    // read-only UI would be wrong about the deployment rather than cautious about it.
    expect(canWrite(signedIn([personal], 'disabled'))).toBe(true);
    expect(isOpenDeployment(signedIn([personal], 'disabled'))).toBe(true);
  });

  test('is false with no workspace, even when signed in', () => {
    expect(canWrite(signedIn([]))).toBe(false);
  });

  test('is false when signed out or unknown', () => {
    expect(canWrite({ kind: 'signed-out', googleEnabled: true })).toBe(false);
    expect(canWrite({ kind: 'unknown' })).toBe(false);
  });

  test('read-only is exactly the negation of canWrite', () => {
    for (const state of [signedIn([personal]), signedIn([]), { kind: 'unknown' } as const]) {
      expect(isReadOnly(state)).toBe(!canWrite(state));
    }
  });
});

describe('shouldOfferLogin', () => {
  test('is true only for a genuine 401', () => {
    expect(shouldOfferLogin({ kind: 'signed-out', googleEnabled: true })).toBe(true);
  });

  test('is false for an open deployment, which has nothing to sign into', () => {
    expect(shouldOfferLogin(signedIn([personal], 'disabled'))).toBe(false);
  });

  test('is false for an authenticated caller', () => {
    expect(shouldOfferLogin(signedIn([personal]))).toBe(false);
  });
});

describe('organizationsOf', () => {
  test('returns the memberships when signed in', () => {
    expect(organizationsOf(signedIn([personal, team]))).toHaveLength(2);
  });

  test('returns an empty list when signed out', () => {
    expect(organizationsOf({ kind: 'signed-out', googleEnabled: true })).toEqual([]);
  });
});

describe('probeAuth', () => {
  /** Replaces `globalThis.fetch` for one call, then restores it. */
  const withFetch = async (
    response: () => Response | Promise<Response>,
    run: () => Promise<void>,
  ): Promise<void> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => response()) as typeof globalThis.fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  test('maps a 401 to signed-out', async () => {
    await withFetch(
      () => new Response('{"error":"Unauthorized"}', { status: 401 }),
      async () => {
        expect((await probeAuth()).kind).toBe('signed-out');
      },
    );
  });

  test('a 401 with no googleEnabled does NOT claim Google is available', async () => {
    // The defect this pins: the 401 branch used to hardcode `googleEnabled: true`, so a
    // deployment with no Google credentials still rendered a "Sign in with Google" button
    // that dead-ended at this server's own 503. False is the honest answer for a body
    // that does not say otherwise, because a hidden button costs a click while a broken
    // one costs trust in the page.
    await withFetch(
      () => new Response('{"error":"Unauthorized"}', { status: 401 }),
      async () => {
        const state = await probeAuth();
        expect(state.kind).toBe('signed-out');
        if (state.kind === 'signed-out') expect(state.googleEnabled).toBe(false);
      },
    );
  });

  test('a 401 REPORTING googleEnabled:false disables the button', async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: 'Unauthorized', googleEnabled: false }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      async () => {
        const state = await probeAuth();
        if (state.kind !== 'signed-out') throw new Error(`expected signed-out, got ${state.kind}`);
        expect(state.googleEnabled).toBe(false);
      },
    );
  });

  test('a 401 REPORTING googleEnabled:true keeps the button', async () => {
    // The mirror of the test above, so a fix cannot be "always false" and pass.
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: 'Unauthorized', googleEnabled: true }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      async () => {
        const state = await probeAuth();
        if (state.kind !== 'signed-out') throw new Error(`expected signed-out, got ${state.kind}`);
        expect(state.googleEnabled).toBe(true);
      },
    );
  });

  test('a 401 with a non-JSON body still maps to signed-out', async () => {
    // A proxy or an error page can answer a non-JSON 401. `res.json()` would throw and
    // the probe must not turn that into `unknown` (which renders as read-only and hides
    // the login link entirely).
    await withFetch(
      () => new Response('<html>Unauthorized</html>', { status: 401 }),
      async () => {
        const state = await probeAuth();
        expect(state.kind).toBe('signed-out');
        if (state.kind === 'signed-out') expect(state.googleEnabled).toBe(false);
      },
    );
  });

  test('passes method=disabled through verbatim', async () => {
    // Defaulting to 'cookie' here would defeat the server's own signal and reintroduce
    // the read-only-on-an-open-deployment bug at the client.
    await withFetch(
      () =>
        new Response(
          JSON.stringify({
            userId: 'bootstrap',
            email: '',
            name: 'Open deployment',
            avatarUrl: null,
            expiresAt: null,
            method: 'disabled',
            organizations: [],
            googleEnabled: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      async () => {
        const state = await probeAuth();
        expect(state.kind).toBe('signed-in');
        if (state.kind === 'signed-in') {
          expect(state.method).toBe('disabled');
          expect(state.email).toBe('');
        }
      },
    );
  });

  test('treats an unparseable 200 as unknown', async () => {
    await withFetch(
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      async () => {
        // `userId` is the one field every real 200 carries.
        expect((await probeAuth()).kind).toBe('unknown');
      },
    );
  });

  test('never throws on a network failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof globalThis.fetch;
    try {
      expect((await probeAuth()).kind).toBe('unknown');
    } finally {
      globalThis.fetch = original;
    }
  });
});
