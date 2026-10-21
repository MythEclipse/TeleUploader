/**
 * The TanStack Query cache — the single owner of every server value in the app.
 *
 * ## Why a module-level client
 *
 * Kana's rule is that server data lives in the Query cache and nowhere else: no
 * `useState` copy of a listing, no store holding a bucket list. That only holds if
 * there is exactly ONE client. A client created inside a component is a new cache
 * per render, so two components reading "the bucket list" would each fetch their
 * own and could disagree — the class of bug the rule exists to prevent.
 *
 * Module-level also lets the router's `beforeLoad` guards prefetch through the same
 * cache the components read, which is what makes a guard's prefetch actually
 * populate the page instead of warming a second, orphaned cache.
 *
 * ## Defaults, and why each one
 *
 * | Option | Value | Reason |
 * |---|---|---|
 * | `staleTime` | 30s | A listing is not a live feed. Without a stale time every window refocus refetches every visible query, and a file browser refocuses constantly. |
 * | `gcTime` | 5min | Long enough that navigating into a folder and back is instant; short enough that a stale tenant's data is not held after a sign-out. |
 * | `retry` | 1 | The API is on the same origin, so a failure is a real failure (4xx/5xx), not a flaky link. One retry covers a dropped connection; three would just delay the error. |
 * | `refetchOnWindowFocus` | false | See `staleTime`. Explicit rather than implied. |
 *
 * `retry` is a function so a 4xx is never retried: a 401 will not become a 200,
 * and retrying a 403 on every focus is how a rate limiter locks a user out of
 * their own account.
 */

import { QueryClient } from '@tanstack/react-query';

/**
 * Retries a failed query at most once, and never for a client error.
 *
 * A 4xx is the server's final answer — retrying it cannot change the outcome, and
 * on the auth routes it actively hurts: `/api/v1/*` answers 401 for a signed-out
 * visitor, which is a normal state that must render immediately rather than after
 * a retry delay.
 *
 * @param failureCount - How many times this query has already failed (0-based).
 * @param error - Whatever the query function threw.
 * @returns Whether to try again.
 */
const retryOnceUnlessClientError = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 1) return false;
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500) return false;
  return true;
};

/**
 * Digs an HTTP status out of whatever a rejected query threw.
 *
 * oRPC does not throw `Response` objects — it throws its own error whose `data`
 * may carry the status, and a raw-fetch failure throws `ApiError`. Rather than
 * couple this module to either type, it reads the two shapes a status can appear
 * in and returns `null` for anything else (which means "retry once", the benign
 * default).
 *
 * @param error - The thrown value.
 * @returns The status, or `null` when it cannot be determined.
 */
const statusOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) return null;
  if ('status' in error && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  if ('data' in error) {
    const { data } = error as { data?: unknown };
    if (typeof data === 'object' && data !== null && 'status' in data) {
      const status = (data as { status?: unknown }).status;
      if (typeof status === 'number') return status;
    }
  }
  return null;
};

/**
 * The one cache for this document.
 *
 * Exported as a value, not created in a provider, so `beforeLoad` guards can call
 * `queryClient.ensureQueryData(...)` before any component mounts.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: retryOnceUnlessClientError,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // A mutation is a user's explicit intent. Retrying one automatically can
      // double-create a bucket or double-delete an object, so it never retries.
      retry: false,
    },
  },
});

/** Exposed for tests that need to assert retry policy without a live server. */
export const __testing = { retryOnceUnlessClientError, statusOf };
