import { createReadStream } from "node:fs";
import { nanoid } from "nanoid";
import { writeBodyToFile } from "../../../application/shared/utils/file-sink";
import { locateZipEntry } from "../../../application/shared/utils/zip";
import { config } from "../../../env";
import { chunkedStorage, fileRepository } from "../../../infrastructure/di";
import { cleanupTempFile, formatCreatedAt, getErrorMessage } from "../../../infrastructure/file";
import logger from "../../../infrastructure/observability/logger";
import { botPool } from "../../../infrastructure/telegram/bot-pool";
import { buildTelegramFileUrl } from "../../../infrastructure/telegram/file-url";
import { sanitizeFilenameHeader } from "../filename";

/**
 * Extended Request type that includes route parameter access.
 */
type RequestWithParams = Request & {
	/** Route parameters extracted by the router. */
	params?: {
		/** Public file identifier. */
		public_id?: string;
	};
};

/**
 * Returns a JSON error response with the given status code and message.
 *
 * @param status - HTTP status code.
 * @param error - Error message.
 * @returns A JSON Response.
 */
const fail = (status: number, error: string): Response => Response.json({ error }, { status });

/**
 * Maps a Telegram file path to the MIME type of the container it actually is.
 *
 * Telegram's CDN serves re-encoded files with the opaque type
 * `application/octet-stream` and only reveals the real container in the path it
 * returns from `getFile` (e.g. `animations/file_1.mp4` for an uploaded GIF). The
 * table is deliberately small: it covers only the formats Telegram produces when
 * it re-encodes, and anything else falls back to the caller's own MIME type.
 *
 * @param filePath - The `file_path` from Telegram's `getFile` response.
 * @returns The MIME type, or `null` when the extension is not one we translate.
 */
const mimeFromPath = (filePath: string): string | null => {
	const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	switch (ext) {
		case "mp4":
			return "video/mp4";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "mp3":
			return "audio/mpeg";
		case "m4a":
			return "audio/mp4";
		case "ogg":
		case "oga":
			return "audio/ogg";
		case "webm":
			return "video/webm";
		case "pdf":
			return "application/pdf";
		default:
			return null;
	}
};

/**
 * Handles file redirect requests.
 *
 * Looks up a file by its public identifier and determines the best delivery
 * method:
 * - **chunked** files are streamed via the chunked-object response builder.
 * - **archive-entry** files are extracted from a Telegram-stored zip archive
 *   and streamed as a single file.
 * - **regular** files are proxied from the Telegram CDN (200 with the file
 *   body, so browser fetch/XHR playback never hits Telegram CORS).
 *
 * @param req - The incoming HTTP request with a `public_id` route parameter.
 * @returns A redirect or streaming response, or a JSON error.
 */
export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
	const publicId = req.params?.public_id;
	try {
		if (!publicId) {
			return fail(400, "Missing file id");
		}

		const file = await fileRepository.findByPublicId(publicId);
		if (!file) {
			logger.warn("File not found", { publicId });
			return fail(404, "File not found");
		}

		if (file.storageBackend === "chunked") {
			if (file.archiveEntryName) {
				return fail(501, "Archive entry extraction is not supported for chunked files");
			}
			const range = { type: "none" as const };
			const resp = await chunkedStorage.createChunkedObjectResponse({ file, range, reqId: "" });
			// Ensure CORS so browser fetch/XHR playback works for chunked files too.
			const h = new Headers(resp.headers);
			if (!h.has("Access-Control-Allow-Origin")) h.set("Access-Control-Allow-Origin", "*");
			h.set("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Accept-Ranges");
			return new Response(resp.body, { status: resp.status, headers: h });
		}

		const archiveEntryName = file.archiveEntryName;
		if (archiveEntryName) {
			const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
			const archiveInfo = await botPool.getFileInfo(archiveFileId);
			const archiveResponse = await fetch(
				buildTelegramFileUrl(archiveInfo.file_path, archiveInfo.bot_token)
			);

			if (!archiveResponse.ok) {
				logger.error("Archive download failed", { publicId, status: archiveResponse.status });
				return fail(500, "Server error");
			}

			const tempZipPath = `/tmp/filedrop-dl-${nanoid()}.zip`;
			await writeBodyToFile(archiveResponse, tempZipPath);

			const loc = await locateZipEntry(tempZipPath, archiveEntryName);
			if (!loc) {
				await cleanupTempFile(tempZipPath);
				logger.error("Archive entry not found", { publicId, archiveEntryName });
				return fail(404, "File not found");
			}

			const fileStream = createReadStream(tempZipPath, {
				start: loc.start,
				end: loc.start + loc.length - 1,
			});

			fileStream.on("close", () => {
				void cleanupTempFile(tempZipPath);
			});
			fileStream.on("error", () => {
				void cleanupTempFile(tempZipPath);
			});

			return new Response(fileStream as unknown as ReadableStream, {
				status: 200,
				headers: {
					"Content-Type": file.mimeType || "application/octet-stream",
					"Content-Disposition": `attachment; filename="${sanitizeFilenameHeader(file.fileName)}"`,
					"Content-Length": String(loc.length),
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Accept-Ranges",
				},
			});
		}

		const fileInfo = await botPool.getFileInfo(file.telegramFileId);
		const telegramUrl = buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token);

		// CORS headers shared across all delivery modes — public file CDN.
		const corsHeaders: Record<string, string> = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Accept-Ranges",
			"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
			"Access-Control-Allow-Headers": "Range, Content-Type",
			Vary: "Origin",
		};

		try {
			const upstream = await fetch(telegramUrl);
			if (!upstream.ok) {
				logger.error("Telegram file download failed", {
					publicId,
					status: upstream.status,
				});
				return Response.json(
					{ error: "Upstream download failed" },
					{
						status: upstream.status === 404 ? 404 : 502,
						headers: corsHeaders,
					}
				);
			}

			const upstreamHeaders = new Headers(upstream.headers);
			// Content-Type resolution, in order of trustworthiness:
			//
			// 1. The upstream type, unless it is `application/octet-stream`. Telegram's
			//    CDN serves every re-encoded file (GIF→MP4, photo→JPEG) with that
			//    opaque type, so trusting it would make browsers download instead of
			//    play the file.
			// 2. For `animation`/`photo`, the real container derived from the file
			//    path Telegram hands back (`animations/file_x.mp4` → video/mp4). The
			//    DB mime type is what the user uploaded (`image/gif`), which no longer
			//    describes the bytes on the wire.
			// 3. The DB mime type, which is correct for every non-re-encoded file.
			const upstreamContentType = upstreamHeaders.get("content-type");
			const upstreamIsOpaque =
				upstreamContentType === null || upstreamContentType === "application/octet-stream";
			const reencodedType =
				file.fileType === "animation" || file.fileType === "photo"
					? (mimeFromPath(fileInfo.file_path) ?? file.mimeType)
					: null;
			const contentType =
				reencodedType ??
				(upstreamIsOpaque ? null : upstreamContentType) ??
				file.mimeType ??
				"application/octet-stream";

			// Content-Length must describe the body we are about to stream, not the
			// row in our database. Telegram re-encodes GIFs to MP4 and photos to
			// JPEG, so `file.sizeBytes` (the bytes the user uploaded) is routinely
			// larger than the served body. Sending the DB size truncated every such
			// download: the client stops after the declared length and reports a
			// network error. Trust the upstream length, and only fall back to the
			// DB value when the CDN does not report one.
			const upstreamLength = upstreamHeaders.get("content-length");
			const contentLength = upstreamLength ?? String(file.sizeBytes ?? 0);

			const headers: Record<string, string> = {
				"Content-Type": contentType,
				"Content-Disposition": `inline; filename="${sanitizeFilenameHeader(file.fileName)}"`,
				"Content-Length": contentLength,
				"Cache-Control": "public, max-age=300",
				...corsHeaders,
			};

			// Stream the Telegram CDN body back to the client (no cross-origin hop
			// in the browser → no CORS block for fetch/XHR audio playback).
			return new Response(upstream.body, {
				status: 200,
				headers,
			});
		} catch (error: unknown) {
			logger.error("Telegram file proxy error", {
				publicId,
				error: getErrorMessage(error),
			});
			return Response.json(
				{ error: "Upstream download failed" },
				{
					status: 502,
					headers: corsHeaders,
				}
			);
		}
	} catch (error: unknown) {
		logger.error("File redirect error", { publicId, error: getErrorMessage(error) });
		return fail(500, "Server error");
	}
};

/**
 * Handles file info requests.
 *
 * Looks up a file by its public identifier and returns its metadata as JSON.
 *
 * @param req - The incoming HTTP request with a `public_id` route parameter.
 * @returns A JSON response with file metadata, or 404 when not found.
 */
export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
	const publicId = req.params?.public_id;
	try {
		if (!publicId) {
			return fail(400, "Missing file id");
		}

		const file = await fileRepository.findByPublicId(publicId);
		if (!file) {
			logger.warn("File not found", { publicId });
			return fail(404, "File not found");
		}

		return Response.json(
			{
				public_id: file.publicId,
				file_name: file.fileName,
				mime_type: file.mimeType,
				size_bytes: file.sizeBytes,
				file_type: file.fileType,
				created_at: formatCreatedAt(file.createdAt),
			},
			{ status: 200 }
		);
	} catch (error: unknown) {
		logger.error("File info error", { publicId, error: getErrorMessage(error) });
		return fail(500, "Server error");
	}
};

/**
 * Handles public file listing.
 *
 * Lists non-deleted files ordered newest first, with cursor-based pagination.
 *
 * @param req - Incoming HTTP request.
 * @returns A JSON response with array of files and nextCursor.
 */
export const handleListPublicFiles = async (req: Request): Promise<Response> => {
	try {
		const url = new URL(req.url);
		const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
		const cursor = url.searchParams.get("cursor");

		const files = await fileRepository.listPublic(limit, cursor);
		const nextCursor =
			files.length > 0 && files.length >= Math.min(Math.max(1, limit), 100)
				? files[files.length - 1]?.createdAt.toISOString()
				: null;

		return Response.json(
			{
				files: files.map((f) => ({
					public_id: f.publicId,
					file_name: f.fileName,
					mime_type: f.mimeType,
					size_bytes: f.sizeBytes,
					file_type: f.fileType,
					created_at: formatCreatedAt(f.createdAt),
					download_url: `${config.baseUrl}/f/${f.publicId}`,
				})),
				next_cursor: nextCursor,
			},
			{ status: 200 }
		);
	} catch (error: unknown) {
		logger.error("List public files error", { error: getErrorMessage(error) });
		return fail(500, "Server error");
	}
};
