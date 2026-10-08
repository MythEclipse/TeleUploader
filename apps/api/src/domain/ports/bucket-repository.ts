import type { Bucket } from '../entities/bucket';

/**
 * Repository interface for Bucket entity persistence.
 *
 * Abstracts the bucket CRUD operations currently in `infrastructure/persistence/repositories/bucket-repository.ts`.
 *
 * P3 — EVERY method takes an `organizationId`. Bucket names are unique per
 * organization (`buckets_organization_id_name_unique`), so a one-argument
 * lookup would resolve another tenant's bucket. There is deliberately no
 * overload that omits the organization: the tenant-scoped call is the only one
 * that can be written.
 */
export interface IBucketRepository {
  /**
   * Create a new bucket with the given name inside the given organization.
   * @param name - The bucket name (S3 naming convention).
   * @param organizationId - The owning organization's UUID.
   * @returns The newly created bucket record.
   */
  create(name: string, organizationId: string): Promise<Bucket>;

  /**
   * Find a bucket by its name WITHIN one organization.
   * @param name - The bucket name to look up.
   * @param organizationId - The owning organization's UUID.
   * @returns The matching bucket, or `null` when that organization does not own
   *          a bucket with this name. A bucket owned by a DIFFERENT organization
   *          must also return `null` — never another tenant's row.
   */
  findByName(name: string, organizationId: string): Promise<Bucket | null>;

  /**
   * List the buckets owned by one organization, ordered alphabetically by name.
   * @param organizationId - The owning organization's UUID.
   * @returns An array of that organization's bucket records.
   */
  list(organizationId: string): Promise<Bucket[]>;

  /**
   * Delete a bucket and cascade-delete all associated files and multipart data.
   *
   * The cascade MUST be scoped to the same organization as the bucket row, or
   * deleting one tenant's bucket destroys another tenant's same-named bucket and
   * its objects.
   *
   * @param name - The name of the bucket to delete.
   * @param organizationId - The owning organization's UUID.
   * @returns `true` if the bucket was deleted, `false` if it did not exist.
   */
  delete(name: string, organizationId: string): Promise<boolean>;

  /**
   * Check whether an organization owns a bucket with the given name.
   * @param name - The bucket name to check.
   * @param organizationId - The owning organization's UUID.
   * @returns `true` if that organization owns the bucket, `false` otherwise.
   */
  exists(name: string, organizationId: string): Promise<boolean>;
}
