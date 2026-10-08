/**
 * Core domain entity representing an S3-compatible storage bucket.
 * Buckets group objects for the S3-compatible API layer.
 */
export interface Bucket {
  /** Primary key, UUID */
  id: string;
  /** Bucket name (unique, max 63 chars, S3 naming convention) */
  name: string;
  /**
   * Owning organization (UUID).
   *
   * P3: `name` is unique per organization, not globally, so every lookup must
   * carry this predicate. A bucket is never resolvable by name alone.
   */
  organizationId: string;
  /** Record creation timestamp */
  createdAt: Date;
  /** Record last-updated timestamp */
  updatedAt: Date;
}
