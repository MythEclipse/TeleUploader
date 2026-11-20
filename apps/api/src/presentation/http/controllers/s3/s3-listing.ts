import { clampMaxKeys } from "../../../../application/shared/validation/schemas";
import type { File as FileEntity } from "../../../../domain/entities/file";
import { bucketRepository, fileRepository } from "../../../../infrastructure/di";
import { listBucketResultXml, listBucketV2ResultXml } from "../../../s3/xml";
import { etagOrFallback, resolveBucketOr404, s3Response } from "./s3-common";

/** Shape of an S3 list entry object. */
export type S3ListEntry = {
	key: string;
	sizeBytes: number;
	etag: string;
	lastModified: Date;
	mimeType: string;
};

/**
 * Maps a File entity to an S3 list entry object.
 *
 * @param file - The file entity from the repository.
 * @returns An S3 list entry with key, size, etag, last modified, and MIME type.
 */
export const mapFileToListEntry = (file: FileEntity): S3ListEntry => ({
	key: file.s3Key ?? "",
	sizeBytes: file.sizeBytes,
	etag: etagOrFallback(file),
	lastModified: file.createdAt instanceof Date ? file.createdAt : new Date(),
	mimeType: file.mimeType,
});

/**
 * The lexicographically last item of a truncated page — S3's `NextMarker` /
 * `NextContinuationToken`. Keys and common prefixes interleave, so the token is
 * whichever sorts last.
 */
const nextTokenForPage = (
	isTruncated: boolean,
	objects: { s3Key: string }[],
	prefixes: string[]
): string | null => {
	if (!isTruncated) return null;
	const lastKey = objects.at(-1)?.s3Key ?? null;
	const lastPrefix = prefixes.at(-1) ?? null;
	if (lastKey === null) return lastPrefix;
	if (lastPrefix === null) return lastKey;
	return lastPrefix > lastKey ? lastPrefix : lastKey;
};

/**
 * Handles GET /{bucket} (ListObjectsV1 with query parameters).
 *
 * @param bucket - The bucket name.
 * @param searchParams - URL query parameters (prefix, delimiter, max-keys,
 *                       marker, encoding-type).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListBucketResult response.
 */
export const handleListObjectsV1 = async (
	bucket: string,
	searchParams: URLSearchParams,
	organizationId: string,
	reqId: string
): Promise<Response> => {
	const bucketRecord = await resolveBucketOr404(
		bucketRepository,
		bucket,
		organizationId,
		`/${bucket}`,
		reqId
	);
	if (bucketRecord instanceof Response) return bucketRecord;

	const prefix = searchParams.get("prefix") || "";
	const delimiter = searchParams.get("delimiter") || null;
	const maxKeys = clampMaxKeys(searchParams.get("max-keys"));
	const marker = searchParams.get("marker") || null;
	const encodingType = searchParams.get("encoding-type") || null;

	const {
		objects,
		prefixes: commonPrefixes,
		hasMore,
	} = await fileRepository.listByPrefix(bucketRecord.id, prefix, delimiter, maxKeys, marker);

	// `hasMore` carries the repository's maxKeys+1 probe; the length comparison
	// stays as the fallback for test doubles that predate the field.
	const isTruncated = hasMore ?? objects.length > maxKeys;
	const displayObjects = objects.slice(0, maxKeys);
	const nextMarker = nextTokenForPage(isTruncated, displayObjects, commonPrefixes);

	const xml = listBucketResultXml(
		bucket,
		displayObjects.map(mapFileToListEntry),
		commonPrefixes,
		isTruncated,
		marker,
		maxKeys,
		prefix,
		delimiter,
		nextMarker,
		reqId,
		encodingType
	);

	return s3Response(xml, 200, reqId, { "content-type": "application/xml" });
};

/**
 * Handles GET /{bucket}?list-type=2 (ListObjectsV2).
 *
 * Small approved behavior fix: V2 previously used a bare
 * `Math.min(parse, 1000)` which admitted 0, negatives, and NaN. It now uses
 * the same `clampMaxKeys` ([1, 1000]) as V1.
 *
 * @param bucket - The bucket name.
 * @param searchParams - URL query parameters (prefix, delimiter, max-keys,
 *                       continuation-token, start-after, encoding-type).
 * @param reqId - The request identifier for S3 headers.
 * @returns An S3 XML ListBucketV2Result response.
 */
export const handleListObjectsV2 = async (
	bucket: string,
	searchParams: URLSearchParams,
	organizationId: string,
	reqId: string
): Promise<Response> => {
	const bucketRecord = await resolveBucketOr404(
		bucketRepository,
		bucket,
		organizationId,
		`/${bucket}`,
		reqId
	);
	if (bucketRecord instanceof Response) return bucketRecord;

	const prefix = searchParams.get("prefix") || "";
	const delimiter = searchParams.get("delimiter") || null;
	const maxKeys = clampMaxKeys(searchParams.get("max-keys"));
	const continuationToken = searchParams.get("continuation-token") || null;
	const startAfter = searchParams.get("start-after") || null;
	const encodingType = searchParams.get("encoding-type") || null;

	const {
		objects,
		prefixes: commonPrefixes,
		hasMore,
	} = await fileRepository.listByPrefix(
		bucketRecord.id,
		prefix,
		delimiter,
		maxKeys,
		continuationToken || startAfter
	);

	const isTruncated = hasMore ?? objects.length > maxKeys;
	const displayObjects = objects.slice(0, maxKeys);
	const nextContinuationToken = nextTokenForPage(isTruncated, displayObjects, commonPrefixes);

	const xml = listBucketV2ResultXml(
		bucket,
		displayObjects.map(mapFileToListEntry),
		commonPrefixes,
		isTruncated,
		maxKeys,
		prefix,
		delimiter,
		continuationToken,
		nextContinuationToken,
		displayObjects.length,
		reqId,
		encodingType
	);

	return s3Response(xml, 200, reqId, { "content-type": "application/xml" });
};
