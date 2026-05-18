import logger from './utils/logger';

interface AppConfig {
  botToken: string;
  storageChatId: number;
  baseUrl: string;
  databaseUrl: string;
  port: number;
  nodeEnv: string;
  logLevel: string;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}

const requiredEnv = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  STORAGE_CHANNEL_ID: process.env.STORAGE_CHANNEL_ID,
  BASE_URL: process.env.BASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT
};

const missing = Object.entries(requiredEnv)
  .filter(([_, value]) => value === undefined || value === '')
  .map(([key]) => key);

if (missing.length > 0) {
  logger.error('Missing required environment variables:', missing);
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

export const config: AppConfig = {
  botToken: process.env.BOT_TOKEN!,
  storageChatId: parseInt(process.env.STORAGE_CHANNEL_ID!, 10),
  baseUrl: process.env.BASE_URL!,
  databaseUrl: process.env.DATABASE_URL!,
  port: parseInt(process.env.PORT!, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS!, 10) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS!, 10) || 30
};

logger.info('Environment variables loaded', { config: { ...config, botToken: config.botToken?.substring(0, 10) + '...' } });
