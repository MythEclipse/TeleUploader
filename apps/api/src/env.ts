import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TELEGRAM_CHUNK_SIZE_MAX_BYTES } from "./application/shared/utils/validation";
import { PositiveIntSchema } from "./application/shared/validation/schemas";
import logger from "./infrastructure/observability/logger";

interface AppConfig {
	/** Application version (read from package.json, kept in sync by scripts/bump-version.mjs) */
	appVersion: string;
	/** All bot tokens merged from BOT_TOKENS (or BOT_TOKEN + ADDITIONAL_BOT_TOKENS fallback) */
	botTokens: string[];
	/** Per-bot concurrency for Telegram API calls (default 1). */
	telegramBotConcurrency: number;
	storageChatId: number;
	baseUrl: string;
	databaseUrl: string;
	port: number;
	nodeEnv: string;
	logLevel: string;
	rateLimitWindowMs: number;
	rateLimitMaxRequests: number;
	trustProxy: boolean;
	batchMaxItems: number;
	batchMaxSizeBytes: number;
	maxRequestBodyBytes: number;
	telegramChunkSizeBytes: number;
	compressChunkedUploads: boolean;
	chunkCompressionMinSizeBytes: number;
	/**
	 * Files at or below this size get a self-contained link and NO database row.
	 *
	 * 0 disables stateless links entirely, routing every upload through the
	 * database. Kept configurable rather than hardcoded because the right
	 * threshold is a deployment decision: it trades rows for URL length, and a
	 * deployment that wants dedup/listing for everything can turn it off.
	 */
	statelessLinkMaxBytes: number;
	/**
	 * HMAC key for stateless links.
	 *
	 * Derived from the bot tokens when unset. That is not a shortcut — see the
	 * comment on the derivation below for why the lifetime is already shared.
	 */
	statelessLinkSecret: string;
	adminApiToken: string;
	sessionCookieName: string;
	sessionMaxAgeMs: number;
	bootstrapAdminId: string;
	/**
	 * Google OAuth client id. Empty means Google sign-in is not configured.
	 *
	 * NOT in `requiredEnv`: this module throws at import time, and every test,
	 * every migration and every backend-only deploy must keep working without
	 * Google credentials. An empty value disables the Google routes (they answer
	 * 503) rather than stopping the service — see `isGoogleAuthConfigured`.
	 */
	googleClientId: string;
	/** Google OAuth client secret. Server-side only; never sent to the browser. */
	googleClientSecret: string;
	/**
	 * Absolute callback URL registered in the Google Cloud console.
	 *
	 * Defaults to `${baseUrl}/api/v1/auth/google/callback`. It must match the
	 * console EXACTLY, including scheme and trailing slash, or Google answers
	 * `redirect_uri_mismatch` at the authorize step — a failure that happens before
	 * this service sees the request, so there is nothing to log here.
	 */
	googleRedirectUri: string;
	s3AccessKey: string;
	s3SecretKey: string;
	s3DefaultRegion: string;
	proxyS3Get: boolean;
	s3VhostDomains: string[];
	/**
	 * Absolute path to the built SPA directory. OPTIONAL.
	 *
	 * Deliberately NOT in `requiredEnv`: this module throws at import time and
	 * `src/index.ts` imports it before `serve()`, so a required value would stop
	 * every backend-only deploy, every test run, and every dev session that has
	 * not built the dashboard. Empty means "no SPA" and the API behaves exactly
	 * as it did before P4.
	 */
	webDistPath: string;
}

// Validate bot tokens: BOT_TOKENS (new) or fallback to BOT_TOKEN + ADDITIONAL_BOT_TOKENS
//
// NOT REQUIRED AT IMPORT TIME. This module throws on any missing variable, and it
// is imported by things that need nothing from Telegram — most importantly the
// Drizzle migrator, which only reads `config.databaseUrl` and then opens a
// database connection.
//
// Making the token mandatory meant a data-only migration could not run without
// Telegram credentials, and CI has no reason to hold a bot token. The symptom
// was `Error: Missing environment variables: BOT_TOKENS` from
// `apps/api/src/env.ts` inside `pnpm --filter filedrop exec tsx
// src/infrastructure/persistence/drizzle/migrate.ts`, which failed EVERY run of
// the `test` job and left the repository permanently red.
//
// The invariant that actually matters is enforced where it belongs: a Telegram
// handler cannot start without a token, because `new Telegraf(undefined)` fails
// loudly at startup. An empty pool is a valid state for every non-Telegram
// caller, so the config carries it and the consumers check it.
const botTokensRaw =
	process.env.BOT_TOKENS ||
	[process.env.BOT_TOKEN, process.env.ADDITIONAL_BOT_TOKENS].filter(Boolean).join(",");

if (!botTokensRaw) {
	// A warning, not a throw. NOISY ON PURPOSE: a deployment that really does need
	// Telegram should be visibly misconfigured rather than silently inert.
	logger.warn(
		"No bot tokens configured (BOT_TOKENS / BOT_TOKEN / ADDITIONAL_BOT_TOKENS). " +
			"Telegram handlers will refuse to start; database and HTTP paths are unaffected."
	);
}

const requiredEnv = {
	STORAGE_CHANNEL_ID: process.env.STORAGE_CHANNEL_ID,
	BASE_URL: process.env.BASE_URL,
	DATABASE_URL: process.env.DATABASE_URL,
	PORT: process.env.PORT,
};

const missing = Object.entries(requiredEnv)
	.filter(([_, value]) => value === undefined || value === "")
	.map(([key]) => key);

if (missing.length > 0) {
	logger.error("Missing required environment variables:", missing);
	throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

// Validate S3 credentials: if S3_ACCESS_KEY is explicitly set (env var present,
// not relying on default), S3_SECRET_KEY must also be set. An empty secret key
// would cause HMAC-SHA256 to "succeed" silently — a security hole.
const s3AccessKeyExplicit = "S3_ACCESS_KEY" in process.env;
const s3SecretKeyExplicit = "S3_SECRET_KEY" in process.env;
if (s3AccessKeyExplicit || s3SecretKeyExplicit) {
	const s3Key = (process.env.S3_ACCESS_KEY || "").trim();
	const s3Secret = (process.env.S3_SECRET_KEY || "").trim();
	if (s3Key && !s3Secret) {
		logger.error("S3_ACCESS_KEY is set but S3_SECRET_KEY is empty — this is a security risk");
		throw new Error(
			"S3_ACCESS_KEY requires S3_SECRET_KEY to be set. Set S3_SECRET_KEY or unset S3_ACCESS_KEY."
		);
	}
	if (s3Secret && !s3Key) {
		logger.warn("S3_SECRET_KEY is set but S3_ACCESS_KEY is not — S3 auth will use the default key");
	}
}

const parseNumber = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Parses the PORT env var with fail-fast validation.
 *
 * Defaults to 4000 ONLY when the variable is absent or empty. A present but
 * invalid value ('abc', '-5', '0') throws so the service refuses to start
 * misconfigured instead of silently listening on the wrong port.
 *
 * @param value - The raw `PORT` env var value.
 * @returns The validated port number.
 * @throws {Error} When the value is present but not a positive integer.
 */
const parsePort = (value: string | undefined): number => {
	if (value === undefined || value === "") return 4000;
	const parsed = PositiveIntSchema.safeParse(value);
	if (!parsed.success) {
		logger.error(`Invalid PORT value: ${JSON.stringify(value)} — PORT must be a positive integer`);
		throw new Error("PORT must be a positive integer");
	}
	return parsed.data;
};

const parseTokens = (value: string | undefined): string[] =>
	(value || "")
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t !== "");

const parseDomains = (value: string | undefined): string[] =>
	parseTokens(value).map((domain) =>
		domain
			.replace(/^https?:\/\//, "")
			.split("/")[0]
			.toLowerCase()
	);

const maskSecret = (value: string): string => {
	if (!value) return "";
	if (value.length <= 10) return "***";
	return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const maskDatabaseUrl = (value: string): string =>
	value.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");

// Fail-fast guard for TELEGRAM_CHUNK_SIZE_BYTES: chunked uploads store every
// part as a Telegram document and later resolve it via getFile, which only
// supports files up to 20 MB ("Bad Request: file is too big" above that).
// A chunk above the limit makes every part undownloadable — refuse to start
// instead of failing on the first large-file download.
// Stateless-link threshold. 30 MB is the requested default: it covers the small
// files that dominate uploads while keeping the URL short enough to paste.
//
// Clamped to TELEGRAM_CHUNK_SIZE_MAX_BYTES * 2 rather than left unbounded. The
// payload has to carry every part's file_id, and each part is at most 19 MiB, so
// a threshold of 30 MB means at most 2 parts and ~340 URL characters. Raising it
// to 500 MB would put ~53 file_ids in the URL — about 3100 characters, past what
// chat clients and proxies reliably carry, and past what is pleasant to paste.
// Deployments that want bigger stateless files should raise the chunk size first.
const statelessLinkMaxBytes = Math.min(
	parseNumber(process.env.STATELESS_LINK_MAX_BYTES, 30 * 1024 * 1024),
	TELEGRAM_CHUNK_SIZE_MAX_BYTES * 2
);

// Signing key for stateless links.
//
// DEFAULT DERIVATION IS FROM THE BOT TOKENS, and that is not laziness. A Telegram
// `file_id` can only be resolved by the bot that created it, so a stateless URL
// already dies the moment the bot that uploaded it leaves the pool — regardless of
// how the URL is signed. Deriving the HMAC key from the same tokens therefore adds
// no failure mode that did not already exist, and it means a deployment needs no
// new secret to get the feature.
//
// STATELESS_LINK_SECRET exists for the case where that coupling is unwanted (for
// example a token rotation you intend to survive). Set it and links outlive the
// bot pool.
const statelessLinkSecret =
	(process.env.STATELESS_LINK_SECRET || "").trim() ||
	// Not a security boundary on its own — the token itself is the entropy. The
	// prefix keeps this distinct from any other HMAC this service might derive
	// from the same input.
	`teleuploader-stateless-link-v1:${parseTokens(botTokensRaw).join(",")}`;

if (statelessLinkMaxBytes > 0 && parseTokens(botTokensRaw).length === 0) {
	logger.warn(
		"Stateless links are enabled but BOT_TOKENS is empty: links will be signed " +
			"with a placeholder secret and no upload can produce a resolvable file_id. " +
			"Set BOT_TOKENS, or set STATELESS_LINK_MAX_BYTES=0 to disable the feature."
	);
}

const telegramChunkSizeBytes = parseNumber(
	process.env.TELEGRAM_CHUNK_SIZE_BYTES,
	TELEGRAM_CHUNK_SIZE_MAX_BYTES
);
if (telegramChunkSizeBytes > TELEGRAM_CHUNK_SIZE_MAX_BYTES) {
	logger.error(
		`TELEGRAM_CHUNK_SIZE_BYTES=${telegramChunkSizeBytes} exceeds the maximum allowed chunk size ` +
			`${TELEGRAM_CHUNK_SIZE_MAX_BYTES} bytes (${TELEGRAM_CHUNK_SIZE_MAX_BYTES / (1024 * 1024)} MB). ` +
			"Telegram Bot API getFile cannot download files larger than 20 MB, so every stored part would " +
			'be undownloadable ("Bad Request: file is too big"). ' +
			`Set TELEGRAM_CHUNK_SIZE_BYTES to ${TELEGRAM_CHUNK_SIZE_MAX_BYTES} or lower.`
	);
	throw new Error(
		`TELEGRAM_CHUNK_SIZE_BYTES=${telegramChunkSizeBytes} exceeds the maximum allowed chunk size ` +
			`${TELEGRAM_CHUNK_SIZE_MAX_BYTES} bytes (${TELEGRAM_CHUNK_SIZE_MAX_BYTES / (1024 * 1024)} MB)`
	);
}

/**
 * The version baked into the bundle at build time.
 *
 * `esbuild --define:__APP_VERSION__=…` replaces this identifier with a string
 * literal, so the running process reports the version of the ARTEFACT it was
 * built from rather than the version of whatever `package.json` happens to sit
 * next to it on disk.
 *
 * ## Why the file lookup alone was not enough
 *
 * `readPackageVersion` reads `package.json` at runtime. That is correct in a dev
 * checkout and correct in the Nix bundle, but it is wrong on the production VPS:
 * the app runs from `/opt/teleuploader/dist/index.js`, so the first candidate
 * resolves to `/opt/teleuploader/dist/../package.json` = `/opt/teleuploader/package.json`
 * — a file `deploy.sh` never ships. It sat there from an old manual install
 * dated months back, still declaring `1.0.0`, so `/health` reported `1.0.0`
 * through every release up to 1.16.1. Nothing failed, because the health probe
 * only asserts HTTP 200 and never compared the version it printed.
 *
 * Baking the value in removes the dependency on a file the deploy does not
 * control, so the number cannot disagree with the code that is running.
 */
declare const __APP_VERSION__: string | undefined;

/**
 * Reads the application version from package.json.
 *
 * Retained for the unbundled paths (`tsx src/index.ts` in dev, and any consumer
 * that imports `env.ts` directly), where no `--define` substitution happened.
 *
 * Both candidate paths carry the same number because `scripts/bump-version.mjs`
 * rewrites every tracked manifest in one commit, so the version served by
 * `/health` cannot disagree with the version in the repository. That was not
 * true before: the old CI-side prepare hook only touched the root manifest, so a
 * bundled build read `apps/api/package.json` and reported a version that had not
 * moved since 1.2.9.
 */
const readPackageVersion = (): string => {
	// Candidates in priority order. In the Nix bundle the app lives at
	// $out/share/teleuploader/dist/index.js, so the package.json that was
	// copied alongside it is one level up from this module's directory. In a dev
	// checkout it sits in the repo root (process.cwd()). The version is read at
	// runtime so a bundled build still picks up the right file.
	const candidates = [
		`${dirname(fileURLToPath(import.meta.url))}/../package.json`,
		`${process.cwd()}/package.json`,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
			if (parsed.version) return parsed.version;
		} catch {
			// try next candidate
		}
	}
	return "0.0.0";
};

/**
 * Resolves the version to serve from `/health`.
 *
 * @returns The build-time constant when the bundle was built with `--define`,
 *   otherwise the manifest's version.
 */
const resolveAppVersion = (): string =>
	// `typeof` rather than a bare reference: in an unbundled run the identifier
	// does not exist at all, and a bare `__APP_VERSION__` would throw a
	// ReferenceError at module load. esbuild rewrites this guard to `true` when
	// the define is present.
	typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : readPackageVersion();

export const config: AppConfig = {
	appVersion: resolveAppVersion(),
	botTokens: parseTokens(botTokensRaw),
	telegramBotConcurrency: parseNumber(process.env.TELEGRAM_BOT_CONCURRENCY, 1),
	storageChatId: parseInt(process.env.STORAGE_CHANNEL_ID!, 10),
	baseUrl: process.env.BASE_URL!,
	databaseUrl: process.env.DATABASE_URL!,
	port: parsePort(process.env.PORT),
	nodeEnv: process.env.NODE_ENV || "development",
	logLevel: process.env.LOG_LEVEL || "info",
	rateLimitWindowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000),
	rateLimitMaxRequests: parseNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 150),
	trustProxy: process.env.TRUST_PROXY === "true",
	batchMaxItems: parseNumber(process.env.BATCH_MAX_ITEMS, 20),
	batchMaxSizeBytes: parseNumber(process.env.BATCH_MAX_SIZE_BYTES, 500 * 1024 * 1024),
	maxRequestBodyBytes: parseNumber(process.env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024 * 1024),
	telegramChunkSizeBytes,
	statelessLinkMaxBytes,
	statelessLinkSecret,
	compressChunkedUploads: process.env.COMPRESS_CHUNKED_UPLOADS !== "false",
	chunkCompressionMinSizeBytes: parseNumber(process.env.CHUNK_COMPRESSION_MIN_SIZE_BYTES, 4096),
	adminApiToken: process.env.ADMIN_API_TOKEN || "",
	sessionCookieName: process.env.SESSION_COOKIE_NAME || "tu_session",
	sessionMaxAgeMs: parseNumber(process.env.SESSION_COOKIE_MAX_AGE_SECONDS, 86400) * 1000,
	bootstrapAdminId: process.env.BOOTSTRAP_ADMIN_ID || "bootstrap-admin",
	googleClientId: process.env.GOOGLE_CLIENT_ID || "",
	googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
	// Derived from BASE_URL rather than required separately: the callback lives on
	// this service, so its origin is already known and a second variable is one
	// more thing to get out of sync with the Google console.
	googleRedirectUri:
		process.env.GOOGLE_REDIRECT_URI ||
		`${(process.env.BASE_URL || "").replace(/\/$/, "")}/api/v1/auth/google/callback`,
	s3AccessKey: process.env.S3_ACCESS_KEY || "filedrop-admin",
	s3SecretKey: process.env.S3_SECRET_KEY || "",
	s3DefaultRegion: process.env.S3_DEFAULT_REGION || "us-east-1",
	proxyS3Get: process.env.PROXY_S3_GET !== "false",
	s3VhostDomains: parseDomains(
		process.env.S3_VHOST_DOMAINS ||
			"upload.asepharyana.my.id,asepharyana.web.id,upload.asepharyana.web.id"
	),
	webDistPath: process.env.WEB_DIST_PATH || "",
};

/**
 * Whether Google sign-in is configured.
 *
 * Both halves are required: a client id without a secret can start a flow but
 * cannot exchange the code, so treating it as "configured" would send users to
 * Google and then fail at the callback. A half-configured deployment answers 503
 * up front instead.
 *
 * @returns `true` when both the client id and the secret are present.
 */
export const isGoogleAuthConfigured = (): boolean =>
	config.googleClientId.length > 0 && config.googleClientSecret.length > 0;

// Debug-level: every import of env.ts would otherwise dump the full config
// (secrets masked, but still one noisy line per test file) to the log stream.
logger.debug("Environment variables loaded", {
	config: {
		...config,
		botTokens: config.botTokens.map(maskSecret),
		databaseUrl: maskDatabaseUrl(config.databaseUrl),
		adminApiToken: maskSecret(config.adminApiToken),
		adminApiTokenEnabled: config.adminApiToken.length > 0,
		// The client secret is masked and the client id is left in the clear: the id
		// is public (it appears in the browser's authorize URL), the secret is not.
		// Masking it here matters because this projection is what gets logged, and a
		// secret that reaches a log line has to be rotated.
		googleClientId: config.googleClientId,
		googleClientSecret: maskSecret(config.googleClientSecret),
		googleAuthEnabled: isGoogleAuthConfigured(),
		s3AccessKey: maskSecret(config.s3AccessKey),
		s3SecretKey: maskSecret(config.s3SecretKey),
	},
});

// probe

// probe
