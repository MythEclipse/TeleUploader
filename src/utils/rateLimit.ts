import logger from './logger';

interface RateLimitRecord {
  count: number;
  reset: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

export const checkRateLimit = (key: string): boolean => {
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS!, 10) || 60000;
  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS!, 10) || 30;

  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 0, reset: now + windowMs });
  }

  const record = rateLimitMap.get(key)!;

  if (now > record.reset) {
    record.count = 0;
    record.reset = now + windowMs;
  }

  if (record.count >= maxRequests) {
    logger.warn('Rate limit exceeded', { key, count: record.count, reset: record.reset });
    return false;
  }

  record.count++;
  return true;
};

export const cleanupRateLimitCache = (): void => {
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.reset) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    rateLimitMap.delete(key);
  }
};
