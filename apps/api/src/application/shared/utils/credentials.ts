import { randomBytes } from "node:crypto";

/**
 * Error raised when a rename or move would land on an existing key.
 *
 * A distinct class rather than a boolean or a string code, because the only
 * correct handling is a 409 and a caller that forgets to check a return value
 * would write an OVERWRITE. An error that must be caught is the right shape for
 * an operation whose silent failure destroys data.
 */
export class DestinationExistsError extends Error {
	/** Marks the error across a bundler boundary, where `instanceof` can fail. */
	readonly name = "DestinationExistsError";

	constructor(message: string) {
		super(message);
	}
}

/**
 * Whether a thrown driver error is a PostgreSQL `unique_violation` (SQLSTATE 23505).
 *
 * ## Why this walks the `cause` chain
 *
 * `db.execute()` does not throw the driver's error — drizzle ORM wraps it in a
 * `DrizzleQueryError` whose own `code` is `undefined`, with the real
 * `PostgresError` one level down at `cause`. Checking only the top level
 * therefore NEVER matched, and the consequences were inverted from the intent:
 * a rename onto an existing key threw out of the repository, reached the
 * controller's generic catch, and answered 500 for what is a 409. Found by
 * running `storage-live-probe.ts` against a real database — every mocked test
 * passed, because a mock never throws a wrapped error.
 *
 * Matched on the SQLSTATE code, never on the message text: postgres-js surfaces
 * the code as a property, while the message is localised by the server's
 * `lc_messages`, so a message match would work in one locale and not another.
 *
 * The walk is bounded to a handful of links: the chain is one deep today, and an
 * unbounded loop over a hostile object graph is its own defect.
 *
 * @param error - The caught value.
 * @returns `true` for a unique-constraint violation.
 */
export const isUniqueViolation = (error: unknown): boolean => {
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth += 1) {
		if (typeof current !== "object" || current === null) return false;
		if ((current as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
};

/** PostgreSQL's SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION_SQLSTATE = "23505";

/**
 * Generates a new S3 access key id.
 *
 * `AKIA`-prefixed and 20 characters total — four prefix characters plus sixteen
 * uppercase hex digits — matching the shape `aws-cli`, `rclone` and their config
 * validators expect. It is not an AWS key and grants nothing anywhere else; the
 * prefix exists because those tools reject shapes they do not recognise before they
 * ever sign a request.
 *
 * ## Why `randomBytes(8)` and not a larger draw
 *
 * Eight bytes is exactly sixteen hex digits, which is what fills the sixteen-character
 * body. An earlier version drew thirteen bytes and produced a 30-character key: the
 * doc comment said 20 while the code said 30, and nothing failed, because the only
 * test asserted the length the code happened to emit. Found by
 * `authenticated-surface-live-probe.ts` asserting the real AWS shape.
 *
 * 64 bits of entropy is the same budget AWS uses for this half of a key pair, and the
 * SECRET carries the signing strength — an access key id is an identifier that happens
 * to be unguessable, not the credential itself.
 *
 * @returns A fresh, 20-character access key.
 */
export const generateAccessKey = (): string =>
	`AKIA${randomBytes(8).toString("hex").toUpperCase()}`;

/**
 * Generates a new signing secret.
 *
 * 40 characters, the length those clients print on one line without wrapping.
 * The bytes come from `crypto.randomBytes`, not `Math.random`: this value IS the
 * credential, and a predictable one would be a forged signature away from
 * another tenant's data.
 *
 * @returns A fresh signing secret.
 */
export const generateSecretKey = (): string => randomBytes(30).toString("base64url").slice(0, 40);
