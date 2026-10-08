/**
 * oRPC context (P2c).
 *
 * Carries what every procedure needs. `role` is still absent until the
 * two-layer role system lands.
 *
 * P3: `organizationId` is REQUIRED, not optional. It was optional only so a
 * procedure reading it before P3 would get `undefined` and fail loudly; now that
 * tenancy is live, every procedure must have one, and the compiler is the thing
 * that guarantees it — an optional field would let a new procedure be added
 * with no organization and silently operate against whatever it was handed.
 */
export interface AppRouterContext {
  /** Incoming request headers, for procedures needing raw header access. */
  readonly headers: Headers;
  /**
   * Server origin, used to build absolute URLs when adapting to the
   * `Request`-taking controllers.
   */
  readonly baseUrl: string;
  /**
   * The authenticated caller's organization (UUID).
   *
   * P3: resolved from the admin session's membership by `buildOrpcContext`.
   * Every bucket read and write on this surface is scoped by it.
   */
  readonly organizationId: string;
  /** Set by P4 once the two-layer role system lands. */
  readonly role?: 'owner' | 'admin' | 'member';
}
