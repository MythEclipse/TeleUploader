import { sql } from "drizzle-orm";
import type { S3Credential } from "../../../domain/entities/s3-credential";
import type { IS3CredentialRepository } from "../../../domain/ports/s3-credential-repository";
import { db } from "../drizzle/index";

/** Array of raw result rows from `db.execute()`. */
type QueryResult = Record<string, unknown>[];

/**
 * Maps a raw database row to an {@link S3Credential} domain entity.
 */
const mapRowToCredential = (row: Record<string, unknown>): S3Credential => ({
	id: row.id as string,
	organizationId: row.organization_id as string,
	accessKey: row.access_key as string,
	secretKey: row.secret_key as string,
});

/**
 * Drizzle-backed implementation of {@link IS3CredentialRepository}.
 *
 * Backs the `s3_credentials` table declared at `drizzle/schema.ts`. The secret
 * is selected here and nowhere else; it exists solely to be handed to
 * `getSigningKey`, so this repository decides WHICH bytes sign — never HOW.
 */
export class DrizzleS3CredentialRepository implements IS3CredentialRepository {
	/**
	 * {@inheritDoc IS3CredentialRepository.findByAccessKey}
	 *
	 * `access_key` carries the `s3_credentials_access_key_unique` constraint, so
	 * this is single-row by construction; `LIMIT 1` makes that explicit.
	 */
	async findByAccessKey(accessKey: string): Promise<S3Credential | null> {
		const result = (await db.execute(
			sql`SELECT id, organization_id, access_key, secret_key FROM s3_credentials WHERE access_key = ${accessKey} LIMIT 1`
		)) as unknown as QueryResult;
		if (result.length === 0) return null;
		return mapRowToCredential(result[0]!);
	}

	/**
	 * {@inheritDoc IS3CredentialRepository.touchLastUsed}
	 *
	 * Swallows its own failure: this is auditing, and a bookkeeping write must
	 * never turn an authenticated request into a 500.
	 */
	async touchLastUsed(id: string): Promise<void> {
		await db
			.execute(sql`UPDATE s3_credentials SET last_used_at = NOW() WHERE id = ${id}::uuid`)
			.catch(() => {});
	}
}
