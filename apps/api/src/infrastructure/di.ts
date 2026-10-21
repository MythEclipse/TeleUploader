/**
 * Dependency Injection container.
 *
 * Wires up singleton instances of all repositories and application services,
 * making them available to controllers and other adapters without requiring
 * a full DI framework.
 *
 * @module infrastructure/di
 */

import type { IBucketRepository } from "../domain/ports/bucket-repository";
import type { IFilePartRepository } from "../domain/ports/file-part-repository";
import type { IFileManagementRepository, IFileRepository } from "../domain/ports/file-repository";
import type { IIdentityRepository } from "../domain/ports/identity-repository";
import type { IMultipartRepository } from "../domain/ports/multipart-repository";
import type { IOrganizationRepository } from "../domain/ports/organization-repository";
import type { IS3CredentialRepository } from "../domain/ports/s3-credential-repository";
import type { ITelegramService } from "../domain/ports/telegram-service";
import { DrizzleBucketRepository } from "./persistence/repositories/bucket-repository";
import { DrizzleFilePartRepository } from "./persistence/repositories/file-part-repository";
import { DrizzleFileRepository } from "./persistence/repositories/file-repository";
import { DrizzleIdentityRepository } from "./persistence/repositories/identity-repository";
import { DrizzleMultipartRepository } from "./persistence/repositories/multipart-repository";
import { DrizzleOrganizationRepository } from "./persistence/repositories/organization-repository";
import { DrizzleS3CredentialRepository } from "./persistence/repositories/s3-credential-repository";
import { botPool } from "./telegram/bot-pool";
import { ChunkedStorage } from "./telegram/chunked-storage";

// ─── Repository Singletons ──────────────────────────────────────────

/**
 * The one file repository instance, created once and bound twice.
 *
 * A single `new DrizzleFileRepository()` assigned to a local, then published
 * under two narrow types. Constructing it twice would give the dashboard and the
 * bot separate objects; harmless today because the class is stateless, and
 * exactly the kind of duplication that stops being harmless the moment someone
 * adds a cache to it.
 */
const fileRepositoryInstance = new DrizzleFileRepository();

/** Singleton IFileRepository instance backed by Drizzle ORM. */
export const fileRepository: IFileRepository = fileRepositoryInstance;

/**
 * The same instance, typed as the management port.
 *
 * `DrizzleFileRepository` implements both interfaces; the two bindings exist so
 * a consumer declares which half it needs. The dashboard takes this one, the
 * bot takes {@link fileRepository}, and neither has to know about the other's
 * methods.
 */
export const fileManagementRepository: IFileManagementRepository = fileRepositoryInstance;

/** Singleton IBucketRepository instance backed by Drizzle ORM. */
export const bucketRepository: IBucketRepository = new DrizzleBucketRepository();

/** Singleton IFilePartRepository instance backed by Drizzle ORM. */
export const filePartRepository: IFilePartRepository = new DrizzleFilePartRepository();

/** Singleton IMultipartRepository instance backed by Drizzle ORM. */
export const multipartRepository: IMultipartRepository = new DrizzleMultipartRepository();

/**
 * Singleton IS3CredentialRepository instance backed by Drizzle ORM.
 *
 * P3: resolves a SigV4 access key to its organization. Every S3 request is
 * scoped by whatever this returns, so there is no way to reach a bucket without
 * going through it.
 */
export const s3CredentialRepository: IS3CredentialRepository = new DrizzleS3CredentialRepository();

/** Singleton ITelegramService instance backed by the bot pool. */
export const telegramService: ITelegramService = botPool;

/**
 * Singleton IOrganizationRepository instance backed by Drizzle ORM.
 *
 * P3: maps the authenticated admin session to the organization whose buckets it
 * may touch. Used by both the REST and oRPC surfaces, which are not SigV4-signed
 * and so cannot resolve a tenant from an access key.
 */
export const organizationRepository: IOrganizationRepository = new DrizzleOrganizationRepository();

/**
 * Singleton IIdentityRepository instance backed by Drizzle ORM.
 *
 * The multi-user seam: users, revocable sessions, OAuth state, and the
 * membership lookups that decide which organization a session may reach. Every
 * authenticated dashboard request resolves its tenant through this.
 */
export const identityRepository: IIdentityRepository = new DrizzleIdentityRepository();

// ─── Service Singletons ─────────────────────────────────────────────

/** Singleton ChunkedStorage for large file chunked uploads. */
export const chunkedStorage = new ChunkedStorage(
	fileRepository,
	filePartRepository,
	telegramService
);
