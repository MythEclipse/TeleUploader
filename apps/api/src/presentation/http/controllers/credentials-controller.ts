import { z } from "zod";
import { config } from "../../../env";
import { bucketRepository, s3CredentialRepository } from "../../../infrastructure/di";
import { getErrorMessage } from "../../../infrastructure/file";
import logger from "../../../infrastructure/observability/logger";

/**
 * S3 credential management — the keys that make a user's bucket reachable from
 * `aws-cli`, `rclone` and the Docker registry client.
 *
 * ## Why this endpoint has to exist for the feature to be honest
 *
 * The S3 surface resolves credentials from `s3_credentials` ONLY: there is no
 * environment fallback, and `seed.ts` warns loudly when none exists. So an
 * organization whose users have buckets but no key pair has buckets that no
 * client can reach. Until now the dashboard's credentials panel said exactly
 * that — "no route returns an access key or secret" — and named the work.
 *
 * ## The secret is returned EXACTLY ONCE
 *
 * `POST` answers with the plaintext and no other route ever can: the listing
 * path selects a column list that does not include `secret_key`. That is the
 * same contract every credential issuer uses, and it is why the response is a
 * 201 body rather than a re-readable field.
 *
 * ## Scope
 *
 * Every operation acts on the caller's resolved organization. There is no
 * cross-tenant variant and no id that addresses a credential without its
 * organization, so an id from another tenant is a 404 rather than a leak.
 */

/** Body of `POST /api/v1/credentials`. */
const CreateCredentialSchema = z.object({
	/** Human label, e.g. "rclone on laptop". Optional so the common case is one field. */
	label: z.string().trim().max(120).optional(),
});

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

/** Maximum credentials one organization may hold at once. */
const MAX_CREDENTIALS_PER_ORG = 25;

/**
 * `GET /api/v1/credentials` — list the tenant's keys, never their secrets.
 *
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with the credential summaries.
 */
export const handleListCredentialsV1 = async (organizationId: string): Promise<Response> => {
	const credentials = await s3CredentialRepository.listByOrganization(organizationId);
	return json({ credentials });
};

/**
 * `POST /api/v1/credentials` — issue a new key pair for the tenant.
 *
 * ## The cap is not cosmetic
 *
 * Each call inserts a row that authenticates forever. Without a ceiling, a stuck
 * retry loop in a client mints thousands of live credentials and nobody notices
 * until an audit. The limit is generous enough that a human never meets it and
 * small enough that a loop stops quickly.
 *
 * @param req - The incoming request with an optional `label`.
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with the new pair, or an error.
 */
export const handleCreateCredentialV1 = async (
	req: Request,
	organizationId: string
): Promise<Response> => {
	let rawBody: unknown = {};
	try {
		rawBody = await req.json();
	} catch {
		// An absent body is legal: a caller that just wants a key sends nothing.
		// A malformed one is indistinguishable here, and the schema below treats
		// both as "no label", which is the correct default either way.
	}

	const parsed = CreateCredentialSchema.safeParse(rawBody);
	if (!parsed.success) {
		return jsonError("Invalid label: use at most 120 characters", 400);
	}

	const existing = await s3CredentialRepository.listByOrganization(organizationId);
	if (existing.length >= MAX_CREDENTIALS_PER_ORG) {
		return jsonError(
			`This workspace already holds ${MAX_CREDENTIALS_PER_ORG} credentials. Delete one before creating another.`,
			409
		);
	}

	const label = parsed.data.label?.length ? parsed.data.label : defaultLabel();
	const { credential, secretKey } = await s3CredentialRepository.create(organizationId, label);

	return json(
		{
			credential,
			// Present in THIS response and no other. The client shows it once and
			// the server cannot reproduce it — the column stores what the client
			// signs with, and the list query never selects it.
			secretKey,
			endpoint: config.baseUrl,
			region: config.s3DefaultRegion,
		},
		201
	);
};

/**
 * `DELETE /api/v1/credentials/{id}` — revoke one key.
 *
 * @param params - Route parameters containing the credential id.
 * @param organizationId - The resolved tenant.
 * @returns A JSON response indicating success, or 404.
 */
export const handleDeleteCredentialV1 = async (
	params: { id?: string },
	organizationId: string
): Promise<Response> => {
	const id = params.id ?? "";
	// Validated as a UUID before the query: a non-UUID reaches Postgres as a cast
	// error, which would surface as a 500 for what is really a bad request.
	if (!UUID_PATTERN.test(id)) return jsonError("Credential not found", 404);

	try {
		const deleted = await s3CredentialRepository.delete(id, organizationId);
		if (!deleted) return jsonError("Credential not found", 404);
		return json({ success: true });
	} catch (error: unknown) {
		logger.error("Credential delete failed", {
			organizationId,
			error: getErrorMessage(error),
		});
		return jsonError("Could not delete the credential", 500);
	}
};

/** A credential id, which is a `uuid` column and must be one before it is queried. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The label applied when the caller supplies none.
 *
 * Carries the date so a user who creates several keys months apart can tell them
 * apart in the list without having opened the dialog with a name in mind.
 *
 * @returns A human-readable default label.
 */
const defaultLabel = (): string => `key ${new Date().toISOString().slice(0, 10)}`;

/**
 * `GET /api/v1/credentials/scope` — which bucket this tenant's keys reach, and
 * whether the S3 surface is usable at all.
 *
 * The credentials panel used to infer the endpoint by probing an object's
 * `downloadUrl`, because nothing returned it. This answers directly, and adds
 * the one fact a client cannot discover: whether any credential exists yet.
 *
 * @param organizationId - The resolved tenant.
 * @returns A JSON response with the endpoint facts.
 */
export const handleCredentialScopeV1 = async (organizationId: string): Promise<Response> => {
	const buckets = await bucketRepository.list(organizationId);
	return json({
		endpoint: config.baseUrl,
		region: config.s3DefaultRegion,
		buckets: buckets.map((bucket) => bucket.name),
	});
};
