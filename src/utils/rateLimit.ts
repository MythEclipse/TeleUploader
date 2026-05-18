export const checkRateLimit = (_key: string): boolean => {
  return true;
};

export const cleanupRateLimitCache = (): void => {
  // No-op karena rate limit dinonaktifkan
};
