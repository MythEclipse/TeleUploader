// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { checkRateLimit, cleanupRateLimitCache } from "../src/utils/rateLimit";
import logger from "../src/utils/logger";

// Spy on logger.warn
const warnSpy = spyOn(logger, "warn");

describe("Rate Limiter", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    // Set custom env variables for predictable tests
    process.env.RATE_LIMIT_WINDOW_MS = "100"; // 100ms window
    process.env.RATE_LIMIT_MAX_REQUESTS = "3"; // max 3 requests
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
  });

  it("should allow requests under the limit", () => {
    const key = "user-1";
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should block requests exceeding the limit and log a warning", () => {
    const key = "user-2";
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);

    // 4th request exceeds limit of 3
    expect(checkRateLimit(key)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    const callArgs = warnSpy.mock.calls[0];
    expect(callArgs[0]).toBe("Rate limit exceeded");
    expect(callArgs[1].key).toBe(key);
  });

  it("should reset request count after the window passes", async () => {
    const key = "user-3";
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(false); // blocked

    // Wait for window to expire (100ms)
    await new Promise((resolve) => setTimeout(resolve, 110));

    // Should be allowed again
    expect(checkRateLimit(key)).toBe(true);
  });

  it("should cleanup rate limit cache of expired keys", async () => {
    const key1 = "cleanup-1";
    const key2 = "cleanup-2";

    // Populate keys
    expect(checkRateLimit(key1)).toBe(true);
    expect(checkRateLimit(key2)).toBe(true);

    // Run cleanup immediately (none should be expired yet as 100ms hasn't passed)
    cleanupRateLimitCache();

    // Verify still tracked (counts shouldn't reset, e.g., if we consume remaining limits)
    expect(checkRateLimit(key1)).toBe(true); // request 2
    expect(checkRateLimit(key1)).toBe(true); // request 3
    expect(checkRateLimit(key1)).toBe(false); // request 4 (blocked)

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 110));

    // Run cleanup
    cleanupRateLimitCache();

    // Since they were deleted from the map, they should be initialized as new records
    // If they were cleaned up, we should be able to do 3 requests again
    expect(checkRateLimit(key1)).toBe(true); // 1
    expect(checkRateLimit(key1)).toBe(true); // 2
    expect(checkRateLimit(key1)).toBe(true); // 3
    expect(checkRateLimit(key1)).toBe(false); // 4 (blocked)
  });
});
