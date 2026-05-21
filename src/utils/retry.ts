import logger from './logger';

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: (error: unknown) => {
    const errorStr = error instanceof Error ? error.message : String(error);
    // Retry on transient errors
    return (
      errorStr.includes('ECONNREFUSED') ||
      errorStr.includes('ETIMEDOUT') ||
      errorStr.includes('ENOTFOUND') ||
      errorStr.includes('429') ||
      errorStr.includes('timeout')
    );
  },
};

export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const errorStr = error instanceof Error ? error.message : String(error);

      if (attempt === opts.maxRetries || !opts.shouldRetry(error)) {
        logger.error('Retry exhausted', {
          attempt,
          maxRetries: opts.maxRetries,
          error: errorStr,
        });
        throw error;
      }

      logger.warn('Retrying after error', {
        attempt,
        delay,
        error: errorStr,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
};

export const withTimeout = async <T>(
  fn: () => Promise<T>,
  timeoutMs: number = 30000,
): Promise<T> => {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
};

export const withFallback = async <T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> => {
  try {
    return await primary();
  } catch (error: unknown) {
    logger.warn('Primary operation failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
};
