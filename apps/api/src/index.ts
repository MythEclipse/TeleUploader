import { serve } from "@hono/node-server";
import { config } from "./env";
import { fileInfoCache } from "./infrastructure/cache/index";
import { logger } from "./infrastructure/observability/logger";
import { metricsCollector } from "./infrastructure/observability/metrics";
import { createApp } from "./presentation/http/app";
import { cleanupRateLimitCache } from "./presentation/http/middleware/rate-limit";
import { startBot } from "./presentation/telegram/handler";

// ─── Migrations no longer run at boot (P2a) ─────────────────────────────────
// This used to execute schema.sql inside a try/catch that downgraded any failure
// to a warning. That made the schema unreproducible: the DDL was not
// version-controlled, a failed migration was invisible at startup, and this file
// plus schema.sql were two sources of truth. `pnpm db:migrate` (migrate.ts, using
// drizzle's migrator) is now the only migration path.
//
// WIRED INTO DEPLOY (P5). deploy.sh stages `dist/migrate.js` together with the
// `drizzle/` journal folder and runs it over `bws-exec`, after the new bundle is
// installed and before `systemctl restart` — deploy.sh:536. That ordering is
// load-bearing and is asserted in apps/api/test/deploy-config.test.ts.
//
// WHY THIS NOTE EXISTS. An earlier revision of this comment read "NOT YET WIRED
// INTO DEPLOY. As of P3b, deploy.sh still does not invoke migrate.js". It was
// true when written, then it was silently out of date once P5 landed, and
// nobody re-read it. A false claim sitting in the most-read file in the repo is
// worse than no comment: it is the exact defect shape this migration has now
// hit eight times — a claim written in one place and TRUSTED downstream instead
// of re-checked. That is why every finding in a Build-lane report must cite a
// command actually run plus its real output, or be labelled UNVERIFIED, and why
// the deploy wiring is a trip-wire test instead of a comment. If you change the
// deploy path, re-run the commands; do not trust this paragraph.

// ─── Tenant scoping is no longer a boot-time hard failure ───────────────────
//
// This block used to call `resolveAdminOrganizationId()` and `process.exit(1)`
// when the bootstrap admin had no organization membership. That was correct while
// there was exactly ONE identity and every dashboard request shared it: the
// membership was mandatory infrastructure.
//
// Multi-user changes the premise. The scope is now resolved PER CALLER from their
// session (`resolveCallerOrganization`), so a missing bootstrap membership no
// longer bricks the dashboard — it only means the shared `ADMIN_API_TOKEN` path
// has no default organization. Exiting on that would make a deployment where
// every human signs in with Google refuse to boot because of a machine credential
// nobody configured.
//
// So it is a WARNING now, and the runtime answers 503 for the one path that
// genuinely needs it. Fail-fast is preserved where it still means something: the
// bearer path reports its own misconfiguration at the moment it is used.
try {
	const { bootstrapOrganizationId } = await import("./presentation/http/middleware/auth");
	const organizationId = await bootstrapOrganizationId();
	logger.info("Bootstrap organization resolved for the shared admin token", { organizationId });
} catch (error: unknown) {
	logger.warn(
		"No bootstrap organization for the shared admin token. Google sign-in and per-user " +
			"organizations are unaffected; callers using ADMIN_API_TOKEN as a Bearer credential " +
			"will receive 503 until `pnpm db:seed` runs.",
		{ error: error instanceof Error ? error.message : String(error) }
	);
}

const app = createApp();

const server = serve({
	fetch: app.fetch,
	port: config.port,
	// closeAllConnections matters on shutdown: without it, keep-alive sockets hold
	// the server open past `systemctl restart`.
	overrideGlobalObjects: false,
});

const bot = await startBot();

logger.info("Server started", { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal: string): Promise<void> => {
	logger.info("Graceful shutdown signal received", { signal });

	logger.info("Closing HTTP server — no new requests accepted");
	server.close();

	logger.info("Stopping Telegram bot");
	bot.stop(signal);

	logger.info("Server shutdown complete");
	process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Periodic maintenance intervals. Timers are unref'd so they never keep the
// process alive on their own (safe no-op where `unref` is unavailable).
const unref = (timer: unknown): void => {
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref?: () => void }).unref?.();
	}
};

unref(setInterval(cleanupRateLimitCache, 60000));
unref(
	setInterval(
		() => {
			const removed = fileInfoCache.cleanup();
			if (removed > 0) {
				logger.info(`Cleaned up ${removed} expired cache entries`);
			}
		},
		5 * 60 * 1000
	)
);
unref(
	setInterval(
		() => {
			const snapshot = metricsCollector.getSnapshot();
			logger.info("Metrics snapshot", {
				uploadLatency: snapshot.uploadLatency,
				uploadThroughput: snapshot.uploadThroughput.toFixed(2),
				errorRate: snapshot.errorRate.toFixed(2),
				cacheHitRate: snapshot.cacheHitRate.toFixed(2),
			});
		},
		5 * 60 * 1000
	)
);

logger.info("Application running successfully");
