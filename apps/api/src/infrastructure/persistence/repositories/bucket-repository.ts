import { sql } from 'drizzle-orm';
import type { Bucket } from '../../../domain/entities/bucket';
import type { IBucketRepository } from '../../../domain/ports/bucket-repository';
import { db } from '../drizzle/index';

/** Raw result row from `db.execute()`. */
type QueryRow = Record<string, unknown>;
/** Array of raw result rows. */
type QueryResult = QueryRow[];

/**
 * Maps a raw database row to a {@link Bucket} domain entity.
 */
const mapRowToBucket = (row: Record<string, unknown>): Bucket => ({
  id: row.id as string,
  name: row.name as string,
  organizationId: row.organization_id as string,
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
});

/**
 * The columns every bucket query selects, in one place.
 *
 * `organization_id` must be in this list or `mapRowToBucket` reads `undefined`
 * for a required field and every downstream predicate silently degrades.
 */
const BUCKET_COLUMNS = 'id, name, organization_id, created_at, updated_at';

/**
 * Drizzle-backed implementation of {@link IBucketRepository}.
 *
 * Delegates to the same SQL queries as the original `infrastructure/persistence/repositories/bucket-repository.ts`
 * module, using raw SQL for drizzle tables that are not part of the
 * typed schema.
 */
export class DrizzleBucketRepository implements IBucketRepository {
  /**
   * {@inheritDoc IBucketRepository.create}
   */
  async create(name: string, organizationId: string): Promise<Bucket> {
    const result = (await db.execute(
      sql`INSERT INTO buckets (name, organization_id) VALUES (${name}, ${organizationId}::uuid) RETURNING ${sql.raw(BUCKET_COLUMNS)}`,
    )) as unknown as QueryResult;
    return mapRowToBucket(result[0]!);
  }

  /**
   * {@inheritDoc IBucketRepository.findByName}
   */
  async findByName(name: string, organizationId: string): Promise<Bucket | null> {
    const result = (await db.execute(
      sql`SELECT ${sql.raw(BUCKET_COLUMNS)} FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid ORDER BY created_at ASC LIMIT 1`,
    )) as unknown as QueryResult;
    if (result.length === 0) return null;
    return mapRowToBucket(result[0]!);
  }

  /**
   * {@inheritDoc IBucketRepository.list}
   */
  async list(organizationId: string): Promise<Bucket[]> {
    const result = (await db.execute(
      sql`SELECT ${sql.raw(BUCKET_COLUMNS)} FROM buckets WHERE organization_id = ${organizationId}::uuid ORDER BY name`,
    )) as unknown as QueryResult;
    return result.map(mapRowToBucket);
  }

  /**
   * {@inheritDoc IBucketRepository.delete}
   *
   * Cascade-deletes multipart and file rows that hold foreign-key
   * references to the bucket before deleting the bucket itself.
   *
   * Every one of the four statements carries the organization predicate. The
   * sub-selects resolve the bucket by NAME, so an unscoped cascade would match
   * the same-named bucket owned by another organization and destroy their data.
   *
   * Failures during cascade are silently caught to match the original
   * defensive-cleanup behaviour.
   */
  async delete(name: string, organizationId: string): Promise<boolean> {
    // Cascade-delete rows that hold FK references to this tenant's bucket only.
    await db
      .execute(
        sql`DELETE FROM multipart_parts WHERE upload_id IN (SELECT upload_id FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid))`,
      )
      .catch(() => {});
    await db
      .execute(
        sql`DELETE FROM multipart_uploads WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid)`,
      )
      .catch(() => {});
    await db
      .execute(
        sql`DELETE FROM files WHERE bucket_id IN (SELECT id FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid)`,
      )
      .catch(() => {});

    // RETURNING is required: postgres-js resolves a DELETE without it to an
    // EMPTY array (the affected count lives on `.count`), so `result.length > 0`
    // was unconditionally false — a successful delete reported failure.
    const result = (await db.execute(
      sql`DELETE FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid RETURNING id`,
    )) as unknown as QueryResult;
    return result.length > 0;
  }

  /**
   * {@inheritDoc IBucketRepository.exists}
   */
  async exists(name: string, organizationId: string): Promise<boolean> {
    const result = (await db.execute(
      sql`SELECT 1 FROM buckets WHERE name = ${name} AND organization_id = ${organizationId}::uuid`,
    )) as unknown as QueryResult;
    return result.length > 0;
  }
}
