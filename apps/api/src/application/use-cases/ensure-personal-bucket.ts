import type { Bucket } from "../../domain/entities/bucket";
import type { IBucketRepository } from "../../domain/ports/bucket-repository";
import { slugFragment } from "../shared/utils/slug";
import { BucketNameSchema } from "../shared/validation/schemas";

/**
 * Provisioning of the bucket a user lands in on their first sign-in.
 *
 * ## Why every user needs one, and why it cannot be lazy
 *
 * A personal ORGANIZATION is created at sign-in (`ensurePersonalOrganization`),
 * but an organization with no bucket is a dashboard that renders an empty state
 * and an S3 credential that can address nothing. "Every user has their own
 * bucket" is therefore a provisioning step, not a UI affordance: it has to have
 * happened before the human sees the page, or the first thing a new account
 * does is create a bucket by hand.
 *
 * It is idempotent and safe to run on EVERY sign-in. A returning user already
 * has the row, so the second call is a single lookup.
 */

/** Dependencies for {@link createEnsurePersonalBucketUseCase}. */
export interface EnsurePersonalBucketDeps {
	readonly bucketRepository: IBucketRepository;
}

/**
 * The name a personal bucket gets, derived from the account's email.
 *
 * The suffix is `files` rather than the bare slug so the name reads as a place
 * to put things in an `aws s3 ls` listing, and so it cannot collide with an
 * organization slug namespace (a user whose org slug is `alice` still has a
 * bucket named `alice-files`).
 *
 * @param email - The account's email address.
 * @returns A valid S3 bucket name.
 */
export const personalBucketName = (email: string): string => `${slugFragment(email)}-files`;

/**
 * Builds the personal-bucket provisioning use case.
 *
 * @param deps - The injected bucket repository.
 * @returns A function ensuring one bucket exists for one user, returning it.
 */
export function createEnsurePersonalBucketUseCase(deps: EnsurePersonalBucketDeps) {
	return async (params: {
		/** The user's personal organization — where the bucket is created. */
		readonly organizationId: string;
		readonly email: string;
	}): Promise<Bucket> => {
		const base = personalBucketName(params.email);

		// A finite attempt list, not a loop to exhaustion: each collision consumes
		// a distinguishable suffix, and giving up loudly beats spinning on a
		// namespace that will not yield. `BucketNameSchema` is applied to every
		// candidate because the suffix changes the length and the trailing
		// character, both of which the rules constrain.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
			if (!BucketNameSchema.safeParse(candidate).success) continue;

			// `exists` rather than a catch on the unique violation: the repository
			// surfaces a name collision as a driver error, and a driver error is
			// indistinguishable here from a database outage. Asking first keeps
			// "the name is taken" and "the database is down" as separate outcomes.
			if (await deps.bucketRepository.exists(candidate, params.organizationId)) {
				// The row may be this user's own bucket from a previous sign-in, in
				// which case there is nothing to create and this is the answer.
				const existing = await deps.bucketRepository.findByName(candidate, params.organizationId);
				if (existing) return existing;
				continue;
			}

			return deps.bucketRepository.create(candidate, params.organizationId);
		}

		throw new Error(
			`Could not allocate a personal bucket for organization ${params.organizationId}`
		);
	};
}
