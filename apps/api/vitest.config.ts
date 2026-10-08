import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Unit-suite runner configuration.
 *
 * Replaces the per-file `bun test --preload ...` chain that used to live in
 * `package.json`. `test/helpers/setup-env.ts` is loaded before every test file
 * (the old `--preload` flag) so `src/env.ts` sees its required env vars.
 *
 * The five files below are the `test:quarantine` set: they talk to the live
 * deployment or need credentials, so they are excluded here and run by
 * `vitest.quarantine.config.ts`.
 */
const QUARANTINE = [
  'test/telegram.test.ts',
  'test/upload.test.ts',
  'test/s3-docker-registry.test.ts',
  'test/s3-sdk.test.ts',
  'test/production-e2e.test.ts',
];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...QUARANTINE],
    setupFiles: ['./test/helpers/setup-env.ts'],
    environment: 'node',
    // bun ran test files one at a time in a single process; several tests bind
    // PORT=4000 and share /tmp prefixes, so parallel files would collide.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
