import { open } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { File } from "../../domain/entities/file";
import { buildNewFile } from "../../domain/entities/file-factory";
import type { IFileRepository } from "../../domain/ports/file-repository";
import type { ITelegramService } from "../../domain/ports/telegram-service";
import {
	checkFileSize,
	cleanupTempFile,
	ensureExtension,
	getErrorMessage,
	getFileType,
} from "../../infrastructure/file";
import logger from "../../infrastructure/observability/logger";
import type { ChunkedStorage } from "../../infrastructure/telegram/chunked-storage";
import type { UploadInput, UploadOutput } from "../dto/upload";
import {
	buildStatelessDownloadUrl,
	encodeStatelessLink,
	isStatelessToken,
} from "../shared/utils/stateless-link";

/** Subset of application configuration consumed by the upload-file use case. */
export interface UploadFileConfig {
	/** Server base URL for constructing download links. */
	baseUrl: string;
	/** Maximum chunk size in bytes for Telegram chunked uploads. */
	telegramChunkSizeBytes: number;
	/** Telegram chat ID where file parts are stored. */
	storageChatId: number;
	/** Whether to attempt gzip compression on each chunk. */
	compressChunkedUploads: boolean;
	/** Minimum chunk size in bytes below which compression is skipped. */
	chunkCompressionMinSizeBytes: number;
	/** HMAC key used to sign self-contained download links. */
	statelessLinkSecret: string;
}

/** Dependencies required by the upload-file use case factory. */
export interface UploadFileUseCaseDeps {
	/** File repository for CRUD operations on file records. */
	fileRepo: IFileRepository;
	/** Telegram service for forwarding file content to storage. */
	telegramService: ITelegramService;
	/** Chunked storage handler for large file uploads. */
	chunkedStorage: ChunkedStorage;
	/** Application configuration subset. */
	config: UploadFileConfig;
}

/**
 * Reads the first 16 bytes from a file on disk for magic-byte detection.
 *
 * @param tempPath - Absolute path to the temporary file.
 * @returns A buffer containing up to 16 bytes.
 */
const readSignatureBuffer = async (tempPath: string): Promise<Buffer> => {
	const handle = await open(tempPath, "r");
	try {
		const buf = Buffer.alloc(16);
		const { bytesRead } = await handle.read(buf, 0, 16, 0);
		return buf.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
};

/**
 * Maps a persisted file entity to the public upload output DTO.
 *
 * The download URL is rebuilt from `publicId`, which now holds EITHER a stateless
 * token OR a legacy nanoid. A token needs its `.ext` suffix to read as a file, so
 * the extension is re-appended here — otherwise a deduplicated stateless upload
 * would return a link without the extension while the original response had one.
 *
 * @param file - The persisted file record.
 * @param baseUrl - Server base URL for the download link.
 * @returns The public `UploadOutput` DTO.
 */
const toUploadOutput = (file: File, baseUrl: string): UploadOutput => ({
	publicId: file.publicId,
	fileName: file.fileName,
	mimeType: file.mimeType,
	sizeBytes: file.sizeBytes,
	fileType: file.fileType,
	createdAt: file.createdAt instanceof Date ? file.createdAt : new Date(file.createdAt),
	downloadUrl: isStatelessToken(file.publicId)
		? buildStatelessDownloadUrl(baseUrl, file.publicId, file.fileName)
		: `${baseUrl}/f/${file.publicId}`,
	fileHash: file.fileHash,
});

/**
 * Creates a factory function for the upload-file use case.
 *
 * Single save path for all upload entry points (multipart, JSON, web-API):
 * 1. Deduplication per policy — `hash` (by content SHA-256), `bucket-key`
 *    (idempotent by bucket + S3 key), or `none` (store unconditionally).
 * 2. Normalises the file name and MIME type based on magic bytes.
 * 3. Validates the file size against Telegram type-specific limits.
 * 4. Chooses a storage strategy — chunked (delegated to ChunkedStorage) or
 *    single-message upload.
 * 5. Persists the file record.
 * 6. Builds and returns the public `UploadOutput` DTO.
 *
 * @param deps - The injected dependencies.
 * @returns An async function accepting `UploadInput` and returning `UploadOutput`.
 */
export function createUploadFileUseCase(deps: UploadFileUseCaseDeps) {
	/**
	 * Store a file WITHOUT a database row and return a self-contained link.
	 *
	 * Two shapes, because Telegram has two:
	 * - at or below the chunk size: one `forwardToStorage` call, one file_id.
	 * - above it (19-30 MB at the default threshold): the file is split, and every
	 *   part's file_id goes into the payload. This is why the threshold is clamped
	 *   to two chunks in `env.ts` — a third part would add ~110 more characters to
	 *   a URL the user has to paste.
	 *
	 * The `publicId` returned here is the token itself. That keeps the DTO shape
	 * unchanged for every caller (the dashboard, the CLI, the bot) instead of
	 * introducing a second field that each of them would have to learn.
	 *
	 * A DATABASE ROW IS STILL WRITTEN, and that is deliberate. The token makes
	 * DOWNLOADS independent of Postgres; it does not make the upload forgettable.
	 * Backup and listing both need a record, and so does the dashboard:
	 *
	 * - a `files` row, with `public_id` set to the token so `/f/<token>` and
	 *   `findByPublicId` agree on the same key;
	 * - a `file_parts` row per chunk, so a multi-part file can be reassembled by
	 *   anything that reads the database (restore scripts, admin tooling) without
	 *   decoding a URL.
	 *
	 * The stateless property is about the READ path: `handleFileRedirect` answers
	 * from the signed payload and never queries. If the row is missing, the link
	 * still works. That is the point — the row is an index for humans and backups,
	 * not a dependency for serving.
	 *
	 * @param input - The upload request.
	 * @param fileName - Final, extension-normalised file name.
	 * @param mimeType - Resolved MIME type.
	 * @param fileType - Telegram send-method classification.
	 * @param partPrefix - Prefix for chunk part names.
	 * @returns The public DTO whose `downloadUrl` needs no database lookup.
	 */
	const storeStateless = async (
		input: UploadInput,
		fileName: string,
		mimeType: string,
		fileType: string,
		partPrefix: string
	): Promise<UploadOutput> => {
		const createdAt = Math.floor(Date.now() / 1000);

		const single = input.sizeBytes <= deps.config.telegramChunkSizeBytes;
		const upload = single
			? null
			: await deps.chunkedStorage.uploadChunksWithoutPersisting({
					tempPath: input.tempPath,
					partFileNamePrefix: partPrefix,
				});
		const forwarded = single
			? await deps.telegramService.forwardToStorage(input.tempPath, fileName, fileType)
			: null;

		const parts = single
			? [
					{
						telegramFileId: forwarded!.telegramFileId,
						sizeBytes: input.sizeBytes,
						compressionAlgorithm: null,
					},
				]
			: upload!.parts.map((part) => ({
					telegramFileId: part.telegramFileId,
					sizeBytes: part.sizeBytes,
					compressionAlgorithm: part.compressionAlgorithm,
				}));

		const token = encodeStatelessLink(
			{
				parts,
				sizeBytes: input.sizeBytes,
				fileName,
				mimeType,
				createdAt,
			},
			deps.config.statelessLinkSecret
		);

		// Persist for backup/listing. A failure here must NOT fail the upload: the
		// file is already in Telegram and the link already works, so turning a
		// bookkeeping problem into a user-visible error would be strictly worse.
		// The row is recoverable from the link; the upload is not.
		try {
			await deps.fileRepo.create(
				buildNewFile({
					publicId: token,
					telegramFileId: parts[0]?.telegramFileId ?? "",
					telegramFileUniqueId: forwarded?.telegramFileUniqueId ?? "",
					storageChatId: deps.config.storageChatId,
					storageMessageId: forwarded?.storageMessageId ?? 0,
					fileName,
					mimeType,
					sizeBytes: input.sizeBytes,
					fileType,
					storageBackend: "telegram",
					uploaderId: input.uploaderId,
					uploaderUserId: input.uploaderUserId ?? null,
					fileHash: input.fileHash,
					bucketId: input.bucketId,
					s3Key: input.s3Key,
					partCount: parts.length,
				})
			);

			// Parts are only meaningful for chunked uploads; a single-message file
			// has its file_id on the row above. Writing one part row for every
			// single-part file would double the write cost for no benefit.
			if (!single) {
				await deps.chunkedStorage.persistPartsForFile(token, parts);
			}
		} catch (error: unknown) {
			logger.error("Failed to persist stateless upload metadata", {
				publicId: token,
				error: getErrorMessage(error),
			});
		}

		return {
			publicId: token,
			fileName,
			mimeType,
			sizeBytes: input.sizeBytes,
			fileType,
			createdAt: new Date(createdAt * 1000),
			downloadUrl: buildStatelessDownloadUrl(deps.config.baseUrl, token, fileName),
			fileHash: input.fileHash,
		};
	};

	return async (input: UploadInput): Promise<UploadOutput> => {
		const dedup = input.dedup ?? "hash";

		// 1. Deduplication per policy
		//
		// A FAILED LOOKUP IS NOT A FAILED UPLOAD. Dedup is an optimisation: if the
		// query errors (database down, pool exhausted, migration in flight), the
		// correct behaviour is to store the file anyway rather than reject a
		// perfectly good upload because a cache missed. This also keeps the
		// stateless promise honest — a small file can be uploaded and served even
		// while Postgres is unavailable.
		if (dedup === "hash") {
			try {
				const existing = await deps.fileRepo.findByHash(input.fileHash);
				if (existing) {
					return toUploadOutput(existing, deps.config.baseUrl);
				}
			} catch (error: unknown) {
				logger.warn("Deduplication lookup failed; storing unconditionally", {
					error: getErrorMessage(error),
				});
			}
		} else if (dedup === "bucket-key") {
			if (!input.bucketId || !input.s3Key) {
				throw new Error("bucket-key dedup requires bucketId and s3Key");
			}
			const existing = await deps.fileRepo.findByBucketAndKey(input.bucketId, input.s3Key);
			if (existing) {
				return toUploadOutput(existing, deps.config.baseUrl);
			}
		}

		// 2. Signature bytes for magic-byte-based extension detection
		const signatureBuffer = input.signatureBuffer ?? (await readSignatureBuffer(input.tempPath));

		const { fileName: finalFileName, mimeType } = ensureExtension(
			input.fileName,
			signatureBuffer,
			input.mimeType
		);

		// 3. Determine Telegram file type and validate size
		//
		// NO CAPTION IS PASSED, and that is the fix for GIF corruption.
		//
		// This call used to be `getFileType(mimeType, finalFileName)`. The second
		// parameter is a CAPTION, not a file name — and the file name always
		// contains its extension, so `....gif` matched the caption rule
		// `caption.includes("gif")` and every GIF was classified `animation`.
		// Telegram's sendAnimation re-encodes GIF to MP4 (220154 bytes in, 34395
		// bytes of H.264 out), so the download served an MP4 under
		// `Content-Type: image/gif` with a `.gif` filename. The bytes were fine;
		// the container was not, which is exactly what "korup" looked like.
		//
		// There is no caption here to pass. Nothing about this upload path can
		// legitimately produce "make it an animation/sticker/voice note" intent, so
		// the MIME type alone decides — which is also what keeps the bytes intact.
		const fileTypeRaw = getFileType(mimeType);
		const fileType = fileTypeRaw === "application" ? "document" : fileTypeRaw;

		if (!checkFileSize(input.sizeBytes, fileType)) {
			throw new Error(`File size exceeds ${fileType} limit`);
		}

		const partPrefix = input.partPrefix ?? `direct-${input.fileHash.slice(0, 16)}`;

		// 4. Upload — chunked via ChunkedStorage for files above the threshold,
		// single-message otherwise. The temp file is always cleaned up here so
		// callers never need their own cleanup block.
		try {
			if (input.stateless) {
				return await storeStateless(input, finalFileName, mimeType, fileType, partPrefix);
			}

			if (input.sizeBytes > deps.config.telegramChunkSizeBytes) {
				const uploadedFile = await deps.chunkedStorage.storeFileInTelegramChunks({
					tempPath: input.tempPath,
					partFileNamePrefix: partPrefix,
					fileName: finalFileName,
					mimeType,
					sizeBytes: input.sizeBytes,
					fileType,
					uploaderId: input.uploaderId ?? 0,
					uploaderUserId: input.uploaderUserId ?? null,
					bucketId: input.bucketId,
					s3Key: input.s3Key,
				});

				return toUploadOutput(uploadedFile, deps.config.baseUrl);
			}

			// 5. Single-message upload path. Pass the temp path (not an open
			// stream) so the telegram service owns file I/O — test doubles that
			// never touch disk keep working, and the use case stays stream-agnostic.
			const forwardResult = await deps.telegramService.forwardToStorage(
				input.tempPath,
				finalFileName,
				fileType
			);

			const singlePublicId = nanoid();

			const createdFile = await deps.fileRepo.create(
				buildNewFile({
					publicId: singlePublicId,
					telegramFileId: forwardResult.telegramFileId,
					telegramFileUniqueId: forwardResult.telegramFileUniqueId,
					storageChatId: deps.config.storageChatId,
					storageMessageId: forwardResult.storageMessageId,
					fileName: finalFileName,
					mimeType,
					sizeBytes: input.sizeBytes,
					fileType,
					storageBackend: "telegram",
					uploaderId: input.uploaderId,
					uploaderUserId: input.uploaderUserId ?? null,
					fileHash: input.fileHash,
					bucketId: input.bucketId,
					s3Key: input.s3Key,
				})
			);

			return toUploadOutput(createdFile, deps.config.baseUrl);
		} finally {
			await cleanupTempFile(input.tempPath);
		}
	};
}
