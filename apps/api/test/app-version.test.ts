import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The version `/health` reports must be a property of the BUILD, not of whatever
 * `package.json` happens to sit next to the bundle on the host.
 *
 * THE BUG THIS PINS
 *
 * `env.ts` read `package.json` at runtime, resolving
 * `/opt/teleuploader/dist/../package.json` on the VPS. `deploy.sh` never shipped
 * that file, so it stayed as a leftover from an old manual install declaring
 * `1.0.0`. Production therefore answered
 * `{"status":"ok","version":"1.0.0"}` through every release up to 1.16.1 — and
 * nothing noticed, because the deploy's health probe only asserted HTTP 200 and
 * never looked at the version it printed.
 *
 * A unit test of `readPackageVersion` would have passed the whole time: the
 * function worked correctly, it was reading a file the deploy did not own. What
 * was missing was a guarantee that the deployed artefact CARRIES the version,
 * so that is what is asserted here.
 */

const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const apiPkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8")) as {
	version: string;
	scripts: Record<string, string>;
};

describe("the version is baked into the bundle", () => {
	it("env.ts reads the build-time constant before falling back to a file", () => {
		// The ordering is the fix. If the file lookup ever runs first again, the
		// deployed version goes back to depending on a file the deploy does not
		// control.
		const env = readFileSync(join(apiRoot, "src/env.ts"), "utf8");
		expect(env).toContain("declare const __APP_VERSION__");
		expect(env).toMatch(
			/typeof __APP_VERSION__ !== "undefined" \? __APP_VERSION__ : readPackageVersion\(\)/
		);
	});

	it("the build script passes the version to esbuild as a JS string literal", () => {
		// `--define:__APP_VERSION__=1.16.1` is a syntax error, and
		// `--define:__APP_VERSION__='"1.16.1"'` (the first attempt at this fix)
		// produces a value that INCLUDES the quote characters, so /health would
		// report `"1.16.1"` with visible quotes. JSON.stringify is what makes it
		// a correct string literal, so assert that rather than the exact flag.
		const build = readFileSync(join(apiRoot, "scripts/build.mjs"), "utf8");
		expect(build).toContain("--define:__APP_VERSION__=");
		expect(build).toContain("JSON.stringify(version)");
		// A hardcoded version in CODE would desync from the manifest. Comments are
		// stripped first because this file documents the bug by quoting the wrong
		// flag it produced — a naive whole-file scan fails on its own explanation.
		const code = build.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/"\d+\.\d+\.\d+"/);
	});

	it("the build script refuses to build without a version", () => {
		// A bundle with no version reports `0.0.0`, which looks like a real
		// answer. Failing the build is the only way this cannot ship silently.
		const build = readFileSync(join(apiRoot, "scripts/build.mjs"), "utf8");
		expect(build).toContain("process.exit(1)");
	});

	it("package.json's build script runs that builder", () => {
		// The wiring, not the mechanism: an inline `--define` chain in package.json
		// is where the quoting bug came from, so the script must be the entry point.
		expect(apiPkg.scripts.build).toBe("node scripts/build.mjs");
		expect(existsSync(join(apiRoot, "scripts/build.mjs"))).toBe(true);
	});

	it("a built bundle contains the version as a string, with no quotes inside it", () => {
		// Skipped when dist/ has not been built (a fresh clone, or `test:unit`
		// before `build`). The assertion is about the ARTEFACT, so there is
		// nothing honest to check without one.
		const bundlePath = join(apiRoot, "dist/index.js");
		if (!existsSync(bundlePath)) return;

		const bundle = readFileSync(bundlePath, "utf8");
		// esbuild substitutes the identifier, so the literal must appear and the
		// identifier must not survive as a reference.
		expect(bundle).toContain(`"${apiPkg.version}"`);
		// The quoting bug: the value would have been `'"1.16.1"'`.
		expect(bundle).not.toContain(`'"${apiPkg.version}"'`);
	});
});

describe("deploy.sh proves the running build is the one it just shipped", () => {
	const deploy = readFileSync(join(repoRoot, "deploy.sh"), "utf8");

	it("compares the reported version against the tree being deployed", () => {
		// Without this, a deploy that ships the wrong bundle reports success —
		// which is exactly how 1.0.0 survived sixteen releases.
		expect(deploy).toContain("EXPECTED_VERSION");
		expect(deploy).toContain("reported_version");
		expect(deploy).toMatch(
			/reported_version.*=.*EXPECTED_VERSION|"\$reported_version" = "\$EXPECTED_VERSION"/
		);
	});

	it("fails the deploy, rather than warning, on a version mismatch", () => {
		// A warning scrolls past in CI. The whole point is that this must be red.
		const versionProbe = deploy.slice(deploy.indexOf("version probe"));
		expect(versionProbe.slice(0, 2000)).toContain("boom");
	});

	it("passes the expected version to the remote shell", () => {
		// The remote script has no checkout — only the bundled artefact — so the
		// expected version has to travel as an argument. Computing it remotely
		// would read the very stale manifest this change exists to stop trusting.
		expect(deploy).toMatch(/EXPECTED_VERSION="\$\(node -p/);
		expect(deploy).toContain('"${EXPECTED_VERSION}"');
	});

	it("does not list files it never ships as deployment inputs", () => {
		// `package.json` and `pnpm-lock.yaml` sat in the --check list, asserting
		// "these ship" about two files that are never scp'd. That is how the
		// stale-manifest bug stayed invisible: the script said it deployed the
		// manifest, so nobody looked for the copy on the host.
		// Only the `for f in ...` line itself is checked. The surrounding prose
		// deliberately names the files that used to be listed, so scanning the
		// whole block would fail on its own explanation.
		const forLine = deploy
			.split("\n")
			.find((line) => line.includes("for f in apps/api/dist/index.js"));
		expect(forLine, "the --check file list must still exist").toBeDefined();
		expect(forLine).not.toContain("pnpm-lock.yaml");
		expect(forLine).not.toContain("package.json");
	});
});
