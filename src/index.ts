import { serve } from 'bun';
import { startBot } from './bot';
import { config } from './env';
import { handleFileInfo, handleFileRedirect } from './routes/files';
import { handleHealth } from './routes/health';
import { handleSwaggerHtml, handleSwaggerJson } from './routes/swagger';
import { handleUpload } from './routes/upload';
import logger from './utils/logger';
import { cleanupRateLimitCache } from './utils/rateLimit';

const server = serve({
  port: config.port,
  routes: {
    '/api/upload': {
      POST: handleUpload,
    },
    '/f/:public_id': {
      GET: handleFileRedirect,
    },
    '/file/:public_id/info': {
      GET: handleFileInfo,
    },
    '/health': {
      GET: handleHealth,
    },
    '/docs': {
      GET: handleSwaggerHtml,
    },
    '/swagger.json': {
      GET: handleSwaggerJson,
    },
  },
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
