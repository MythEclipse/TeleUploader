import logger from './logger';

// Simple sliding window rate limiter
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const WINDOW_SIZE_MS = 60000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 100; // 100 requests per minute per IP

export const checkRateLimit = (key: string): boolean => {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  // No entry or window expired - create new entry
  if (!entry || now > entry.resetTime) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + WINDOW_SIZE_MS,
    });
    return true;
  }

  // Check if limit exceeded
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    logger.warn('Rate limit exceeded', { key, count: entry.count });
    return false;
  }

  // Increment counter
  entry.count++;
  return true;
};

export const cleanupRateLimitCache = (): void => {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug('Rate limit cache cleanup', { cleaned, remaining: rateLimitStore.size });
  }
};

export const getRateLimitStats = () => ({
  trackedIPs: rateLimitStore.size,
  windowSize: WINDOW_SIZE_MS,
  maxRequests: MAX_REQUESTS_PER_WINDOW,
});
