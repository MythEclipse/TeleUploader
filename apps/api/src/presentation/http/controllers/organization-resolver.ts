import { config } from '../../../env';
import { organizationRepository } from '../../../infrastructure/di';
import logger from '../../../infrastructure/observability/logger';

/**
 * Resolves the ONE organization the dashboard surfaces are scoped to.
 *
 * ── IT IS NOT SESSION-SCOPED. DO NOT READ IT AS IF IT WERE. ────────────────
 *
 * The previous doc comment here claimed this "resolves the organization that
 * owns the authenticated admin session". That was false and it was load-bearing:
 * this function takes no request and no session, and it never consults one. The
 * session cannot identify a tenant today — `AuthSession` carries only a
 * `username`, the login flow hardcodes it to the literal `"admin"`, and
 * `parseSessionFromCookie` REJECTS any cookie whose `u` is not exactly that
 * string. So there is no user identity in the session to resolve, and per-user
 * tenancy is P3c (better-auth), deliberately deferred. Claiming otherwise here
 * is what let a missing membership read as an authorization decision.
 *
 * What it actually does: it maps the CONFIGURED BOOTSTRAP ADMIN
 * (`BOOTSTRAP_ADMIN_ID`, default `bootstrap-admin` — the same id seed.ts writes)
 * to its organization. Both the REST (`/api/v1/*`) and oRPC (`/rpc/*`) surfaces
 * call this, which is the point: those surfaces are not SigV4-signed and have no
 * access key to resolve a tenant from, so this keeps them on the SAME
 * organization their S3 credentials map to.
 *
 * ── WHY A MISSING MEMBERSHIP THROWS INSTEAD OF RETURNING NULL ─────────────
 *
 * A missing membership is a MISCONFIGURATION, not an authorization decision.
 * Returning null here produced a 403 on every dashboard request — including
 * `GET /api/v1/buckets`, a route documented PUBLIC — and a 401 on every oRPC
 * procedure, for a reason that had nothing to do with who was asking. Worse,
 * every test stubbed this lookup to a constant, so the green suite reported
 * health while a real deploy served nothing but denials.
 *
 * The remedy is `pnpm db:seed` (or creating the membership), so the service
 * refuses to come up instead of answering. Fail at boot, once, loudly: an
 * operator sees it in the first second. Do not turn this back into a per-request
 * null — that is the defect this file exists to close.
 *
 * @returns The bootstrap admin's organization UUID.
 * @throws {MissingOrganizationMembershipError} When the bootstrap admin has no
 *   membership row. That is a deployment error, not a denied caller.
 */
export class MissingOrganizationMembershipError extends Error {
  constructor(readonly userId: string) {
    super(
      `No organization membership for the bootstrap admin "${userId}". ` +
        'The dashboard REST (/api/v1/*) and oRPC (/rpc/*) surfaces are scoped to that ' +
        'membership, so without it every bucket request would be denied. Run ' +
        '`pnpm db:seed` to create the bootstrap organization and owner membership, ' +
        'or point BOOTSTRAP_ADMIN_ID at an existing member. Refusing to start.',
    );
    this.name = 'MissingOrganizationMembershipError';
  }
}

/**
 * Memoized resolution result, so a healthy deploy pays one lookup at boot and
 * a broken one throws once rather than on every request.
 */
let resolved: Promise<string> | null = null;

/** Test seam: drops the memoized value so a test can observe a fresh lookup. */
export const resetOrganizationResolutionCache = (): void => {
  resolved = null;
};

/**
 * The bootstrap admin's organization, resolved once and cached.
 *
 * @returns The organization UUID.
 * @throws {MissingOrganizationMembershipError} When no membership exists.
 */
export const resolveAdminOrganizationId = async (): Promise<string> => {
  if (!resolved) {
    resolved = (async () => {
      const userId = config.bootstrapAdminId;
      const organizationId = await organizationRepository.findOrganizationIdByUserId(userId);
      if (!organizationId) {
        // Log at error: this is the misconfiguration the exception describes, and
        // `systemctl status` / the deploy log is where the operator will look.
        logger.error(
          'Bootstrap admin has no organization membership — tenant scoping unavailable',
          {
            userId,
            hint: 'Run `pnpm db:seed`, or set BOOTSTRAP_ADMIN_ID to an existing member.',
          },
        );
        throw new MissingOrganizationMembershipError(userId);
      }
      return organizationId;
    })().catch((error: unknown) => {
      // Do not cache a failure: a membership can be created without a restart,
      // and caching the rejection would keep denying after an operator fixes it.
      resolved = null;
      throw error;
    });
  }
  return resolved;
};
