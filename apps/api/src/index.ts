import { config } from './env';
import { fileInfoCache } from './infrastructure/cache/index';
import { serve } from './infrastructure/http/serve';
import { logger } from './infrastructure/observability/logger';
import { metricsCollector } from './infrastructure/observability/metrics';
import { handleS3Request } from './presentation/http/controllers/s3-controller';
import { cleanupRateLimitCache } from './presentation/http/middleware/rate-limit';
import { routes } from './presentation/http/routes/index';
import { getS3RouteBucket, shouldHandleS3 } from './presentation/http/s3-detection';
import { startBot } from './presentation/telegram/handler';

// ─── Auto-run migration at startup ──────────────────────────────────────────
try {
  const { runMigration } = await import('./infrastructure/persistence/drizzle/migrate');
  await runMigration();
} catch {
  logger.warn('Auto-migration skipped (non-fatal)');
}

const server = serve({
  port: config.port,
  routes,
  fetch: async (req: Request) => {
    const headers = Object.fromEntries(req.headers);
    if (shouldHandleS3(req, headers)) {
      return handleS3Request(req, getS3RouteBucket(req));
    }
    return new Response('Not Found', { status: 404 });
  },
});

const bot = await startBot();

logger.info('Server started', { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server — no new requests accepted');
  server.stop();

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
