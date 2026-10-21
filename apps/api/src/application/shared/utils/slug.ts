/**
 * Slug derivation for namespaces that must be URL- and S3-safe.
 *
 * Shared by two callers that must agree on the same rule:
 *
 *  - `DrizzleIdentityRepository.ensurePersonalOrganization` names an
 *    organization's URL slug from the user's email local part; and
 *  - `createSignInUseCase` names a personal BUCKET from the same source.
 *
 * Two copies of this logic would be a silent divergence: a user whose
 * organization slugged `a-b` but whose bucket slugged `ab` is a bug nobody
 * notices until an S3 client is handed a name the console never shows.
 */

/** Longest slug this module will produce, leaving room for a uniqueness suffix. */
const MAX_SLUG_LENGTH = 40;

/** Used when the derived fragment is too short to be a legal name. */
const MINIMUM_SLUG_LENGTH = 3;

/** Fallback slug for an email whose local part yields nothing usable. */
export const FALLBACK_SLUG = "user";

/**
 * Derives a slug-safe fragment from an email's local part.
 *
 * Kept deliberately dumb: lowercase, non-alphanumerics collapsed to `-`, and
 * truncated so the result fits `varchar(63)` with room for a uniqueness suffix.
 * Uniqueness itself is NOT solved here — the callers append a discriminator and
 * retry, because a slug computed from an email cannot be unique on its own
 * (`a.b@x` and `a-b@x` collapse together).
 *
 * @param email - The address to derive from.
 * @returns A lowercase `[a-z0-9-]` fragment of at least {@link MINIMUM_SLUG_LENGTH} chars.
 */
export const slugFragment = (email: string): string => {
	const localPart = email.split("@")[0] ?? FALLBACK_SLUG;
	const cleaned = localPart
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	// 3 is the minimum the S3 bucket-name rules impose on the sibling namespace,
	// and an empty slug would produce `--<suffix>` which reads as a typo.
	return cleaned.length >= MINIMUM_SLUG_LENGTH ? cleaned.slice(0, MAX_SLUG_LENGTH) : FALLBACK_SLUG;
};
