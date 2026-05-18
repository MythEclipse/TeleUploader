// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import logger from '../src/utils/logger';
import { checkRateLimit, cleanupRateLimitCache } from '../src/utils/rateLimit';

// Spy on logger.warn
const warnSpy = spyOn(logger, 'warn');

describe('Rate Limiter', () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('should always allow requests as rate limiter is disabled', () => {
    const key = 'user-1';
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should no-op on cleanup', () => {
    expect(() => cleanupRateLimitCache()).not.toThrow();
  });
});
