/**
 * Repository interface for resolving a session identity to its organization.
 *
 * P3: the dashboard REST surface and the oRPC surface are mounted behind the
 * admin session but not behind an S3 access key, so they have no SigV4
 * credential to resolve a tenant from. This is the seam that maps the
 * authenticated identity to the organization whose buckets it may touch.
 *
 * It is a port rather than a bare `db.execute` call at the call site so the
 * resolution is mockable in exactly the way the other repositories are — a
 * direct query would reach for a live database inside a test that mocks the
 * repository layer.
 */
export interface IOrganizationRepository {
	/**
	 * Find the organization a user is a member of.
	 *
	 * @param userId - The authenticated identity's user id.
	 * @returns The organization UUID, or `null` when the user has no membership.
	 *          `null` MUST NOT be treated by callers as "global access".
	 */
	findOrganizationIdByUserId(userId: string): Promise<string | null>;
}
