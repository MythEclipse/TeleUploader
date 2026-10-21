import type { AuthSession } from "../../application/dto/auth";
import { config } from "../../env";
import logger from "../observability/logger";

/**
 * Session resolution — better-auth first, this project's own table second.
 *
 * ## Why there are two sources
 *
 * better-auth owns NEW sign-ins (`/api/v1/auth/sign-in/social`, its callback,
 * `sign-out`). The `sessions` table owns sessions minted before it was installed,
 * which in practice means the hand-rolled Google flow in `auth-controller.ts`.
 * Both must resolve, or deploying this change logs everyone out mid-session.
 *
 * The order is deliberate: better-auth is checked FIRST because it is the going
 * concern, and the legacy table is a drain-only path — nothing new writes to it
 * once better-auth is wired, so it empties itself as sessions expire.
 *
 * ## Why the better-auth import is LAZY and failure-tolerant
 *
 * `better-auth.ts` runs `betterAuth({...})` at module load, and that constructor
 * validates its secret and base URL. Every one of the 20+ test files that imports
 * `middleware/auth.ts` — S3 auth, tenant authorization, routing — would start
 * paying that cost, and would fail outright on a machine with no
 * `BETTER_AUTH_SECRET` and no Google credentials, for a code path those tests
 * never exercise.
 *
 * So the module is imported on first real use, and a construction failure is
 * logged once and treated as "better-auth unavailable" rather than a crash. That
 * is the correct degradation: a deployment without better-auth configured still
 * authenticates through its existing sessions, and the failure is visible in the
 * log instead of taking the service down.
 */

/** Resolved caller facts, as the middleware's `AuthenticatedCaller` needs them. */
export interface ResolvedSession {
	readonly session: AuthSession;
	readonly userId: string;
	readonly email: string;
	readonly name: string;
}

/**
 * The better-auth instance, or `null` when it cannot be loaded.
 *
 * `undefined` means "not attempted yet"; `null` means "attempted and failed".
 * The distinction is what makes the warning fire exactly once instead of on
 * every request.
 */
let authInstance: { getSession: unknown } | null | undefined;

/**
 * Loads better-auth once.
 *
 * @returns The instance, or `null` when it is unusable on this deployment.
 */
const loadAuth = async (): Promise<{ getSession: unknown } | null> => {
	if (authInstance !== undefined) return authInstance;

	try {
		const { auth } = await import("../auth/better-auth");
		authInstance = auth as unknown as { getSession: unknown };
		return authInstance;
	} catch (error: unknown) {
		logger.warn("better-auth unavailable; falling back to the legacy session table", {
			error: error instanceof Error ? error.message : String(error),
		});
		authInstance = null;
		return null;
	}
};

/** Test seam: forget the memoized instance so a suite can re-probe. */
export const resetBetterAuthCache = (): void => {
	authInstance = undefined;
};

/**
 * Resolves better-auth's user id to this project's `users.id`.
 *
 * ## Why this mapping is necessary and not a formality
 *
 * better-auth identifies a person by `auth_user.id` (a TEXT column it generates).
 * This application identifies the same person by `users.id` (a UUID), and every
 * tenancy decision downstream keys off THAT: `members.user_id` holds it,
 * `files.uploader_user_id` stores it, and `?org=<slug>` resolves through it.
 *
 * Returning better-auth's id directly would be the subtle failure this function
 * prevents: `members` has no row for it, so `resolveCallerOrganization` would
 * answer "you are not a member of any organization" — a signed-in user with a 403
 * on every page, and 31k files apparently missing. The two id spaces are joined
 * on `email`, which `bridgeIdentity` guarantees is populated at sign-in.
 *
 * ## Failure mode
 *
 * Falls back to the better-auth id when no bridged row exists. That is a
 * degraded but non-fatal state: the caller is authenticated (so the UI can render
 * and offer a re-login) and the tenant lookup fails VISIBLY as a 403 rather than
 * silently resolving someone else's organization.
 *
 * @param betterAuthUserId - better-auth's `auth_user.id`.
 * @returns This project's `users.id` when bridged, else the input unchanged.
 */
export const resolveBridgedUserId = async (betterAuthUserId: string): Promise<string> => {
	try {
		const { db } = await import("../persistence/drizzle/index");
		const { sql } = await import("drizzle-orm");
		const rows = (await db.execute(sql`
			SELECT u.id FROM users u
			JOIN auth_user au ON au.email = u.email
			WHERE au.id = ${betterAuthUserId}
			LIMIT 1
		`)) as unknown as Record<string, unknown>[];
		const bridgedId = rows[0]?.id;
		return typeof bridgedId === "string" && bridgedId.length > 0 ? bridgedId : betterAuthUserId;
	} catch (error: unknown) {
		logger.warn("Could not bridge the better-auth user id to a users row", {
			betterAuthUserId,
			error: error instanceof Error ? error.message : String(error),
		});
		return betterAuthUserId;
	}
};

/**
 * Resolves the caller through better-auth.
 *
 * ## Why `getSession` is called on `api`, with the raw request headers
 *
 * better-auth's server-side endpoint takes a Fetch `Headers` object, not a
 * `Request`: it reads the session cookie itself and never needs the body. It
 * answers `null` for "no valid session", which is a normal signed-out state and
 * not an error.
 *
 * The `Object.hasOwn` guard is not defensive noise: on a deployment where
 * better-auth failed to construct, `api` is absent, and calling into it would
 * throw per-request instead of degrading once.
 *
 * @param req - The incoming request, for its cookie header.
 * @returns The resolved session, or `null`.
 */
export const resolveBetterAuthSession = async (req: Request): Promise<ResolvedSession | null> => {
	const instance = await loadAuth();
	if (!instance) return null;

	const api = (instance as { api?: { getSession?: unknown } }).api;
	if (!api || typeof api.getSession !== "function") return null;

	try {
		const result = (await (
			api.getSession as (input: { headers: Headers }) => Promise<{
				session?: { expiresAt?: Date | string };
				user?: { id?: string; email?: string; name?: string };
			} | null>
		)({ headers: req.headers })) as {
			session?: { expiresAt?: Date | string };
			user?: { id?: string; email?: string; name?: string };
		} | null;

		const userId = result?.user?.id;
		const email = result?.user?.email;
		if (!userId || !email) return null;

		// better-auth returns `expiresAt` as a Date. `AuthSession` declares
		// `Date | null`, so it is normalised to a Date here and serialised at the
		// response boundary — the DTO type is not widened just for this source.
		const rawExpiry = result?.session?.expiresAt;
		const expiresAt =
			rawExpiry instanceof Date
				? rawExpiry
				: typeof rawExpiry === "string"
					? new Date(rawExpiry)
					: new Date(Date.now() + config.sessionMaxAgeMs);

		return {
			session: {
				// better-auth has no notion of this DTO's `userId`+`username` split, so
				// the identity is mapped onto it rather than widened: every existing
				// consumer of `AuthSession` keeps compiling unchanged.
				userId,
				username: email,
				expiresAt,
				method: "cookie",
			},
			userId,
			email,
			name: result?.user?.name ?? "",
		};
	} catch (error: unknown) {
		// A malformed or forged cookie makes better-auth throw rather than answer
		// null. That is an unauthenticated request, not a server fault, so it must
		// not become a 500.
		logger.debug("better-auth session lookup rejected the credential", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
};
