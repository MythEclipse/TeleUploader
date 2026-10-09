import { configDefaults, defineConfig } from "vitest/config";

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
	"test/telegram.test.ts",
	"test/upload.test.ts",
	"test/s3-docker-registry.test.ts",
	"test/s3-sdk.test.ts",
	"test/production-e2e.test.ts",
];

/**
 * The deployment target, captured BEFORE vite touches the environment.
 *
 * vite injects its own `base` into both `process.env.BASE_URL` and
 * `import.meta.env.BASE_URL`, and it does so before any test file or setup file
 * runs. By the time `test/helpers/setup-env.ts` executes, the operator's value is
 * gone in every channel JS can see:
 *
 *     [probe] viteEnv.BASE_URL      = "/"
 *     [probe] process.env.BASE_URL = "/"
 *
 * even with `BASE_URL=https://upload.asepharyana.my.id` exported in the shell.
 * Only a differently-named variable survives (verified: `VITE_BASE_URL` came
 * through untouched), which is the tell that this is vite's key specifically and
 * not a general loss of the environment.
 *
 * A config file is evaluated before that injection, so this is the last place the
 * real value is still visible. It is re-published under a distinct key that
 * setup-env.ts prefers; `test/base-url-targeting.test.ts` pins the behaviour.
 *
 * Without this, the five quarantined suites cannot be aimed at anything: they read
 * BASE_URL at module scope, got example.com, and 20 of 22 S3 SDK tests failed
 * against a deployment that was serving perfectly.
 */
const TARGET_URL_KEY = "TEST_TARGET_URL";
const operatorTarget =
	process.env[TARGET_URL_KEY] ??
	process.env.BASE_URL ??
	process.env.VITE_BASE_URL ??
	"https://example.com";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [...configDefaults.exclude, ...QUARANTINE, "test/fixtures/**"],
		setupFiles: ["./test/helpers/setup-env.ts"],
		environment: "node",
		
		// bun ran test files one at a time in a single process; several tests bind
		// PORT=4000 and share /tmp prefixes, so parallel files would collide.
		fileParallelism: false,
		testTimeout: 15_000,
		hookTimeout: 15_000,
	},
});
