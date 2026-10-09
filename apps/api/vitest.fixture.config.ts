import { configDefaults, defineConfig } from "vitest/config";

/**
 * Runs ONE fixture, in isolation, from a real `vitest run`.
 *
 * `test/base-url-targeting.test.ts` needs this because it has to observe what the
 * setup file does to `process.env.BASE_URL` in a FRESH process: the setup file runs
 * once per process, so an in-process assertion would read whatever the current
 * worker already resolved.
 *
 * This config exists so the fixtures directory can be excluded from the two suite
 * configs. Without the exclusion, the `test` glob in vitest.config.ts collects the
 * fixture and runs it as a real test — it would pass, but it would also make
 * `suite-integrity.test.ts` see a 45th file it cannot account for. With the
 * exclusion in place, the fixture is collectable only here.
 *
 * It deliberately includes nothing but the fixture, so running it can never
 * accidentally execute the unit suite a second time.
 */
const TARGET_URL_KEY = "TEST_TARGET_URL";
const operatorTarget =
	process.env[TARGET_URL_KEY] ??
	process.env.BASE_URL ??
	process.env.VITE_BASE_URL ??
	"https://example.com";

export default defineConfig({
	test: {
		include: ["test/fixtures/base-url-probe.test.ts"],
		exclude: [...configDefaults.exclude],
		setupFiles: ["./test/helpers/setup-env.ts"],
		environment: "node",
		env: { [TARGET_URL_KEY]: operatorTarget },
		fileParallelism: false,
		testTimeout: 15_000,
		hookTimeout: 15_000,
	},
});