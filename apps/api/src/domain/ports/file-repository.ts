import type { File, NewFile } from "../entities/file";

/**
 * An S3-synced file record: a File entity guaranteed to have non-null
 * bucketId and s3Key values.
 */
export interface S3FileRecord extends File {
	/** S3 bucket UUID (non-null refinement) */
	bucketId: string;
	/** S3 object key (non-null refinement) */
	s3Key: string;
}

/**
 * Repository interface for File entity persistence.
 *
 * Abstracts all file CRUD operations currently spread across
 * `infrastructure/persistence/repositories/file-repository.ts` and `infrastructure/persistence/repositories/file-repository.ts`.
 */
export interface IFileRepository {
	/**
	 * Find a single file by its SHA-256 content hash.
	 * @param hash - The SHA-256 hash to search for.
	 * @returns The matching file, or `null` when not found.
	 */
	findByHash(hash: string): Promise<File | null>;

	/**
	 * Find a single file by its public-facing short identifier.
	 * @param publicId - The public ID to look up.
	 * @returns The matching file, or `null` when not found.
	 */
	findByPublicId(publicId: string): Promise<File | null>;

	/**
	 * Find a single file by its Telegram file unique ID (stable across bot tokens).
	 * @param telegramFileUniqueId - The Telegram unique file ID.
	 * @returns The matching file, or `null` when not found.
	 */
	findByUniqueId(telegramFileUniqueId: string): Promise<File | null>;

	/**
	 * Find a single file by its S3 bucket and object key.
	 * @param bucketId - The bucket UUID.
	 * @param s3Key - The S3 object key.
	 * @returns The matching file, or `null` when not found.
	 */
	findByBucketAndKey(bucketId: string, s3Key: string): Promise<File | null>;

	/**
	 * Create a new file record.
	 * @param file - The file data (auto-generated fields omitted).
	 * @returns The newly created file record with all fields populated.
	 */
	create(file: NewFile): Promise<File>;

	/**
	 * List objects within a bucket, optionally filtered by prefix and delimiter.
	 *
	 * When `delimiter` is `"/"`, common prefixes (pseudo-directories) are
	 * returned separately and objects whose key continues past the delimiter
	 * are omitted from the `objects` array.
	 *
	 * @param bucketId - The bucket UUID to list from.
	 * @param prefix - Key prefix to filter by.
	 * @param delimiter - Delimiter character (e.g. `"/"`) or `null` for flat listing.
	 * @param maxKeys - Maximum number of object records to return.
	 * @param startAfter - Return only keys strictly greater than this value, or `null`.
	 * @returns A list of matching S3 file records and discovered common prefixes.
	 */
	listByPrefix(
		bucketId: string,
		prefix: string,
		delimiter: string | null,
		maxKeys: number,
		startAfter: string | null
	): Promise<{ objects: S3FileRecord[]; prefixes: string[] }>;

	/**
	 * Soft-delete a single file by bucket and key.
	 * @param bucketId - The bucket UUID.
	 * @param s3Key - The S3 object key.
	 * @returns `true` if a row was soft-deleted, `false` otherwise.
	 */
	softDelete(bucketId: string, s3Key: string): Promise<boolean>;

	/**
	 * Soft-delete multiple files within a bucket in batch.
	 * @param bucketId - The bucket UUID.
	 * @param keys - Array of S3 object keys to delete.
	 * @returns The number of rows actually soft-deleted.
	 */
	softDeleteBatch(bucketId: string, keys: string[]): Promise<number>;

	/**
	 * Count non-deleted objects in a bucket.
	 * @param bucketId - The bucket UUID.
	 * @returns The object count.
	 */
	countByBucket(bucketId: string): Promise<number>;

	/**
	 * Find soft-deleted (orphaned) file records in a bucket.
	 * @param bucketId - The bucket UUID.
	 * @returns An array of orphaned file records.
	 */
	findOrphansByBucket(bucketId: string): Promise<File[]>;

	/**
	 * List publicly uploaded files ordered by newest first with cursor pagination.
	 *
	 * @param limit - Maximum number of records to return.
	 * @param before - Optional cursor (ISO timestamp string or Date) to page backwards.
	 * @returns An array of public file records.
	 */
	listPublic(limit: number, before?: string | Date | null): Promise<File[]>;
}

/**
 * The storage-management operations the dashboard needs and the bot does not.
 *
 * ## Why this is a second port rather than more methods on {@link IFileRepository}
 *
 * `IFileRepository` is what `startBot` takes, and it is mocked in full by
 * several suites. Widening it for the dashboard's benefit makes every one of
 * those mocks implement `searchByKey` and `movePrefix` — methods a Telegram bot
 * can never call — and turns a mock into a place where a missing method is a
 * type error instead of an irrelevant detail. Splitting the interface costs one
 * extra `implements` clause on the one class that genuinely does both, and
 * keeps each consumer depending only on what it uses.
 *
 * Every method here is TENANT-SCOPED, either by `organizationId` (search) or by
 * a `bucketId` the caller has already resolved within its own organization.
 */
export interface IFileManagementRepository {
	/**
	 * Sum the stored bytes of a bucket's live objects.
	 *
	 * A SUM over the table rather than a length of the listing: the listing is
	 * paged and folds directories into prefixes, so a client-side total would be
	 * the size of the current page and silently wrong on every bucket bigger
	 * than one page.
	 *
	 * @param bucketId - The bucket UUID.
	 * @returns Total bytes, and the object count it was summed over.
	 */
	usageByBucket(bucketId: string): Promise<BucketUsage>;

	/**
	 * Sum the stored bytes across every bucket one organization owns.
	 *
	 * @param organizationId - The owning organization's UUID.
	 * @returns Total bytes, object count, and bucket count.
	 */
	usageByOrganization(organizationId: string): Promise<OrganizationUsage>;

	/**
	 * Move or rename one object.
	 *
	 * Refuses when the destination already exists: `idx_files_bucket_key` is a
	 * UNIQUE index over `(bucket_id, s3_key) WHERE is_deleted = false`, so an
	 * overwriting move would either fail at the driver or destroy the target.
	 * Reporting the collision lets the caller answer 409 instead of 500.
	 *
	 * @param bucketId - The bucket UUID.
	 * @param fromKey - The current object key.
	 * @param toKey - The destination key.
	 * @returns `moved`, `missing`, or `destination-exists`.
	 */
	moveObject(
		bucketId: string,
		fromKey: string,
		toKey: string
	): Promise<"moved" | "missing" | "destination-exists">;

	/**
	 * Move or rename every object under a prefix — a folder rename.
	 *
	 * The suffix is preserved, so `a/b.txt` under `a/` becomes `c/b.txt` under
	 * `c/`. Refuses as a whole when ANY destination key is taken, so a partial
	 * rename cannot leave half a folder behind.
	 *
	 * @param bucketId - The bucket UUID.
	 * @param fromPrefix - Source prefix, with or without a trailing slash.
	 * @param toPrefix - Destination prefix, with the same convention.
	 * @returns The number of objects moved.
	 * @throws {DestinationExistsError} When the destination collides.
	 */
	movePrefix(bucketId: string, fromPrefix: string, toPrefix: string): Promise<number>;

	/**
	 * Find live objects whose key contains a substring, across a whole tenant.
	 *
	 * Scoped by ORGANIZATION, not by bucket: the file manager's search box is
	 * meant to answer "where did I put that file", and requiring the user to
	 * pick the right bucket first defeats it.
	 *
	 * @param organizationId - The owning organization's UUID.
	 * @param query - Case-insensitive substring, matched against the key.
	 * @param limit - Maximum rows to return.
	 * @returns Matching objects, newest first, with their bucket name.
	 */
	searchByKey(organizationId: string, query: string, limit: number): Promise<ObjectSearchHit[]>;
}

/** Storage totals for one bucket. */
export interface BucketUsage {
	/** Sum of `size_bytes` over live objects. */
	readonly bytes: number;
	/** Number of live objects. */
	readonly objects: number;
}

/** Storage totals across every bucket one organization owns. */
export interface OrganizationUsage extends BucketUsage {
	/** Number of buckets. */
	readonly buckets: number;
}

/**
 * One search result.
 *
 * Carries the BUCKET NAME rather than only its id, because the caller is
 * rendering a cross-bucket list and would otherwise have to resolve every id.
 */
export interface ObjectSearchHit {
	/** The bucket the object lives in. */
	readonly bucket: string;
	/** The full object key. */
	readonly key: string;
	/** The object's display name. */
	readonly fileName: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly etag: string | null;
	/** ISO-8601. */
	readonly lastModified: string;
	/** Absolute public share link. */
	readonly downloadUrl: string;
}
