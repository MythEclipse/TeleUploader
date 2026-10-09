import { configDefaults, defineConfig } from "vitest/config";

/**
 * The `test:quarantine` set — the same five files bun used to run separately.
 *
 * These either hit the live deployment (`production-e2e`) or need credentials
 * / a running registry, so they are kept out of `pnpm test`. Long timeouts:
 * the network cases wait on real HTTP round trips.
 */

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
		include: [
			"test/telegram.test.ts",
			"test/upload.test.ts",
			"test/s3-docker-registry.test.ts",
			"test/s3-sdk.test.ts",
			"test/production-e2e.test.ts",
		],
		exclude: [...configDefaults.exclude],
		setupFiles: ["./test/helpers/setup-env.ts"],
		environment: "node",
		env: { [TARGET_URL_KEY]: operatorTarget },
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
