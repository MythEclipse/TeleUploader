import { serve } from 'bun';
import logger from './utils/logger.js';
import { config } from './env.js';
import { startBot } from './bot.js';
import { handleUpload } from './routes/upload.js';
import { handleFileRedirect, handleFileInfo } from './routes/files.js';
import { handleHealth } from './routes/health.js';
import { cleanupRateLimitCache } from './utils/rateLimit.js';

const server = serve({
  port: config.port,
  routes: {
    '/api/upload': {
      POST: handleUpload
    },
    '/f/:public_id': {
      GET: handleFileRedirect
    },
    '/file/:public_id/info': {
      GET: handleFileInfo
    },
    '/health': {
      GET: handleHealth
    }
  }
});

const bot = await startBot();

logger.info('Server started', { port: config.port, url: config.baseUrl });

const gracefulShutdown = async (signal) => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server');
  server.stop();

  logger.info('Stopping Telegram bot');
  await bot.stop();

  logger.info('Server shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

setInterval(cleanupRateLimitCache, 60000);

logger.info('Application running successfully');
