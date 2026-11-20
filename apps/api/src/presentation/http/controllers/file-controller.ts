import { createReadStream } from "node:fs";
import { nanoid } from "nanoid";
import { writeBodyToFile } from "../../../application/shared/utils/file-sink";
import {
	buildDownloadUrl,
	decodeStatelessLink,
	isStatelessToken,
	type StatelessPayload,
	splitStatelessToken,
} from "../../../application/shared/utils/stateless-link";
import { locateZipEntry } from "../../../application/shared/utils/zip";
import { config } from "../../../env";
import { chunkedStorage, fileRepository } from "../../../infrastructure/di";
import { cleanupTempFile, formatCreatedAt, getErrorMessage } from "../../../infrastructure/file";
import logger from "../../../infrastructure/observability/logger";
import { botPool } from "../../../infrastructure/telegram/bot-pool";
import { buildTelegramFileUrl } from "../../../infrastructure/telegram/file-url";
import { createGetObjectResponse } from "../../s3/object-stream";
import { parseRangeHeader } from "../../s3/range";
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
 * Two delivery paths, tried in this order:
 *
 * 1. **Stateless** — the route parameter is a signed payload carrying the
 *    `telegram_file_id`s (see `stateless-link.ts`). No database access at all.
 *    This is the path for files at or below `config.statelessLinkMaxBytes`.
 * 2. **Database** — the parameter is a `public_id` and the row is looked up.
 *    Large files, S3 objects, archive entries, and every link issued before
 *    stateless links existed.
 *
 * Order matters. A stateless token is long and base64url; a legacy `public_id` is
 * a 21-character nanoid. Both are valid base64url, so there is no shape test that
 * separates them reliably — `decodeStatelessLink` returning `null` is the only
 * honest discriminator, and it is safe to try first because a forged or corrupt
 * token costs one HMAC, not a query.
 *
 * Delivery by storage kind, once the file is resolved:
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

		// ── Stateless path ────────────────────────────────────────────────
		// Tried first and returns unconditionally when the signature verifies, so
		// a stateless link never touches Postgres — not even to check for a row.
		const { token } = splitStatelessToken(publicId);
		const stateless = decodeStatelessLink(token, config.statelessLinkSecret);
		if (stateless) {
			return await serveStateless(stateless, req);
		}

		// A token that LOOKS like one of ours but failed to verify must NOT fall
		// through to the database. Two reasons:
		//
		//  1. Downgrade. Someone could take a v3 token, flip the version byte to 2,
		//     and hand it over hoping it is parsed by the older, unencrypted branch.
		//     The v2 MAC covers the version byte so that specific flip fails — but
		//     the defence should not rest on one detail of a legacy format.
		//  2. Probe. Falling through turns "invalid token" into a different
		//     response (a DB 404) than a valid one, which tells an attacker their
		//     guess was structurally interesting.
		//
		// Legacy nanoids are 21 characters; anything shaped like a token that does
		// not decode is simply rejected.
		if (isStatelessToken(token)) {
			logger.warn("Rejected a stateless token that failed verification", {
				tokenLength: token.length,
			});
			return fail(404, "File not found");
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
 * Serves a file described entirely by its signed URL payload.
 *
 * No repository, no `files` row, no `file_parts` row — the only external calls are
 * `getFileInfo` (to turn a `file_id` into a download path) and the Telegram CDN
 * fetch itself.
 *
 * Single-part and multi-part are different code paths because they are different
 * problems:
 * - **single part**: proxy the CDN body straight through, exactly like the
 *   database path, including the `Content-Length` reasoning below.
 * - **multi part**: hand the parts to `createGetObjectResponse`, which already
 *   implements ordered reassembly, gzip inflate, and HTTP range slicing. Reusing
 *   it is the reason a 2-part file can still be seeked in a browser.
 *
 * @param payload - Verified payload from the URL.
 * @param req - The incoming request, used for `Range` and `HEAD`.
 * @returns The streaming response.
 */
const serveStateless = async (payload: StatelessPayload, req: Request): Promise<Response> => {
	const corsHeaders: Record<string, string> = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers":
			"Content-Disposition, Content-Length, Accept-Ranges, Content-Range",
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Allow-Headers": "Range, Content-Type",
		Vary: "Origin",
	};
	const lastModified = new Date(payload.createdAt * 1000).toUTCString();
	const disposition = `inline; filename="${sanitizeFilenameHeader(payload.fileName)}"`;

	if (payload.parts.length > 1) {
		const first = payload.parts[0];
		const parts = await Promise.all(
			payload.parts.map(async (part, index) => {
				const info = await botPool.getFileInfo(part.telegramFileId);
				return {
					telegramFileId: part.telegramFileId,
					telegramUrl: buildTelegramFileUrl(info.file_path, info.bot_token),
					sizeBytes: part.sizeBytes,
					storedSizeBytes: part.sizeBytes,
					compressionAlgorithm: part.compressionAlgorithm,
					partNumber: index + 1,
				};
			})
		);
		if (!first) return fail(500, "Server error");

		const response = await createGetObjectResponse({
			reqId: "",
			contentType: payload.mimeType || "application/octet-stream",
			etag: parts.map((part) => part.telegramFileId).join("-"),
			lastModified: new Date(payload.createdAt * 1000),
			totalSize: payload.sizeBytes,
			parts,
			// Range parsing is shared with the S3 path so a stateless multi-part
			// file supports `Range:` identically to a bucket object.
			range: parseRangeHeader(req.headers.get("range"), payload.sizeBytes),
		});

		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
		headers.set("Content-Disposition", disposition);
		return new Response(req.method === "HEAD" ? null : response.body, {
			status: response.status,
			headers,
		});
	}

	const part = payload.parts[0];
	if (!part) return fail(500, "Server error");

	const fileInfo = await botPool.getFileInfo(part.telegramFileId);
	const telegramUrl = buildTelegramFileUrl(fileInfo.file_path, fileInfo.bot_token);
	const upstream = await fetch(telegramUrl, {
		// HEAD must not pull the body: a 30 MB file would otherwise be downloaded
		// and discarded just to answer a metadata probe.
		method: req.method === "HEAD" ? "HEAD" : "GET",
	});
	if (!upstream.ok) {
		logger.error("Telegram file download failed (stateless)", { status: upstream.status });
		return Response.json(
			{ error: "Upstream download failed" },
			{ status: upstream.status === 404 ? 404 : 502, headers: corsHeaders }
		);
	}

	// Same `Content-Length` reasoning as the database path: Telegram re-encodes
	// some uploads (GIF→MP4, photo→JPEG), so the payload's size can be larger than
	// the bytes actually served. Declaring the payload size truncates the download.
	const upstreamLength = upstream.headers.get("content-length");
	const contentType =
		payload.mimeType && payload.mimeType !== "application/octet-stream"
			? payload.mimeType
			: (mimeFromPath(fileInfo.file_path) ?? "application/octet-stream");

	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Content-Disposition": disposition,
		"Content-Length": upstreamLength ?? String(payload.sizeBytes),
		"Last-Modified": lastModified,
		"Cache-Control": "public, max-age=300",
		...corsHeaders,
	};

	return new Response(req.method === "HEAD" ? null : upstream.body, { status: 200, headers });
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

		// Same ordering as `handleFileRedirect`: a valid stateless token answers
		// from its own payload, so a metadata probe costs no query either.
		const { token } = splitStatelessToken(publicId);
		const stateless = decodeStatelessLink(token, config.statelessLinkSecret);
		if (stateless) {
			return Response.json(
				{
					public_id: token,
					file_name: stateless.fileName,
					mime_type: stateless.mimeType,
					size_bytes: stateless.sizeBytes,
					// Not stored, but every consumer of this endpoint expects it, and
					// a stateless upload is always a plain document as far as the
					// caller is concerned.
					file_type: "document",
					created_at: formatCreatedAt(new Date(stateless.createdAt * 1000)),
				},
				{ status: 200 }
			);
		}

		// Same guard as `handleFileRedirect`, for the same reason: a token-shaped
		// value that fails verification must be rejected outright rather than
		// falling through to a database lookup. Otherwise the two paths answer
		// differently for "forged" and "not ours", which is a probe, and a
		// downgrade attempt gets a second chance against the legacy parser.
		if (isStatelessToken(token)) {
			logger.warn("Rejected a stateless token that failed verification", {
				tokenLength: token.length,
			});
			return fail(404, "File not found");
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
		// Clamped to [1, 100] here so garbage input cannot reach the repository:
		// `?limit=abc` used to become `LIMIT NaN` and a 500 from Postgres.
		const rawLimit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
		const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
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
					download_url: buildDownloadUrl(config.baseUrl, f.publicId, f.fileName),
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
