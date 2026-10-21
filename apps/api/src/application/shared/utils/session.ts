/**
 * Session token primitives — minting, hashing, and the cookie contract.
 *
 * ## Why these live in `application/`, not with the repository
 *
 * Kana non-negotiable #3 is that a use-case never imports `infrastructure/`
 * directly: everything it needs arrives through its dependency object, so the
 * decision layer can be tested without a database and cannot smuggle in a
 * concrete adapter. These two helpers used to sit in
 * `infrastructure/persistence/repositories/identity-repository.ts`, which forced
 * `application/use-cases/authenticate.ts` to import the repository MODULE —
 * pulling an entire Drizzle adapter into the sign-in use case just to hash a
 * string. That is the exact coupling the rule exists to prevent.
 *
 * The split is by capability, not by convenience:
 *
 *   - **Here (pure):** token format, hashing, expiry arithmetic. Deterministic
 *     functions of their arguments, no I/O, no framework. A use-case may own
 *     this policy, because a session's shape is a business decision.
 *   - **In the repository adapter (impure):** actually persisting the hash and
 *     resolving a token back to a user. A use-case reaches that only through the
 *     `IIdentityRepository` port.
 *
 * `node:crypto` is a platform primitive, not an infrastructure adapter — a hash
 * function is not a database, and the domain already uses
 * `application/shared/utils/crypto.ts` for constant-time comparison.
 */

import { createHash, randomUUID } from "node:crypto";

/** The prefix on a bearer `Authorization` header. */
export const BEARER_PREFIX = "Bearer ";

/**
 * Hashes a session token for storage.
 *
 * SHA-256 rather than a password hash (bcrypt/argon2) on purpose: this input is
 * 122 bits of CSPRNG output, not a low-entropy human password, so there is no
 * dictionary to defend against and a deliberately slow hash would only tax every
 * authenticated request. What hashing buys here is that a database read cannot
 * reconstruct a usable cookie.
 *
 * @param token - The opaque cookie value.
 * @returns 64-char lowercase hex, matching `sessions.token_hash`.
 */
export const hashSessionToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/**
 * Generates a new opaque session token.
 *
 * `randomUUID` is used rather than `Math.random` or a counter: this value IS the
 * credential, so it must come from the CSPRNG. 122 bits of entropy.
 *
 * @returns A URL-safe token safe to place in a cookie.
 */
export const generateSessionToken = (): string => randomUUID();

/**
 * Computes a session's absolute expiry.
 *
 * @param maxAgeMs - Lifetime in milliseconds (from `SESSION_COOKIE_MAX_AGE_SECONDS`).
 * @param now - Injectable clock, so a test can assert expiry without waiting.
 * @returns The instant the session stops being valid.
 */
export const sessionExpiryFrom = (maxAgeMs: number, now: number = Date.now()): Date =>
	new Date(now + maxAgeMs);

/**
 * Whether a session has expired.
 *
 * The cookie also carries `Max-Age`, but a browser is not a source of truth: it
 * can be cleared on the wrong side, kept past expiry by a custom client, or
 * replayed from a copied jar. The authoritative check is server-side.
 *
 * @param expiresAt - The stored expiry.
 * @param now - Injectable clock.
 * @returns `true` when the session is no longer valid.
 */
export const isSessionExpired = (expiresAt: Date, now: number = Date.now()): boolean =>
	expiresAt.getTime() <= now;
