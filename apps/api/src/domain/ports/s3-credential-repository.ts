import type { S3Credential } from '../entities/s3-credential';

/**
 * Repository interface for S3 credential persistence.
 *
 * P3: this is the single seam through which a SigV4 access key becomes an
 * organization. Before it existed, the only place in `src/` that read
 * `config.s3AccessKey` / `config.s3SecretKey` for verification was
 * `s3-router.ts`, so there was no way for a key that existed only in the
 * database to authenticate.
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
}
