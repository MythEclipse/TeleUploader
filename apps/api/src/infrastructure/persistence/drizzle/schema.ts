import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema — mirrors apps/api/schema.sql COLUMN FOR COLUMN.
 *
 * P2a: this file previously typed only 2 of the 5 live tables, and did not match
 * the DDL. It declared `files.publicId` as `text()` where the database has
 * `varchar(21)`, and marked every timestamp `.notNull()` where the DDL leaves
 * them nullable. Left uncorrected, `drizzle-kit generate` would emit
 * table-rewriting ALTERs against production on its first run.
 *
 * Every type here was read back out of `information_schema.columns` on a
 * database built from schema.sql, not inferred from the DDL text. When changing
 * anything, re-verify against a live database rather than by eye:
 *
 *   psql -d <scratch> -f apps/api/schema.sql
 *   psql -d <scratch> -c '\d files'
 *
 * Load-bearing rules, not stylistic ones:
 *  - `text()` vs `varchar(n)` MUST match the database, or generate() rewrites.
 *  - Timestamps are nullable with a default. Do not add `.notNull()`.
 *  - Indexes are declared because generate() diffs them and drops what is
 *    missing.
 */

/** Storage backend for a file row. Stored as varchar with a 'telegram' default. */
export type StorageBackend = string;

/**
 * Files table. Holds both the Telegram storage references and the S3 addressing
 * columns (bucket_id + s3_key) added by later ALTER statements in schema.sql.
 */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: varchar('public_id', { length: 21 }).unique().notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
    storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    fileType: text('file_type').notNull(),
    uploaderId: bigint('uploader_id', { mode: 'number' }).notNull(),
    fileHash: text('file_hash'),
    archiveTelegramFileId: text('archive_telegram_file_id'),
    archiveStorageMessageId: bigint('archive_storage_message_id', { mode: 'number' }),
    archiveFileName: text('archive_file_name'),
    archiveEntryName: text('archive_entry_name'),
    archiveMimeType: text('archive_mime_type'),
    archiveSizeBytes: bigint('archive_size_bytes', { mode: 'number' }),
    // --- S3 addressing (added by ALTER statements in schema.sql) ---
    // No `.references()`: the FK exists in the database but was created by hand,
    // and declaring it here would make generate() diff constraint names.
    bucketId: uuid('bucket_id'),
    s3Key: text('s3_key'),
    storageBackend: text('storage_backend').default('telegram'),
    isDeleted: boolean('is_deleted').default(false),
    multipartUploadId: text('multipart_upload_id'),
    partCount: integer('part_count'),
    // Nullable in the database (DEFAULT present, NOT NULL absent).
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => [
    index('idx_files_public_id').on(t.publicId),
    index('idx_files_telegram_file_id').on(t.telegramFileId),
    index('idx_files_file_hash').on(t.fileHash),
    index('idx_files_archive_telegram_file_id').on(t.archiveTelegramFileId),
    index('idx_files_uploader_id').on(t.uploaderId),
    index('idx_files_created_at').on(t.createdAt.desc()),
    index('idx_files_s3_key').on(t.s3Key),
    index('idx_files_bucket_id').on(t.bucketId),
    // `text_pattern_ops` is required for `LIKE 'prefix%'` performance.
    index('idx_files_bucket_prefix').on(t.bucketId, t.s3Key.asc().op('text_pattern_ops')),
    // Partial unique index: the same key MAY be reused after a soft delete.
    // Omitting the WHERE clause would let generate() drop it and break
    // re-upload of a previously deleted key.
    uniqueIndex('idx_files_bucket_key').on(t.bucketId, t.s3Key).where(sql`${t.isDeleted} = false`),
  ],
);

/** S3-compatible buckets. `name` is globally UNIQUE today; P3 makes it per-org. */
/**
 * S3-compatible buckets.
 *
 * P3: `name` is no longer globally unique — it is unique per organization
 * (`buckets_organization_id_name_unique`), so two orgs can own a bucket with the
 * same name. That means the `.unique()` on `name` above is GONE, and callers must
 * pass an organization: `findByName(name, organizationId)`.
 *
 * Do not re-add `.unique()` to `name` — `drizzle-kit generate` would then try to
 * recreate the dropped `buckets_name_key` constraint.
 */
export const buckets = pgTable(
  'buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 63 }).notNull(),
    /** Set by migration 0002; NOT NULL in the database after that migration. */
    organizationId: uuid('organization_id'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => [uniqueIndex('buckets_organization_id_name_unique').on(t.organizationId, t.name)],
);

/** S3 multipart protocol state (distinct from the Telegram chunk table below). */
export const multipartUploads = pgTable(
  'multipart_uploads',
  {
    uploadId: varchar('upload_id').primaryKey(),
    bucketId: uuid('bucket_id').notNull(),
    s3Key: text('s3_key').notNull(),
    initiatedAt: timestamp('initiated_at').defaultNow(),
    status: text('status').default('in_progress'),
    initiatedBy: text('initiated_by'),
    contentType: text('content_type'),
  },
  (t) => [index('idx_multipart_uploads_status').on(t.status)],
);

/** Individual parts of an in-flight S3 multipart upload. */
export const multipartParts = pgTable(
  'multipart_parts',
  {
    id: serial('id').primaryKey(),
    uploadId: varchar('upload_id').notNull(),
    partNumber: integer('part_number').notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    etag: text('etag').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => [
    uniqueIndex('multipart_parts_upload_id_part_number_key').on(t.uploadId, t.partNumber),
    index('idx_multipart_parts_upload').on(t.uploadId, t.partNumber),
  ],
);

/**
 * Permanent internal chunks for Telegram-safe storage. Separate from the S3
 * multipart protocol state above: this is how a large file is actually split to
 * fit Telegram's per-message limit.
 */
export const fileParts = pgTable(
  'file_parts',
  {
    id: serial('id').primaryKey(),
    fileId: uuid('file_id').notNull(),
    partNumber: integer('part_number').notNull(),
    telegramFileId: text('telegram_file_id').notNull(),
    telegramFileUniqueId: text('telegram_file_unique_id').notNull(),
    storageChatId: bigint('storage_chat_id', { mode: 'number' }).notNull(),
    storageMessageId: bigint('storage_message_id', { mode: 'number' }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storedSizeBytes: bigint('stored_size_bytes', { mode: 'number' }).notNull(),
    compressionAlgorithm: text('compression_algorithm'),
    etag: text('etag').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => [
    uniqueIndex('file_parts_file_id_part_number_key').on(t.fileId, t.partNumber),
    index('idx_file_parts_file_id').on(t.fileId, t.partNumber),
  ],
);

/** ── P3 tenancy ─────────────────────────────────────────────────────────── */

/** Organizations own buckets. Created in drizzle/0001_tenancy_tables.sql. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 63 }).notNull().unique(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

/** Membership of a user in an organization, with the org-side role. */
export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    userId: text('user_id').notNull(),
    role: varchar('role', { length: 16 }).default('member').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => [
    uniqueIndex('members_org_user_unique').on(t.organizationId, t.userId),
    index('idx_members_organization_id').on(t.organizationId),
  ],
);

/**
 * S3 access keys, resolved to an organization.
 *
 * The SigV4 wire protocol is unchanged — only the LOOKUP moves. A key seeded from
 * the S3_ACCESS_KEY/S3_SECRET_KEY env pair keeps every current aws-cli / rclone /
 * Docker-registry client working with no configuration change.
 */
export const s3Credentials = pgTable(
  's3_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    accessKey: varchar('access_key', { length: 255 }).notNull().unique(),
    secretKey: text('secret_key').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at').defaultNow(),
    lastUsedAt: timestamp('last_used_at'),
  },
  (t) => [index('idx_s3_credentials_organization_id').on(t.organizationId)],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type S3CredentialRow = typeof s3Credentials.$inferSelect;

/** Row shapes inferred from the tables, for the typed raw-SQL repositories. */
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type BucketRow = typeof buckets.$inferSelect;
export type NewBucketRow = typeof buckets.$inferInsert;
export type MultipartUploadRow = typeof multipartUploads.$inferSelect;
export type MultipartPartRow = typeof multipartParts.$inferSelect;
export type FilePartRow = typeof fileParts.$inferSelect;
export type NewFilePartRow = typeof fileParts.$inferInsert;
