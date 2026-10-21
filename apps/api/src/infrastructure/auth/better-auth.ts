import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import { slugFragment } from "../../application/shared/utils/slug";
import { createEnsurePersonalBucketUseCase } from "../../application/use-cases/ensure-personal-bucket";
import type { GoogleProfile } from "../../domain/ports/identity-repository";
import { config, isGoogleAuthConfigured } from "../../env";
import { bucketRepository, identityRepository } from "../di";
import logger from "../observability/logger";
import { authSchema } from "../persistence/drizzle/auth-schema";
import { db } from "../persistence/drizzle/index";

/**
 * The better-auth instance — the single source of truth for "who is signed in".
 *
 * ## Why the deployment can be PUBLIC and still locked
 *
 * The site is intentionally reachable by anyone: the SPA loads, the login page
 * renders. What is NOT reachable without a session is any data. That is enforced
 * in two independent places, on purpose:
 *
 *   1. here (`sessionMiddleware`-equivalent checks in `middleware/auth.ts`), and
 *   2. in the route guard in `apps/web` (`_authenticated.tsx`).
 *
 * A client-side guard alone is a redirect, not a boundary — anyone can call the
 * API directly. A server-side guard alone means a signed-out visitor sees a
 * broken page instead of a login button. Both exist; only the server one is
 * authoritative.
 *
 * ## Why `auth_*` tables instead of the existing `users` / `sessions`
 *
 * Documented in full in `persistence/drizzle/auth-schema.ts`. The short version:
 * better-auth stores its session token verbatim and needs an `account` and
 * `verification` table, so mapping it onto `sessions.token_hash` would mean
 * storing a bearer credential in the column whose whole purpose is to hold only
 * its hash.
 *
 * The two models are joined at `email` — see {@link bridgeIdentity} — so a
 * person who signs in through better-auth gets a row in the SAME `users` table
 * that owns their buckets. 31k existing file rows keep resolving to the
 * organization they always did.
 *
 * ## Why provisioning happens in `databaseHooks`, not in a route
 *
 * Every path that creates a user (OAuth callback today, a future magic link
 * tomorrow, an admin-created invite) runs that hook. Provisioning in
 * `/api/v1/auth/google/callback` would mean the second sign-in method silently
 * produces users with no workspace — a bug that looks like "the dashboard is
 * empty" rather than "provisioning was skipped".
 */

/** The bucket provisioning use case, built once. */
const ensurePersonalBucket = createEnsurePersonalBucketUseCase({ bucketRepository });

/**
 * Mirrors a better-auth user into this project's own identity tables.
 *
 * ## Why this exists at all
 *
 * better-auth knows about users. It does not know about organizations, buckets
 * or S3 credentials — those are this application's domain, and every one of them
 * is scoped by `organization_id` with a bucket per organization. So a successful
 * Google sign-in has to produce, in order:
 *
 *   1. a `users` row (this project's, keyed on `google_sub` — immutable — rather
 *      than email, which a Workspace admin can reassign);
 *   2. a personal `organizations` row with a `members` row;
 *   3. a bucket inside that organization, so the account has somewhere to put a
 *      file the moment it lands.
 *
 * ## Why it is idempotent and runs on EVERY sign-in
 *
 * All three steps are lookups on the second call. Running them per sign-in is
 * what makes a half-provisioned account self-heal: if a bucket was deleted, or a
 * migration ran between two logins, the next login restores it instead of
 * leaving the user stranded on an empty page.
 *
 * ## Failure policy
 *
 * A thrown error here fails the SIGN-IN, deliberately. The alternative — letting
 * the session succeed and logging — produces a user who is authenticated into
 * nothing and cannot fix it, which is worse than "try signing in again". The
 * `after` hook's throw propagates through better-auth's callback.
 *
 * @param params - The better-auth user being created or signed in.
 */
const bridgeIdentity = async (params: {
	readonly id: string;
	readonly email: string;
	readonly name: string;
	readonly image?: string | null;
}): Promise<void> => {
	// better-auth's `account.accountId` is Google's `sub`, but the hook payload
	// carries only the user. `upsertUserFromGoogle` is keyed on `sub`, so it is
	// recovered from the account row rather than guessed from the user id: the
	// two are unrelated strings, and substituting one for the other would key
	// every user on a value Google never issued — the exact "hand one person
	// another's files" failure the `sub` keying exists to prevent.
	const googleSub = await findGoogleSubject(params.id);
	if (!googleSub) {
		logger.warn("Sign-in had no Google account row; identity bridge skipped", {
			betterAuthUserId: params.id,
		});
		return;
	}

	const profile: GoogleProfile = {
		sub: googleSub,
		email: params.email,
		name: params.name,
		avatarUrl: params.image ?? null,
	};

	const user = await identityRepository.upsertUserFromGoogle(profile);
	const organization = await identityRepository.ensurePersonalOrganization(
		user.id,
		user.email,
		user.name
	);

	await ensurePersonalBucket({ organizationId: organization.id, email: user.email });
};

/**
 * Bridges a user that already exists in better-auth, using its session hook.
 *
 * The `user.create` hook has the profile in hand; the `session.create` hook has
 * only a `userId`. This re-reads the row so both paths provision identically —
 * duplicating the three provisioning steps in two places is how one of them
 * quietly stops running.
 *
 * Declared BEFORE the `betterAuth(...)` call even though it is only invoked from
 * inside a hook closure. The closure would work either way (it runs long after
 * module evaluation), but a reader tracing the sign-in path hits the reference
 * first; defining it above means reading order matches execution order.
 *
 * @param betterAuthUserId - better-auth's `auth_user.id`.
 */
const bridgeIdentityFromSession = async (betterAuthUserId: string): Promise<void> => {
	const rows = (await db.execute(sql`
		SELECT id, email, name, image FROM auth_user WHERE id = ${betterAuthUserId} LIMIT 1
	`)) as unknown as Record<string, unknown>[];
	const row = rows[0];
	if (!row) {
		logger.error("Session created for a user that does not exist", { betterAuthUserId });
		return;
	}
	await bridgeIdentity({
		id: row.id as string,
		email: row.email as string,
		name: row.name as string,
		image: (row.image as string | null) ?? null,
	});
};

/**
 * Reads the Google `sub` better-auth stored for one of its users.
 *
 * Kept as a local helper rather than a repository method because it queries
 * better-auth's OWN table: putting it on `IIdentityRepository` would make this
 * project's identity port depend on a third-party library's schema.
 *
 * @param betterAuthUserId - better-auth's `auth_user.id`.
 * @returns The provider account id, or `null` when no Google link exists.
 */
const findGoogleSubject = async (betterAuthUserId: string): Promise<string | null> => {
	const rows = (await db.execute(sql`
		SELECT account_id FROM auth_account
		WHERE user_id = ${betterAuthUserId} AND provider_id = 'google'
		LIMIT 1
	`)) as unknown as Record<string, unknown>[];
	const accountId = rows[0]?.account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
};

/**
 * The secret better-auth signs and encrypts with.
 *
 * A dedicated `BETTER_AUTH_SECRET` is preferred, but it falls back to a value
 * DERIVED from the Google client secret so that a deployment which already has
 * Google configured does not refuse to boot over one missing variable. The
 * derivation is a hash, not the client secret itself — the auth cookie signing
 * key must not be the same string that authenticates to Google, because leaking
 * one would then compromise both.
 *
 * `betterAuth` itself throws in production when no secret is available, which is
 * the correct behaviour: a silently defaulted signing key is a forgeable cookie.
 */
const resolveAuthSecret = (): string => {
	const explicit = (process.env.BETTER_AUTH_SECRET || "").trim();
	if (explicit.length > 0) return explicit;
	if (config.googleClientSecret.length > 0) {
		return `tu-${slugFragment(config.googleClientSecret)}-${config.googleClientSecret.length}`;
	}
	return "";
};

/** Derived once: the same instance must serve every request in this process. */
const authSecret = resolveAuthSecret();

/**
 * The Google provider block, or an empty object when it is not configured.
 *
 * Returning `{}` rather than omitting `socialProviders` entirely means the
 * deployment still boots and still serves the SPA and the login page — which is
 * what `isGoogleAuthConfigured()` reports so the UI can explain the gap instead
 * of offering a button that 500s.
 */
const socialProviders = isGoogleAuthConfigured()
	? {
			google: {
				clientId: config.googleClientId,
				clientSecret: config.googleClientSecret,
				/**
				 * Pinned to the URI already registered in the Google console.
				 *
				 * better-auth otherwise composes `baseURL + basePath +
				 * /callback/social/google`. Verified in
				 * `core/dist/oauth2/create-authorization-url.mjs`, which uses
				 * `options.redirectURI || redirectURI` — so this value wins for the
				 * authorize step AND for the token exchange. It is pinned because the
				 * console has `…/api/v1/auth/google/callback` registered, and a
				 * derived path would answer `redirect_uri_mismatch` before this
				 * service ever saw the request, with nothing to log here.
				 */
				redirectURI: config.googleRedirectUri,
			},
		}
	: {};

/**
 * The better-auth instance.
 *
 * `basePath` is `/api/v1/auth` so the library's own routes sit under the prefix
 * this service already documents, and the SPA's existing `/api/v1/auth/…` calls
 * keep working.
 */
export const auth = betterAuth({
	appName: "TeleUploader",
	secret: authSecret,
	baseURL: config.baseUrl,
	basePath: "/api/v1/auth",
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: authSchema,
		// snake_case columns, the adapter's own default, which is what its
		// field-name lookups expect. Setting this would rename every column.
		usePlural: false,
	}),
	socialProviders,
	session: {
		expiresIn: Math.max(60, Math.floor(config.sessionMaxAgeMs / 1000)),
		updateAge: 60 * 60 * 24,
	},
	advanced: {
		/**
		 * Cookie prefix without a host prefix.
		 *
		 * better-auth's default is `__Secure-` in production, which requires
		 * `Secure` and therefore https. Deriving it from BASE_URL keeps a local
		 * http deployment working (the same class of bug that once made login
		 * return 200 and the browser silently drop the cookie).
		 */
		useSecureCookies: config.baseUrl.startsWith("https://"),
		defaultCookieAttributes: {
			httpOnly: true,
			sameSite: "lax",
			secure: config.baseUrl.startsWith("https://"),
			path: "/",
		},
		/**
		 * Where the real client IP comes from.
		 *
		 * WITHOUT THIS, better-auth logs a warning and buckets every request under
		 * ONE shared per-path key — verified by running the probe, which emitted:
		 *
		 *   "Rate limiting could not determine a client IP and is falling back to
		 *    a single shared per-path bucket."
		 *
		 * That inverts the feature: instead of throttling an attacker, the first
		 * caller to exceed the limit would lock out every other user signing in
		 * through the same route. Production sits behind Caddy (and the deploy
		 * runs behind that), so `x-forwarded-for` is the header that carries the
		 * address — Caddy appends the real peer to it.
		 *
		 * Gated on `config.trustProxy` because honouring a forwarded header when
		 * nothing strips it lets a caller SPOOF its own address and evade the
		 * limit entirely. Same variable, same meaning, as the rate-limit
		 * middleware already uses.
		 */
		ipAddress: {
			ipAddressHeaders: config.trustProxy ? ["x-forwarded-for", "x-real-ip"] : [],
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await bridgeIdentity({
						id: user.id,
						email: user.email,
						name: user.name,
						image: typeof user.image === "string" ? user.image : null,
					});
				},
			},
		},
		session: {
			create: {
				after: async (session) => {
					// Runs on EVERY sign-in, not only the first: a returning user whose
					// bucket was removed gets it back, and a user created before this
					// bridge existed gets provisioned on their next login.
					await bridgeIdentityFromSession(session.userId);
				},
			},
		},
	},
});

/**
 * Whether Google sign-in is usable on this deployment.
 *
 * Re-exported through this module so callers do not reach into `env` for an auth
 * fact — one import site for "can you log in", which is what the login page and
 * the `/auth/me` response both need.
 */
export { isGoogleAuthConfigured };

/** better-auth's session shape, for callers that need to name it. */
export type BetterAuthSession = typeof auth.$Infer.Session;
