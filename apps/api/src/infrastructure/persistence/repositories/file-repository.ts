import { and, eq, sql } from "drizzle-orm";
import {
	DestinationExistsError,
	isUniqueViolation,
} from "../../../application/shared/utils/credentials";
import type { File, NewFile } from "../../../domain/entities/file";
import type {
	BucketUsage,
	IFileManagementRepository,
	IFileRepository,
	ObjectSearchHit,
	OrganizationUsage,
	S3FileRecord,
} from "../../../domain/ports/file-repository";
import { config } from "../../../env";
import { db, files as fileSchema } from "../drizzle/index";
import type { FileRow } from "../drizzle/schema";

/** Safely converts a raw value to a number, defaulting to 0. */
const toNumber = (value: unknown): number => Number(value ?? 0);

/**
 * Escape special LIKE wildcard characters (`%`, `_`, `\`) so that
 * a user-supplied prefix can be safely used in a LIKE expression.
 */
const escapeLike = (s: string): string => s.replace(/[%_\\]/g, "\\$&");

/**
 * Maps a typed drizzle row (camelCase keys) to a {@link File} domain entity.
 *
 * P2a: the `db.select().from(files)` queries were returning raw drizzle rows
 * directly as domain entities. That happened to typecheck only while the schema
 * lied about nullability — `created_at`/`updated_at` are nullable in the database
 * (DEFAULT but no NOT NULL), so drizzle correctly infers `Date | null` while the
 * entity declares `Date`.
 *
 * The domain type is left strict on purpose: the column defaults to
 * CURRENT_TIMESTAMP on insert, so a null timestamp means a row that predates that
 * default, and no caller reads it. Loosening `File` to `Date | null` would push
 * that concern into every consumer instead of handling it once, here.
 */
const mapFileRow = (row: FileRow): File => ({
	...row,
	createdAt: row.createdAt ?? new Date(0),
	updatedAt: row.updatedAt ?? new Date(0),
});

/**
 * Maps a raw database row (snake_case keys) to an {@link S3FileRecord}
 * domain entity.  Used only when raw SQL via `db.execute()` returns
 * un-typed result sets.
 */
const mapDbRowToS3Record = (row: Record<string, unknown>): S3FileRecord => ({
	id: row.id as string,
	publicId: row.public_id as string,
	telegramFileId: row.telegram_file_id as string,
	telegramFileUniqueId: row.telegram_file_unique_id as string,
	storageChatId: toNumber(row.storage_chat_id),
	storageMessageId: toNumber(row.storage_message_id),
	fileName: row.file_name as string,
	mimeType: row.mime_type as string,
	sizeBytes: toNumber(row.size_bytes),
	fileType: row.file_type as string,
	uploaderId: toNumber(row.uploader_id),
	uploaderUserId: (row.uploader_user_id as string | null) ?? null,
	fileHash: row.file_hash as string | null,
	archiveTelegramFileId: row.archive_telegram_file_id as string | null,
	archiveStorageMessageId:
		row.archive_storage_message_id === null ? null : toNumber(row.archive_storage_message_id),
	archiveFileName: row.archive_file_name as string | null,
	archiveEntryName: row.archive_entry_name as string | null,
	archiveMimeType: row.archive_mime_type as string | null,
	archiveSizeBytes: row.archive_size_bytes === null ? null : toNumber(row.archive_size_bytes),
	bucketId: row.bucket_id as string,
	s3Key: row.s3_key as string,
	storageBackend: (row.storage_backend as string) || "telegram",
	isDeleted: row.is_deleted as boolean,
	multipartUploadId: row.multipart_upload_id as string | null,
	partCount:
		row.part_count === null || row.part_count === undefined ? null : toNumber(row.part_count),
	createdAt: new Date(row.created_at as string),
	updatedAt: new Date(row.updated_at as string),
});

/**
 * Drizzle-backed implementation of {@link IFileRepository}.
 *
 * Delegates to the same SQL queries as the original `infrastructure/persistence/repositories/file-repository.ts` and
 * `infrastructure/persistence/repositories/file-repository.ts` modules while presenting a clean domain interface.
 */
export class DrizzleFileRepository implements IFileRepository, IFileManagementRepository {
	/**
	 * {@inheritDoc IFileRepository.findByHash}
	 */
	async findByHash(hash: string): Promise<File | null> {
		const result = await db.select().from(fileSchema).where(eq(fileSchema.fileHash, hash)).limit(1);
		return result[0] ? mapFileRow(result[0]) : null;
	}

	/**
	 * {@inheritDoc IFileRepository.findByPublicId}
	 */
	async findByPublicId(publicId: string): Promise<File | null> {
		const result = await db
			.select()
			.from(fileSchema)
			.where(eq(fileSchema.publicId, publicId))
			.limit(1);
		return result[0] ? mapFileRow(result[0]) : null;
	}

	/**
	 * {@inheritDoc IFileRepository.findByUniqueId}
	 */
	async findByUniqueId(telegramFileUniqueId: string): Promise<File | null> {
		const result = await db
			.select()
			.from(fileSchema)
			.where(eq(fileSchema.telegramFileUniqueId, telegramFileUniqueId))
			.limit(1);
		return result[0] ? mapFileRow(result[0]) : null;
	}

	/**
	 * {@inheritDoc IFileRepository.findByBucketAndKey}
	 */
	async findByBucketAndKey(bucketId: string, s3Key: string): Promise<File | null> {
		const result = await db
			.select()
			.from(fileSchema)
			.where(
				and(
					eq(fileSchema.bucketId, bucketId),
					eq(fileSchema.s3Key, s3Key),
					eq(fileSchema.isDeleted, false)
				)
			)
			.limit(1);
		return result[0] ? mapFileRow(result[0]) : null;
	}

	/**
	 * {@inheritDoc IFileRepository.create}
	 */
	async create(file: NewFile): Promise<File> {
		const result = await db.insert(fileSchema).values(file).returning();
		return mapFileRow(result[0]!);
	}

	/**
	 * {@inheritDoc IFileRepository.listByPrefix}
	 */
	async listByPrefix(
		bucketId: string,
		prefix: string,
		delimiter: string | null,
		maxKeys: number,
		startAfter: string | null
	): Promise<{ objects: S3FileRecord[]; prefixes: string[] }> {
		let query = prefix
			? sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false AND s3_key LIKE ${`${escapeLike(prefix)}%`}`
			: sql`SELECT * FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`;

		if (startAfter) {
			query = sql`${query} AND s3_key > ${startAfter}`;
		}

		query = sql`${query} ORDER BY s3_key LIMIT ${maxKeys + 1}`;

		const rawResult = (await db.execute(query)) as unknown as Record<string, unknown>[];

		if (delimiter === "/") {
			const prefixSet = new Set<string>();
			const objects: S3FileRecord[] = [];

			for (const row of rawResult) {
				const s3Key = row.s3_key as string;
				const relativeKey = s3Key.substring(prefix.length);
				const slashIndex = relativeKey.indexOf("/");
				if (slashIndex >= 0) {
					const folderPrefix = prefix + relativeKey.substring(0, slashIndex + 1);
					if (folderPrefix !== prefix) {
						prefixSet.add(folderPrefix);
					}
				} else {
					objects.push(mapDbRowToS3Record(row));
				}
			}

			return {
				objects: objects.slice(0, maxKeys),
				prefixes: Array.from(prefixSet).sort(),
			};
		}

		return {
			objects: rawResult.slice(0, maxKeys).map(mapDbRowToS3Record),
			prefixes: [],
		};
	}

	/**
	 * {@inheritDoc IFileRepository.softDelete}
	 */
	async softDelete(bucketId: string, s3Key: string): Promise<boolean> {
		const result = (await db.execute(
			sql`UPDATE files SET is_deleted = true WHERE bucket_id = ${bucketId}::uuid AND s3_key = ${s3Key} RETURNING id`
		)) as unknown as Record<string, unknown>[];
		return result.length > 0;
	}

	/**
	 * {@inheritDoc IFileRepository.softDeleteBatch}
	 */
	async softDeleteBatch(bucketId: string, keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			const ok = await this.softDelete(bucketId, key);
			if (ok) deleted++;
		}
		return deleted;
	}

	/**
	 * {@inheritDoc IFileRepository.countByBucket}
	 */
	async countByBucket(bucketId: string): Promise<number> {
		const result = (await db.execute(
			sql`SELECT count(*) as count FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`
		)) as unknown as Record<string, unknown>[];
		return Number(result[0]?.count || 0);
	}

	/**
	 * {@inheritDoc IFileRepository.usageByBucket}
	 *
	 * `COALESCE` is load-bearing: `SUM` over zero rows is NULL, not 0, and
	 * `Number(null)` is 0 only by accident of JavaScript's coercion.
	 */
	async usageByBucket(bucketId: string): Promise<BucketUsage> {
		const result = (await db.execute(
			sql`SELECT COALESCE(SUM(size_bytes), 0) AS bytes, count(*) AS objects FROM files WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false`
		)) as unknown as Record<string, unknown>[];
		const row = result[0] ?? {};
		return { bytes: Number(row.bytes ?? 0), objects: Number(row.objects ?? 0) };
	}

	/**
	 * {@inheritDoc IFileRepository.usageByOrganization}
	 *
	 * One query joining files to their buckets, rather than a per-bucket fan-out:
	 * the dashboard header needs a single number, and N round trips for it would
	 * scale with the tenant's bucket count.
	 */
	async usageByOrganization(organizationId: string): Promise<OrganizationUsage> {
		const result = (await db.execute(
			sql`SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes, count(f.id) AS objects, count(DISTINCT b.id) AS buckets
			    FROM buckets b LEFT JOIN files f ON f.bucket_id = b.id AND f.is_deleted = false
			    WHERE b.organization_id = ${organizationId}::uuid`
		)) as unknown as Record<string, unknown>[];
		const row = result[0] ?? {};
		return {
			bytes: Number(row.bytes ?? 0),
			objects: Number(row.objects ?? 0),
			buckets: Number(row.buckets ?? 0),
		};
	}

	/**
	 * {@inheritDoc IFileRepository.moveObject}
	 *
	 * A single UPDATE, so the uniqueness index arbitrates in one statement: a
	 * separate existence check followed by an update would admit a race where two
	 * moves to the same destination both pass the check and one destroys the
	 * other. The `23505` catch is that arbitration, not a fallback.
	 */
	async moveObject(
		bucketId: string,
		fromKey: string,
		toKey: string
	): Promise<"moved" | "missing" | "destination-exists"> {
		try {
			const result = (await db.execute(
				sql`UPDATE files SET s3_key = ${toKey}, updated_at = NOW() WHERE bucket_id = ${bucketId}::uuid AND s3_key = ${fromKey} AND is_deleted = false RETURNING id`
			)) as unknown as Record<string, unknown>[];
			return result.length > 0 ? "moved" : "missing";
		} catch (error: unknown) {
			if (isUniqueViolation(error)) return "destination-exists";
			throw error;
		}
	}

	/**
	 * {@inheritDoc IFileRepository.movePrefix}
	 *
	 * All-or-nothing by construction: the `NOT EXISTS` guard is evaluated inside
	 * the same statement as the UPDATE, and it excludes rows that are themselves
	 * part of the moving set — otherwise a rename INTO a descendant of itself
	 * would collide with the rows it is carrying.
	 */
	async movePrefix(bucketId: string, fromPrefix: string, toPrefix: string): Promise<number> {
		const source = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
		const destination = toPrefix.endsWith("/") ? toPrefix : `${toPrefix}/`;
		if (source === destination) return 0;

		const collision = (await db.execute(
			sql`SELECT 1 FROM files target
			    WHERE target.bucket_id = ${bucketId}::uuid
			      AND target.is_deleted = false
			      AND target.s3_key LIKE ${`${escapeLike(destination)}%`}
			      AND target.s3_key NOT LIKE ${`${escapeLike(source)}%`}
			    LIMIT 1`
		)) as unknown as Record<string, unknown>[];
		if (collision.length > 0) {
			throw new DestinationExistsError(`An object already exists under "${destination}"`);
		}

		const result = (await db.execute(
			// `substr(s3_key, $n)` rather than the SQL-standard
			// `substring(s3_key FROM $n)`. Verified against a real database: in the
			// `FROM`-clause form postgres-js sends the offset as an untyped parameter,
			// Postgres cannot infer its type, resolves the whole call to NULL, and the
			// UPDATE writes `NULL` into a NOT NULL column — every folder rename failed
			// while both mock tests and a constant-only query passed. The two-argument
			// `substr` infers `integer` from its position and returns the right suffix,
			// so the cast is unnecessary and the intent stays readable.
			sql`UPDATE files SET s3_key = ${destination} || substr(s3_key, ${source.length + 1}), updated_at = NOW()
			    WHERE bucket_id = ${bucketId}::uuid AND is_deleted = false AND s3_key LIKE ${`${escapeLike(source)}%`}
			    RETURNING id`
		)) as unknown as Record<string, unknown>[];
		return result.length;
	}

	/**
	 * {@inheritDoc IFileRepository.searchByKey}
	 *
	 * `ILIKE` on the escaped substring, joined to `buckets` for the name and
	 * scoped by `b.organization_id` — the tenant predicate is on the JOIN, so a
	 * bucket from another organization cannot appear even if a key matched.
	 */
	async searchByKey(
		organizationId: string,
		query: string,
		limit: number
	): Promise<ObjectSearchHit[]> {
		if (query.length === 0) return [];

		const result = (await db.execute(
			sql`SELECT b.name AS bucket, f.s3_key, f.file_name, f.mime_type, f.size_bytes, f.file_hash, f.created_at, f.public_id
			    FROM files f JOIN buckets b ON b.id = f.bucket_id
			    WHERE b.organization_id = ${organizationId}::uuid
			      AND f.is_deleted = false
			      AND f.s3_key ILIKE ${`%${escapeLike(query)}%`}
			    ORDER BY f.created_at DESC NULLS LAST
			    LIMIT ${limit}`
		)) as unknown as Record<string, unknown>[];

		return result.map((row) => ({
			bucket: row.bucket as string,
			key: row.s3_key as string,
			fileName: row.file_name as string,
			mimeType: row.mime_type as string,
			sizeBytes: toNumber(row.size_bytes),
			etag: (row.file_hash as string | null) ?? null,
			lastModified: new Date(row.created_at as string).toISOString(),
			downloadUrl: `${config.baseUrl}/f/${row.public_id as string}`,
		}));
	}

	/**
	 * {@inheritDoc IFileRepository.findOrphansByBucket}
	 */
	async findOrphansByBucket(bucketId: string): Promise<File[]> {
		const rows = await db
			.select()
			.from(fileSchema)
			.where(and(eq(fileSchema.bucketId, bucketId), eq(fileSchema.isDeleted, true)))
			.limit(100);
		return rows.map(mapFileRow);
	}

	/**
	 * {@inheritDoc IFileRepository.listPublic}
	 */
	async listPublic(limit = 50, before?: string | Date | null): Promise<File[]> {
		const safeLimit = Math.min(Math.max(1, limit), 100);
		let query = sql`
			SELECT * FROM files
			WHERE is_deleted IS NOT TRUE
		`;

		if (before) {
			const cursorDate = before instanceof Date ? before.toISOString() : before;
			query = sql`${query} AND created_at < ${cursorDate}::timestamp`;
		}

		query = sql`${query} ORDER BY created_at DESC LIMIT ${safeLimit}`;
		const rows = (await db.execute(query)) as unknown as Record<string, unknown>[];
		return rows.map(mapDbRowToS3Record);
	}
}
