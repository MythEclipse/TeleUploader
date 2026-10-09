/**
 * Live-database support for the real-repository suites.
 *
 * WHY THIS FILE EXISTS
 *
 * `tenant-isolation.test.ts` and `s3-credential-lookup.test.ts` guard their
 * assertions behind `if (!live) return;`. Two defects follow from that, and
 * both were verified rather than assumed:
 *
 *   1. With no DATABASE_URL — which is exactly how CI ran them — `live` is
 *      false, every test returns before its first assertion, and vitest reports
 *      "12 passed". The suite could not fail, so it could not detect a
 *      regression in the exact bugs it was written for. Verified: with the
 *      `delete() ... RETURNING` fix reverted, the suite still reported
 *      "1 passed | 6 skipped" with no DATABASE_URL.
 *
 *   2. `if (!live) return` is not even a skip. Vitest counts it as PASSED. A
 *      reader of the output cannot distinguish "ran and passed" from "never
 *      ran", which is the failure mode this repository has been bitten by
 *      repeatedly: a declaration written somewhere and then trusted downstream
 *      instead of re-checked.
 *
 * So this helper splits the two cases that `live` conflated:
 *
 *   - NOT CONFIGURED (no DATABASE_URL) → a deliberate, VISIBLE skip. The run
 *     reports the tests as skipped and names the reason, so the coverage gap is
 *     on the face of the output rather than hidden inside a green build.
 *   - CONFIGURED BUT UNREACHABLE (DATABASE_URL set, server down / wrong port /
 *     wrong password / schema missing) → a HARD FAILURE in `beforeAll`. A
 *     misconfigured environment must never be silently downgraded to "skipped,
 *     all good", which is precisely how a broken CI database would hide a real
 *     regression behind a green tick.
 *
 * `describe.skipIf` / `it.skipIf` are used rather than a runtime early return
 * because only the former makes vitest print `skipped`.
 */

import { OFFLINE_DATABASE_URL } from "./setup-env";

/**
 * Result of the one-shot reachability probe.
 *
 * There is deliberately no "unreachable" state. A configured-but-broken database
 * must not be representable as a value the caller can quietly turn into a skip —
 * an earlier draft of this file had a third `unreachable` state and every caller
 * collapsed it into "not live", so a wrong password silently produced a green
 * "7 skipped" run. `probeLiveDatabase` throws in that case instead.
 */
export type LiveDbStatus =
	| { readonly state: "live" }
	| { readonly state: "unconfigured"; readonly reason: string };

/**
 * A non-empty DATABASE_URL means the operator INTENDED these suites to run.
 *
 * This is the discriminator that matters: an absent DATABASE_URL is a
 * legitimate offline configuration, but a present-and-broken one is a bug. Note
 * that `test/helpers/setup-env.ts` seeds a placeholder DATABASE_URL via `||=`,
 * so "set in the environment" has to be judged on that seeded value, not merely
 * on the key being present.
 */
// Read lazily, not captured at module scope: setup-env.ts assigns the placeholder
// during import, so a value captured here can be the pre-setup `undefined`
// depending on import order. Resolving on each call makes that ordering
// irrelevant.
const databaseUrl = (): string => process.env.DATABASE_URL?.trim() ?? "";

/** True when the environment really asks for a live database. */
export const liveDatabaseRequested = (): boolean => {
	const url = databaseUrl();
	if (url === "") return false;
	return url !== OFFLINE_DATABASE_URL;
};

/**
 * Probe the database exactly once, at module scope.
 *
 * A top-level await here is deliberate: the probe must finish before
 * `describe.skipIf(...)` is evaluated, because that call decides at
 * COLLECTION time whether the tests are registered as skipped or run. A probe
 * kicked off in `beforeAll` would arrive too late, and the suite would have to
 * fall back to a runtime early return — the exact mechanism being removed.
 */
export const probeLiveDatabase = async (probe: () => Promise<void>): Promise<LiveDbStatus> => {
	if (!liveDatabaseRequested()) {
		return {
			state: "unconfigured",
			reason:
				"DATABASE_URL is not set to a reachable test database. These assertions did NOT run. " +
				"CI provisions Postgres for this job; to run them locally see the header of " +
				"tenant-isolation.test.ts.",
		};
	}
	try {
		await probe();
		return { state: "live" };
	} catch (error) {
		// THROW, do not return a skip. The environment asked for these assertions to
		// run, so the honest outcome is a failing suite: reporting "skipped" here
		// would turn a broken CI database into a green build that proves nothing.
		// Thrown at module scope, this aborts collection and vitest exits non-zero.
		throw new Error(
			`DATABASE_URL is set to ${redact(databaseUrl())} but the database is NOT usable. ` +
				"These suites FAIL rather than skip in that case, because a skipped suite and a " +
				"passing suite look identical in the summary and only one of them proves anything. " +
				"If you meant to run offline, unset DATABASE_URL. Underlying error: " +
				describeError(error)
		);
	}
};

/** Strip the password out of a DSN so it is safe to print in test output. */
export const redact = (dsn: string): string => dsn.replace(/:\/\/([^:]*):[^@]*@/, "://$1:***@");

const describeError = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);
	// postgres.js stacks are long; the first line carries the actual cause.
	return message.split("\n")[0] ?? message;
};

/**
 * The sentence appended to every skip in these suites.
 *
 * `it.skipIf(cond)` accepts a reason string in vitest 5, but it is only
 * surfaced by some reporters — the summary line is always just "skipped". So
 * the reason is also carried here, and each suite asserts on it, keeping the
 * "did not run" claim visible even when a reporter swallows it.
 */
export const unconfiguredMessage = (reason: string): string => `[live-db] ${reason}`;
