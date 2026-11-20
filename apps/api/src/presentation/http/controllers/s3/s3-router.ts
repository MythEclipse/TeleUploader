import { s3CredentialRepository } from "../../../../infrastructure/di";
import { getErrorMessage } from "../../../../infrastructure/file";
import logger from "../../../../infrastructure/observability/logger";
import { verifyPresignedUrl, verifySignature } from "../../../s3/auth";
import { S3_CORS_HEADERS } from "../../../s3/headers";
import { decodeUriComponentSafe } from "../../../s3/uri";
import { s3ErrorResponse } from "../../../s3/xml";
import {
	handleCreateBucket,
	handleDeleteBucket,
	handleGetBucketVersioning,
	handleHeadBucket,
	handleListBuckets,
} from "./s3-bucket-handlers";
import { REGION, REQUEST_ID, s3Response } from "./s3-common";
import { handleListObjectsV1, handleListObjectsV2 } from "./s3-listing";
import {
	handleAbortMultipartUpload,
	handleCompleteMultipartUpload,
	handleCreateMultipartUpload,
	handleListMultipartUploads,
	handleListParts,
	handleUploadPart,
} from "./s3-multipart-handlers";
import { handleGetObject, handleHeadObject } from "./s3-object-read";
import { handleDeleteObject, handleDeleteObjects, handlePutObject } from "./s3-object-write";

/**
 * Builds an S3 OPTIONS preflight response with CORS headers.
 *
 * @returns A 204 No Content Response.
 */
export const s3OptionsResponse = (): Response =>
	new Response(null, { status: 204, headers: S3_CORS_HEADERS });

/**
 * Parses an S3 pathname into bucket and key components.
 *
 * Supports path-style URLs such as `/bucket-name/key/with/prefix`.
 *
 * Each segment is percent-decoded, but a malformed escape is NOT allowed to
 * throw. `decodeURIComponent` raises `URIError` on a lone `%` or an incomplete
 * sequence, and a URL path is attacker-controlled, so the throw escaped the
 * handler as a 500: `GET /{bucket}/%ZZ` answered `500 Internal Server Error`
 * instead of a client error. `malformed` carries that case back to the caller,
 * which answers `400 InvalidURI` — the same code AWS returns.
 *
 * @param pathname - The URL pathname.
 * @returns The extracted bucket and key (both may be null), or `malformed` when
 *   any segment cannot be decoded.
 */
export const parseS3Path = (
	pathname: string
): { bucket: string | null; key: string | null; malformed: boolean } => {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length === 0) return { bucket: null, key: null, malformed: false };
	if (parts.length === 1) return { bucket: parts[0], key: null, malformed: false };
	// Decode URI components to match virtual-hosted behavior (H10). Decoding is
	// per-segment so an encoded `/` inside a key (`a%2Fb`) stays part of the key
	// rather than becoming a path separator.
	const decoded: string[] = [];
	for (const segment of parts.slice(1)) {
		const value = decodeUriComponentSafe(segment);
		if (value === null) return { bucket: parts[0] ?? null, key: null, malformed: true };
		decoded.push(value);
	}
	return { bucket: parts[0] ?? null, key: decoded.join("/"), malformed: false };
};

/**
 * Converts a Request's headers into a plain key-value record (all keys
 * lowercased) for SigV4 signature verification.
 *
 * @param req - The incoming HTTP request.
 * @returns A record of lowercased header key-value pairs.
 */
export const headersToRecord = (req: Request): Record<string, string> => {
	const record: Record<string, string> = {};
	for (const [key, value] of req.headers.entries()) {
		record[key.toLowerCase()] = value;
	}
	return record;
};

/**
 * Maps a SigV4 access key to the organization that owns it.
 *
 * This is the tenancy root of the S3 surface: every bucket resolution below is
 * scoped by what this returns, so a key that resolves to nothing can reach no
 * bucket at all.
 */
export type S3OrganizationResolver = (accessKey: string) => Promise<string | null>;

/**
 * Default resolver — reads `s3_credentials`.
 *
 * Returns the credential's organization, or `null` for an unknown key. There is
 * deliberately no environment fallback: seed.ts carries the env pair into
 * `s3_credentials`, so the table is the single source of truth.
 */
export const defaultOrganizationResolver: S3OrganizationResolver = async (accessKey) => {
	const credential = await s3CredentialRepository.findByAccessKey(accessKey);
	if (!credential) return null;
	// Bookkeeping only — never let it fail a valid request.
	await s3CredentialRepository.touchLastUsed(credential.id);
	return credential.organizationId;
};

/**
 * Builds the secret resolver handed to the SigV4 verifiers.
 *
 * Memoized per request so a single request never issues two lookups for the
 * same key, and so the verifier's secret and the router's organization come
 * from the same row rather than two reads that could disagree.
 */
const makeSecretResolver = (): ((accessKey: string) => Promise<string | null>) => {
	const cache = new Map<string, Promise<string | null>>();
	return (accessKey: string) => {
		const cached = cache.get(accessKey);
		if (cached) return cached;
		const lookup = s3CredentialRepository
			.findByAccessKey(accessKey)
			.then((credential) => credential?.secretKey ?? null);
		cache.set(accessKey, lookup);
		return lookup;
	};
};

/**
 * Main S3 request dispatcher.
 *
 * Parses the request (method, path, query parameters, headers), validates
 * the SigV4 signature or presigned URL, and dispatches to the appropriate
 * bucket, object, or multipart operation handler.
 *
 * Supports both path-style (`/bucket/key`) and virtual-hosted-style
 * (`bucket.example.com/key`) addressing.
 *
 * @param req - The incoming S3 HTTP request.
 * @param virtualHostBucket - When the request was routed through a
 *                            virtual-hosted domain, the extracted bucket
 *                            name; otherwise `null`.
 * @param resolveOrganization - Maps a verified SigV4 access key to its owning
 *                              organization UUID. Injected so the S3 surface
 *                              has exactly one tenancy seam; every handler
 *                              dispatched below is scoped by whatever this
 *                              returns.
 * @returns An S3-formatted Response.
 */
export const handleS3Request = async (
	req: Request,
	virtualHostBucket: string | null = null,
	resolveOrganization: S3OrganizationResolver = defaultOrganizationResolver
): Promise<Response> => {
	const method = req.method;
	const url = new URL(req.url);
	const pathname = url.pathname;
	const reqId = REQUEST_ID();

	// Percent-decode BEFORE anything else, and never let a malformed escape
	// throw. `decodeURIComponent` raises `URIError` on a lone `%` or an
	// incomplete sequence (`%E0%A4`), and the path is attacker-controlled, so
	// `GET /{bucket}/%ZZ` used to escape the handler as a 500. It is a client
	// error: answer 400 InvalidURI, the code AWS uses. That also stops
	// aws-cli/rclone/Docker retrying a request that can never succeed.
	let bucket: string | null;
	let key: string | null;
	let malformed = false;

	if (virtualHostBucket) {
		bucket = virtualHostBucket;
		if (pathname === "/") {
			key = null;
		} else {
			const decoded = decodeUriComponentSafe(pathname.slice(1));
			malformed = decoded === null;
			key = decoded;
		}
	} else {
		const parsed = parseS3Path(pathname);
		bucket = parsed.bucket;
		key = parsed.key;
		malformed = parsed.malformed;
	}

	if (malformed) {
		return s3ErrorResponse(
			"InvalidURI",
			"Could not parse the specified URI.",
			pathname,
			400,
			reqId
		);
	}

	const headers = headersToRecord(req);
	const searchParams = url.searchParams;

	// Handle CORS preflight
	if (method === "OPTIONS") {
		return s3OptionsResponse();
	}

	// SigV4 authentication. The secret is resolved per access key instead of
	// being read from the environment pair, so a key that exists only in
	// `s3_credentials` authenticates and carries its organization.
	const isPresigned = searchParams.has("X-Amz-Signature");
	const resolveSecret = makeSecretResolver();
	const authResult = isPresigned
		? await verifyPresignedUrl({
				url: req.url,
				method,
				headers,
				resolveSecret,
				region: REGION,
			})
		: await verifySignature(method, req.url, headers, null, resolveSecret, REGION);

	if (!authResult.isValid) {
		// The error code decides the status, not a single boolean: a malformed
		// percent-escape is a 400 client error and an unsupported payload
		// encoding is a 501, and collapsing either into 403 told the client to
		// fix its credentials when the request itself was the problem.
		const status =
			authResult.errorCode === "NotImplemented"
				? 501
				: authResult.errorCode === "InvalidURI"
					? 400
					: 403;
		const message =
			authResult.errorCode === "NotImplemented"
				? "aws-chunked streaming payloads are not supported."
				: authResult.errorCode === "InvalidURI"
					? "Could not parse the specified URI."
					: isPresigned
						? "Presigned URL verification failed"
						: "Authentication required";
		return s3ErrorResponse(
			authResult.errorCode || "AccessDenied",
			message,
			pathname,
			status,
			reqId
		);
	}

	// Resolve the caller's organization from the access key the request
	// actually authenticated with. A key the credential store does not know
	// cannot be mapped to a tenant, so the request is denied — 403 AccessDenied,
	// never a 500.
	const accessKey = authResult.credential?.accessKey;
	const organizationId = accessKey ? await resolveOrganization(accessKey) : null;
	if (!organizationId) {
		return s3ErrorResponse("AccessDenied", "Authentication required", pathname, 403, reqId);
	}

	try {
		// ── Root: ListBuckets / Service-level operations ──
		if (!bucket) {
			if (method === "GET") {
				return handleListBuckets(organizationId, reqId);
			}
			return s3ErrorResponse(
				"MethodNotAllowed",
				"The specified method is not allowed against this resource.",
				"/",
				405,
				reqId
			);
		}

		// ── Bucket-level operations ──
		if (!key) {
			if (method === "GET") {
				if (searchParams.has("versioning")) {
					return handleGetBucketVersioning(bucket, organizationId, reqId);
				}
				if (searchParams.has("uploads")) {
					return handleListMultipartUploads(bucket, searchParams, organizationId, reqId);
				}
				const listType = searchParams.get("list-type");
				if (listType === "2") {
					return handleListObjectsV2(bucket, searchParams, organizationId, reqId);
				}
				return handleListObjectsV1(bucket, searchParams, organizationId, reqId);
			}
			if (method === "PUT") return handleCreateBucket(bucket, organizationId, reqId);
			if (method === "HEAD") return handleHeadBucket(bucket, organizationId, reqId);
			if (method === "DELETE") return handleDeleteBucket(bucket, organizationId, reqId);
			if (method === "POST") {
				if (searchParams.has("delete")) {
					const body = await req.text();
					return handleDeleteObjects(bucket, body, organizationId, reqId);
				}
				if (searchParams.has("tagging")) {
					return s3Response(null, 204, reqId);
				}
			}
			return s3ErrorResponse(
				"MethodNotAllowed",
				"The specified method is not allowed against this resource.",
				`/${bucket}`,
				405,
				reqId
			);
		}

		// ── Object-level: Multipart operations ──
		if (searchParams.has("uploads") && method === "POST") {
			return handleCreateMultipartUpload(
				bucket,
				key,
				searchParams,
				headers,
				organizationId,
				accessKey!,
				reqId
			);
		}
		if (searchParams.has("uploadId") && searchParams.has("partNumber") && method === "PUT") {
			return handleUploadPart(bucket, key, searchParams, req, organizationId, reqId);
		}
		if (searchParams.has("uploadId") && method === "POST") {
			const body = await req.text();
			return handleCompleteMultipartUpload(bucket, key, searchParams, body, organizationId, reqId);
		}
		if (searchParams.has("uploadId") && method === "DELETE") {
			return handleAbortMultipartUpload(bucket, key, searchParams, organizationId, reqId);
		}
		if (searchParams.has("uploadId") && method === "GET") {
			return handleListParts(bucket, key, searchParams, organizationId, reqId);
		}

		// ── Standard object operations ──
		if (method === "GET")
			return handleGetObject(bucket, key, searchParams, headers, organizationId, reqId);
		if (method === "HEAD") return handleHeadObject(bucket, key, headers, organizationId, reqId);
		if (method === "PUT")
			return handlePutObject(bucket, key, searchParams, headers, req, organizationId, reqId);
		if (method === "DELETE") return handleDeleteObject(bucket, key, organizationId, reqId);

		return s3ErrorResponse(
			"MethodNotAllowed",
			"The specified method is not allowed against this resource.",
			`/${bucket}/${key}`,
			405,
			reqId
		);
	} catch (error: unknown) {
		logger.error("S3 operation error", { bucket, key, error: getErrorMessage(error) });
		return s3ErrorResponse(
			"InternalError",
			"We encountered an internal error. Please try again.",
			pathname,
			500,
			reqId
		);
	}
};
