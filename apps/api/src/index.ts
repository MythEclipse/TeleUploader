import { serve } from '@hono/node-server';
import { config } from './env';
import { fileInfoCache } from './infrastructure/cache/index';
import { logger } from './infrastructure/observability/logger';
import { metricsCollector } from './infrastructure/observability/metrics';
import { createApp } from './presentation/http/app';
import { cleanupRateLimitCache } from './presentation/http/middleware/rate-limit';
import { startBot } from './presentation/telegram/handler';

// ─── Migrations no longer run at boot (P2a) ─────────────────────────────────
// This used to execute schema.sql inside a try/catch that downgraded any failure
// to a warning. That made the schema unreproducible: the DDL was not
// version-controlled, a failed migration was invisible at startup, and this file
// plus schema.sql were two sources of truth. `pnpm db:migrate` (migrate.ts, using
// drizzle's migrator) is now the only migration path, and deploy.sh runs it over
// SSH before restarting the unit.

const app = createApp();

const server = serve({
  fetch: app.fetch,
  port: config.port,
  // closeAllConnections matters on shutdown: without it, keep-alive sockets hold
  // the server open past `systemctl restart`.
  overrideGlobalObjects: false,
});

const bot = await startBot();

logger.info('Server started', { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server — no new requests accepted');
  server.close();

  logger.info('Stopping Telegram bot');
  bot.stop(signal);

  logger.info('Server shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Periodic maintenance intervals. Timers are unref'd so they never keep the
// process alive on their own (safe no-op where `unref` is unavailable).
const unref = (timer: unknown): void => {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
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
    5 * 60 * 1000,
  ),
);
unref(
  setInterval(
    () => {
      const snapshot = metricsCollector.getSnapshot();
      logger.info('Metrics snapshot', {
        uploadLatency: snapshot.uploadLatency,
        uploadThroughput: snapshot.uploadThroughput.toFixed(2),
        errorRate: snapshot.errorRate.toFixed(2),
        cacheHitRate: snapshot.cacheHitRate.toFixed(2),
      });
    },
    5 * 60 * 1000,
  ),
);

logger.info('Application running successfully');
