/**
 * Core domain entity representing an S3 access key that resolves to an
 * organization.
 *
 * P3: the SigV4 wire protocol is unchanged — only the LOOKUP moved from the
 * environment pair to the database. An access key seeded from
 * S3_ACCESS_KEY/S3_SECRET_KEY keeps every existing aws-cli / rclone /
 * Docker-registry client working with no configuration change.
 */
export interface S3Credential {
	/** Primary key, UUID */
	id: string;
	/**
	 * Owning organization (UUID).
	 *
	 * This is the tenancy root of the S3 surface: it is what every bucket
	 * lookup downstream is scoped by.
	 */
	organizationId: string;
	/** The access key presented in the SigV4 credential scope. */
	accessKey: string;
	/**
	 * The signing secret.
	 *
	 * Stored in the same bytes the client signs with. It feeds exactly one
	 * function, `getSigningKey`, so reading it from here instead of the
	 * environment cannot change a signed byte.
	 */
	secretKey: string;
}
