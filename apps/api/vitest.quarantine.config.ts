import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The `test:quarantine` set — the same five files bun used to run separately.
 *
 * These either hit the live deployment (`production-e2e`) or need credentials
 * / a running registry, so they are kept out of `pnpm test`. Long timeouts:
 * the network cases wait on real HTTP round trips.
 */
export default defineConfig({
  test: {
    include: [
      'test/telegram.test.ts',
      'test/upload.test.ts',
      'test/s3-docker-registry.test.ts',
      'test/s3-sdk.test.ts',
      'test/production-e2e.test.ts',
    ],
    exclude: [...configDefaults.exclude],
    setupFiles: ['./test/helpers/setup-env.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
