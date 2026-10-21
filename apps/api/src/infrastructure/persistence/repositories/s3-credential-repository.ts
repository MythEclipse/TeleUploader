import { sql } from "drizzle-orm";
import {
	generateAccessKey,
	generateSecretKey,
	isUniqueViolation,
} from "../../../application/shared/utils/credentials";
import type { S3Credential } from "../../../domain/entities/s3-credential";
import type {
	IS3CredentialRepository,
	S3CredentialSummary,
} from "../../../domain/ports/s3-credential-repository";
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
 * Maps a raw database row to a secret-free {@link S3CredentialSummary}.
 *
 * `mapRowToCredential` is deliberately NOT reused as a base: building this by
 * deleting a field is how a secret escapes into a JSON response, and the mapper
 * below cannot name `secret_key` at all.
 */
const mapRowToSummary = (row: Record<string, unknown>): S3CredentialSummary => ({
	id: row.id as string,
	organizationId: row.organization_id as string,
	accessKey: row.access_key as string,
	label: (row.label as string | null) ?? null,
	lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string).toISOString() : null,
	createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : null,
});

/** Column list for every summary query, so the secret is never selected. */
const SUMMARY_COLUMNS = "id, organization_id, access_key, label, last_used_at, created_at";

/**
 * Drizzle-backed implementation of {@link IS3CredentialRepository}.
 *
 * Backs the `s3_credentials` table declared at `drizzle/schema.ts`. The secret
 * is selected in exactly two places — `findByAccessKey`, where it exists solely
 * to be handed to `getSigningKey`, and `create`, where it is returned once to
 * the person who asked for it. Every read path the dashboard uses goes through
 * {@link listByOrganization}, whose query cannot name the column.
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

	/**
	 * {@inheritDoc IS3CredentialRepository.listByOrganization}
	 */
	async listByOrganization(organizationId: string): Promise<S3CredentialSummary[]> {
		const result = (await db.execute(
			sql`SELECT ${sql.raw(SUMMARY_COLUMNS)} FROM s3_credentials WHERE organization_id = ${organizationId}::uuid ORDER BY created_at DESC NULLS LAST`
		)) as unknown as QueryResult;
		return result.map(mapRowToSummary);
	}

	/**
	 * {@inheritDoc IS3CredentialRepository.create}
	 *
	 * Retries on the unique-violation of `access_key` rather than trusting 160
	 * random bits to never collide. A collision is astronomically unlikely, and
	 * that is exactly why it must be handled: the alternative is a one-in-2^160
	 * failure that surfaces as an unexplained 500 with no retry path.
	 */
	async create(
		organizationId: string,
		label: string
	): Promise<{ credential: S3CredentialSummary; secretKey: string }> {
		const secretKey = generateSecretKey();

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const accessKey = generateAccessKey();
			try {
				const result = (await db.execute(
					sql`INSERT INTO s3_credentials (organization_id, access_key, secret_key, label) VALUES (${organizationId}::uuid, ${accessKey}, ${secretKey}, ${label}) RETURNING ${sql.raw(SUMMARY_COLUMNS)}`
				)) as unknown as QueryResult;
				const row = result[0];
				if (!row) throw new Error("INSERT ... RETURNING produced no row");
				return { credential: mapRowToSummary(row), secretKey };
			} catch (error: unknown) {
				if (!isUniqueViolation(error)) throw error;
			}
		}

		throw new Error("Could not allocate a unique S3 access key after 3 attempts");
	}

	/**
	 * {@inheritDoc IS3CredentialRepository.delete}
	 */
	async delete(id: string, organizationId: string): Promise<boolean> {
		const result = (await db.execute(
			sql`DELETE FROM s3_credentials WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid RETURNING id`
		)) as unknown as QueryResult;
		return result.length > 0;
	}
}
