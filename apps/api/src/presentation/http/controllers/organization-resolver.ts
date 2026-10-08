import { organizationRepository } from '../../../infrastructure/di';

/**
 * Resolves the organization that owns the authenticated admin session.
 *
 * P3: the dashboard REST surface (`/api/v1/*`) and the oRPC surface (`/rpc/*`)
 * sit behind the same admin session but are not SigV4-signed, so neither has an
 * access key to resolve a tenant from. Both use this instead, which keeps the
 * two surfaces on the SAME organization — the one their S3 credential maps to —
 * so a bucket reachable through one surface is reachable through the other.
 *
 * Returns `null` when the membership is missing. Callers must treat that as
 * "no tenant" and deny; it is never "global access".
 *
 * @returns The organization UUID, or `null` when the admin has no membership.
 */
export const resolveAdminOrganizationId = async (): Promise<string | null> =>
  organizationRepository.findOrganizationIdByUserId(bootstrapAdminUserId());

/**
 * The bootstrap admin's user id.
 *
 * Read from the same env var seed.ts uses, so the seeder and the request path
 * cannot disagree about who the admin is.
 */
const bootstrapAdminUserId = (): string => process.env.BOOTSTRAP_ADMIN_ID ?? 'bootstrap-admin';
