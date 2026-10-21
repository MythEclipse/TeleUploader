import { config } from "../../../env";
import { bucketRepository, fileManagementRepository } from "../../../infrastructure/di";
import { getErrorMessage } from "../../../infrastructure/file";
import logger from "../../../infrastructure/observability/logger";

/**
 * Storage accounting and cross-bucket search — the two reads the file manager
 * needs that no single-object endpoint can answer.
 *
 * ## Why these are separate from `web-api-controller.ts`
 *
 * That file owns the object and bucket CRUD routing. These two handlers are
 * AGGREGATES: one sums a tenant's storage, the other queries across every bucket
 * the tenant owns. They share the tenant-resolution contract (`?org=`, refused
 * rather than silently defaulted when the caller is not a member) but not the
 * routing table, so keeping them here means the dispatcher gains two branches
 * instead of two hundred lines.
 */

/** Route parameters for bucket-scoped reads. */
type RouteParams = { bucket?: string };

/**
 * Returns a successful JSON Response.
 *
 * @param data - The JSON-serialisable body.
 * @param status - HTTP status code (default 200).
 * @returns A JSON Response.
 */
const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/**
 * Returns a JSON error Response.
 *
 * @param error - The error message.
 * @param status - HTTP status code.
 * @returns A JSON error Response.
 */
const jsonError = (error: string, status: number): Response => Response.json({ error }, { status });

/** Server-reported cap on a single search, echoed in the response. */
export const SEARCH_RESULT_LIMIT = 200;

/**
 * `GET /api/v1/storage` — storage totals for the caller's organization.
 *
 * Reports bytes and object counts for the tenant as a whole AND per bucket, in
 * one round trip. The dashboard header needs the total and each bucket row needs
 * its own, so splitting this into two endpoints would mean the header and the
 * rows could disagree while both were loading.
 *
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with the totals.
 */
export const handleStorageUsageV1 = async (organizationId: string): Promise<Response> => {
	const [organization, buckets] = await Promise.all([
		fileManagementRepository.usageByOrganization(organizationId),
		bucketRepository.list(organizationId),
	]);

	// Per-bucket usage is a fan-out rather than one grouped query because the
	// repository's management port is bucket-scoped and `usageByOrganization`
	// already answers the tenant-wide total. A tenant has a handful of buckets;
	// if that stops being true this becomes one GROUP BY in the repository.
	const perBucket = await Promise.all(
		buckets.map(async (bucket) => {
			const usage = await fileManagementRepository.usageByBucket(bucket.id);
			return {
				id: bucket.id,
				name: bucket.name,
				bytes: usage.bytes,
				objects: usage.objects,
			};
		})
	);

	return json({
		organization: { bytes: organization.bytes, objects: organization.objects },
		buckets: perBucket,
	});
};

/**
 * `GET /api/v1/buckets/{bucket}/usage` — totals for one bucket.
 *
 * @param params - Route parameters containing the bucket name.
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with the bucket's totals, or 404.
 */
export const handleBucketUsageV1 = async (
	params: RouteParams,
	organizationId: string
): Promise<Response> => {
	const bucket = await bucketRepository.findByName(params.bucket!, organizationId);
	if (!bucket) return jsonError("Bucket not found", 404);

	const usage = await fileManagementRepository.usageByBucket(bucket.id);
	return json({ name: bucket.name, bytes: usage.bytes, objects: usage.objects });
};

/**
 * `GET /api/v1/search?q=...` — find objects by key fragment, across every
 * bucket the caller's organization owns.
 *
 * ## Why the query is required rather than optional
 *
 * An empty `q` would return the newest N objects across the tenant, which is a
 * different feature (a recents view) wearing the same URL. Answering 400 keeps
 * the endpoint's meaning single, and the dashboard never calls it without a
 * query because its search box debounces on a non-empty value.
 *
 * @param req - The incoming request, carrying `?q=`.
 * @param organizationId - The resolved tenant, which is what scopes the search.
 * @returns A JSON response with the matches.
 */
export const handleSearchObjectsV1 = async (
	req: Request,
	organizationId: string
): Promise<Response> => {
	const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
	if (query.length === 0) {
		return jsonError("A non-empty 'q' query parameter is required", 400);
	}

	try {
		const results = await fileManagementRepository.searchByKey(
			organizationId,
			query,
			SEARCH_RESULT_LIMIT
		);
		return json({
			query,
			results,
			// Stated rather than implied: the list is capped, and a caller that
			// assumes it is exhaustive would report "no such file" for a file that
			// exists beyond the cap.
			truncated: results.length >= SEARCH_RESULT_LIMIT,
			limit: SEARCH_RESULT_LIMIT,
		});
	} catch (error: unknown) {
		logger.error("Object search failed", {
			organizationId,
			error: getErrorMessage(error),
		});
		return jsonError("Search failed", 500);
	}
};

/**
 * `GET /api/v1/storage/endpoint` — the S3 endpoint and region a client should
 * be pointed at.
 *
 * Returns `config.baseUrl` and `config.s3DefaultRegion` rather than reading
 * `window.location.origin` on the client: behind the reverse proxy those differ,
 * and the endpoint that works is the one the server actually serves.
 *
 * @returns A JSON response with the endpoint facts.
 */
export const handleStorageEndpointV1 = (): Response =>
	json({
		endpoint: config.baseUrl,
		region: config.s3DefaultRegion,
		// Whether the S3 surface is reachable at all. It resolves credentials from
		// the database with no environment fallback, so an operator can serve the
		// dashboard while S3 is unusable — the UI says which.
		s3Enabled: Boolean(config.s3AccessKey && config.s3SecretKey),
	});
