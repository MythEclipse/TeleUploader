import type { S3Credential } from "../entities/s3-credential";

/**
 * Repository interface for S3 credential persistence.
 *
 * P3: this is the single seam through which a SigV4 access key becomes an
 * organization. Before it existed, the only place in `src/` that read
 * `config.s3AccessKey` / `config.s3SecretKey` for verification was
 * `s3-router.ts`, so there was no way for a key that existed only in the
 * database to authenticate.
 *
 * ## Why the management methods live on this port
 *
 * An organization with a bucket but no key cannot be reached by `aws-cli`,
 * `rclone` or the Docker registry client — the S3 surface has NO environment
 * fallback, so every key that works is a row here. "Each user has their own
 * bucket" is therefore only half true without a key pair scoped to their
 * organization, and issuing one is an operation the dashboard performs on the
 * caller's own tenant.
 *
 * Every management method takes an `organizationId` and is scoped by it, for
 * the same reason `IBucketRepository` does: a lookup that omits the tenant
 * resolves another organization's credential.
 */
export interface IS3CredentialRepository {
	/**
	 * Look up a credential by its access key.
	 *
	 * @param accessKey - The access key from the SigV4 credential scope.
	 * @returns The matching credential, or `null` when no such key exists.
	 */
	findByAccessKey(accessKey: string): Promise<S3Credential | null>;

	/**
	 * Record that a credential was used, for auditing.
	 *
	 * MUST NOT be able to fail the request: a bookkeeping write that throws
	 * would turn a successful upload into a 500.
	 *
	 * @param id - The credential's UUID.
	 */
	touchLastUsed(id: string): Promise<void>;

	/**
	 * List the credentials belonging to one organization, newest first.
	 *
	 * @param organizationId - The owning organization's UUID.
	 * @returns The credentials WITHOUT secrets. Use {@link findByAccessKey}
	 *   when the signing secret is actually needed.
	 */
	listByOrganization(organizationId: string): Promise<S3CredentialSummary[]>;

	/**
	 * Create a credential for one organization.
	 *
	 * @param organizationId - The owning organization's UUID.
	 * @param label - Human label, e.g. "rclone on laptop".
	 * @returns The created credential and its secret, which is the only
	 *   moment the secret is readable — {@link listByOrganization} strips it.
	 */
	create(
		organizationId: string,
		label: string
	): Promise<{ credential: S3CredentialSummary; secretKey: string }>;

	/**
	 * Delete one credential, but only within its own organization.
	 *
	 * The organization predicate IS the authorization: without it, an id from
	 * another tenant would be deletable by anyone who learned it.
	 *
	 * @param id - The credential's UUID.
	 * @param organizationId - The organization the caller is scoped to.
	 * @returns `true` when a row was removed.
	 */
	delete(id: string, organizationId: string): Promise<boolean>;
}

/**
 * An S3 credential as the dashboard renders it — NEVER with the secret.
 *
 * A separate type rather than `Omit<S3Credential, "secretKey">` so a caller
 * cannot accidentally widen it back: there is no `secretKey` property to pick
 * up, and adding one is a visible change.
 */
export interface S3CredentialSummary {
	readonly id: string;
	readonly organizationId: string;
	readonly accessKey: string;
	/** Human label, or `null` when it was seeded from the environment. */
	readonly label: string | null;
	/** ISO-8601, or `null` for a credential that has never been used. */
	readonly lastUsedAt: string | null;
	/** ISO-8601, or `null` when the column default supplied it. */
	readonly createdAt: string | null;
}
