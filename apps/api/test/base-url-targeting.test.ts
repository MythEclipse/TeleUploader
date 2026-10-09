import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The BASE_URL an operator supplies must survive into the test process.
 *
 * FINDING: the five quarantined suites were untargetable.
 *
 * `s3-sdk.test.ts` and `production-e2e.test.ts` read `process.env.BASE_URL` at
 * module scope to choose which deployment they attack. setup-env.ts tries to be a
 * good citizen about a non-URL value (vite's `base`, i.e. "/"), but vite has
 * ALREADY overwritten `process.env.BASE_URL` by the time the setup file runs, so a
 * real target exported by the operator is discarded before that check ever sees
 * it. A `||=`-style guard cannot help here: the value it inspects is no longer the
 * one the operator set.
 *
 * Proven, not inferred. With `BASE_URL=https://upload.asepharyana.my.id` exported,
 * a probe inside setup-env.ts observed
 *
 *     [probe] inside setup-env, BASE_URL = "/"
 *
 * and the suite then announced its own target:
 *
 *     i  S3 SDK E2E - https://example.com  bucket: e2e-s3sdk-mv0vglhl
 *
 * so 20 of 22 S3 SDK tests failed against example.com while production was serving
 * perfectly (the same AWS SDK call, same credentials, run outside vitest, returned
 * `ListBuckets OK: [ 'gitea' ]`). That is worse than no coverage: it reads as an S3
 * regression when nothing is broken, which teaches you to distrust a surface you
 * have not touched.
 *
 * WHY A SPAWNED PROCESS
 *
 * The setup file runs once per vitest process, so an in-process assertion would read
 * whatever the current worker already resolved and could pass against the broken
 * version by accident. Each case here gets its own real `vitest run`, which is the
 * only way to observe what an operator's shell environment actually produces.
 */
const apiRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs the fixture in a fresh vitest process; returns the BASE_URL it observed. */
const resolvedBaseUrl = (supplied: "set" | "unset", value?: string): string => {
	const outFile = join(mkdtempSync(join(tmpdir(), "base-url-probe-")), "value.txt");
	// Start from a CLEAN slate: the three variables under test are stripped, then
	// only the one this case supplies is put back. Inheriting the developer's own
	// BASE_URL would let a case pass for the wrong reason — which is exactly what
	// happened while developing this file (the "unset" case saw the outer shell's
	// value and reported a real URL).
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => k !== "BASE_URL" && k !== "VITE_BASE_URL" && k !== "TEST_TARGET_URL"
		)
	) as Record<string, string>;
	env.BASE_URL_PROBE_OUT = outFile;
	if (supplied === "set" && value !== undefined) env.BASE_URL = value;

	execFileSync(
		"npx",
		[
			"vitest",
			"run",
			"--config",
			"vitest.fixture.config.ts",
			"test/fixtures/base-url-probe.test.ts",
		],
		{ cwd: apiRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }
	);
	return readFileSync(outFile, "utf8").trim();
};

describe("BASE_URL reaches the test process", () => {
	it("preserves a real target the operator exported", () => {
		const target = "https://upload.asepharyana.my.id";
		expect(
			resolvedBaseUrl("set", target),
			"setup-env.ts replaced a valid BASE_URL, so the quarantined suites would " +
				"attack example.com instead of the chosen deployment"
		).toBe(target);
	});

	it("falls back to example.com when vite leaves a bare slash", () => {
		// "/" is what vite actually puts there, and the case the original guard was
		// written for. It must keep working.
		expect(resolvedBaseUrl("set", "/")).toBe("https://example.com");
	});

	it("falls back to example.com when BASE_URL is unset entirely", () => {
		expect(resolvedBaseUrl("unset")).toBe("https://example.com");
	});
});
