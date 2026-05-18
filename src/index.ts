import { serve } from 'bun';
import logger from './utils/logger';
import { config } from './env';
import { startBot } from './bot';
import { handleUpload } from './routes/upload';
import { handleFileRedirect, handleFileInfo } from './routes/files';
import { handleHealth } from './routes/health';
import { cleanupRateLimitCache } from './utils/rateLimit';

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

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info('Graceful shutdown signal received', { signal });

  logger.info('Closing HTTP server');
  server.stop();

  logger.info('Stopping Telegram bot');
  bot.stop(signal);

  logger.info('Server shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

setInterval(cleanupRateLimitCache, 60000);

logger.info('Application running successfully');
