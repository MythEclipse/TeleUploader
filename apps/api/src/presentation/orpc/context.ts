/**
 * oRPC context (P2c).
 *
 * Carries what every procedure needs. `organizationId` and `role` are declared
 * now but stay absent until P3 lands tenancy. They are intentionally optional
 * with NO default, so a procedure that reads one before P3 gets `undefined` and
 * fails loudly — rather than silently operating against a global scope that P3
 * would then have to unwind.
 */
export interface AppRouterContext {
  /** Incoming request headers, for procedures needing raw header access. */
  readonly headers: Headers;
  /**
   * Server origin, used to build absolute URLs when adapting to the
   * `Request`-taking controllers.
   */
  readonly baseUrl: string;
  /** Set by P3 once buckets are organization-scoped. */
  readonly organizationId?: string;
  /** Set by P3 once the two-layer role system lands. */
  readonly role?: 'owner' | 'admin' | 'member';
}
