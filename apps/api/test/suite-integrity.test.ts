import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { OFFLINE_DATABASE_URL } from "./helpers/setup-env";

/**
 * Guards the test suite's own integrity.
 *
 * FINDING THAT PROMPTED THIS FILE
 *
 * `test:unit` used to enumerate 30 test files by name in package.json. The
 * vitest config already globbed `test/**\/*.test.ts` and excluded the five
 * quarantined files, but passing filenames on the CLI OVERRIDES the include
 * glob — so the enumeration was the only thing deciding what ran. A canary file
 * added to `test/` was silently ignored: 30 files / 248 tests, unchanged.
 *
 * That is the same failure mode as the rest of this session's findings — a
 * declaration (a list of names) drifting from reality (the files on disk) with
 * nothing to notice. This file makes that drift loud.
 *
 * It also asserts that the version bump is hook-driven rather than CI-driven, and
 * that every workspace manifest agrees on the version. Both used to be the other
 * way round: `.semrel/prepare.mjs` was the only writer and it touched the root
 * manifest alone, so `apps/api` and `apps/web` sat on 1.2.9 through the whole
 * 1.12.x line. That drift was invisible because the test that existed only
 * checked that the hook FILES were present — it never checked what they wrote.
 */

const testDir = fileURLToPath(new URL(".", import.meta.url));
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const pkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8")) as {
	scripts: Record<string, string>;
};

/** Files vitest collects for a config, via that config's own include/exclude. */
const collectedFor = (configName: string): string[] => {
	const out = execFileSync("npx", ["vitest", "list", "--config", configName, "--filesOnly"], {
		cwd: apiRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".test.ts"))
		.map((line) => `./${line.replace(/^\.\//, "")}`)
		.sort();
};

test("test:unit runs every test file, not a hand-maintained list", () => {
	const script = pkg.scripts["test:unit"] ?? "";
	// A filename argument on the CLI replaces the config's include glob. Any
	// `.test.ts` token in the command is the bug this file exists to prevent.
	const fileArgs = script.split(/\s+/).filter((token) => token.endsWith(".test.ts"));
	expect(
		fileArgs,
		"test:unit must not enumerate test files by name — a new test file is silently never run. " +
			"Let the vitest config glob instead."
	).toEqual([]);
	expect(script).toContain("--config vitest.config.ts");
});

test("test:quarantine runs every quarantined file, not a hand-maintained list", () => {
	const script = pkg.scripts["test:quarantine"] ?? "";
	const fileArgs = script.split(/\s+/).filter((token) => token.endsWith(".test.ts"));
	expect(fileArgs, "test:quarantine must not enumerate test files by name.").toEqual([]);
	expect(script).toContain("--config vitest.quarantine.config.ts");
});

test("unit and quarantine suites partition the whole test directory", () => {
	const onDisk = readdirSync(testDir)
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => `./test/${name}`)
		.sort();

	const unit = collectedFor("vitest.config.ts");
	const quarantine = collectedFor("vitest.quarantine.config.ts");
	const covered = [...new Set([...unit, ...quarantine])].sort();

	// The property that matters: nothing on disk escapes both configs. Before the
	// fix, a file missing from the hardcoded list was collected by NEITHER suite.
	expect(covered).toEqual(onDisk);

	// And the two suites must not overlap, or a quarantined (live-network) file
	// would run on every PR.
	const overlap = unit.filter((file) => quarantine.includes(file));
	expect(overlap, "a file is in both the unit and quarantine suites").toEqual([]);
});

test("the quarantined suites are the live-network ones", () => {
	const quarantine = collectedFor("vitest.quarantine.config.ts");
	// These hit the live deployment or need real credentials. If one ever moves
	// into the unit suite, every PR would talk to production.
	for (const file of [
		"./test/production-e2e.test.ts",
		"./test/s3-sdk.test.ts",
		"./test/telegram.test.ts",
	]) {
		expect(quarantine, `${file} must stay quarantined`).toContain(file);
	}
});

test("the version bump is driven by a hook, not by CI", () => {
	// REPLACES the old "semantic-release hooks referenced by .releaserc.json
	// exist" test. That assertion guarded a release pipeline whose only version
	// writer touched the root manifest, which is how apps/api and apps/web ended
	// up frozen on 1.2.9 while the root reached 1.12.19.
	//
	// The invariant that replaces it is the one that was actually broken: the
	// bump script must exist, must be wired into a git hook, and must sweep every
	// workspace manifest. A test that only checked the file exists would have
	// passed on the old setup too.
	const bumpScript = readFileSync(join(repoRoot, "scripts/bump-version.mjs"), "utf8");
	const lefthook = readFileSync(join(repoRoot, "lefthook.yml"), "utf8");

	expect(
		lefthook,
		"lefthook.yml must run the bump on pre-push — a version decided in CI cannot be committed before the push"
	).toContain("scripts/bump-version.mjs");

	// `git ls-files` rather than a hardcoded list: that is what makes the sweep
	// cover apps/api and apps/web without naming them, so a third package added
	// later is bumped automatically instead of silently left behind.
	expect(
		bumpScript,
		"the bump must enumerate manifests via git ls-files, not a hardcoded list — a hardcoded list is how apps/api stayed on 1.2.9"
	).toContain('git(["ls-files"])');

	// The block-push flag is what makes the bump commit reach the remote at all.
	expect(
		lefthook,
		"pre-push must pass --block-push-after-bump, or the push in flight ships the OLD version"
	).toContain("--block-push-after-bump");

	// husky is gone; a leftover hook directory would run alongside lefthook.
	expect(
		existsSync(join(repoRoot, ".husky")),
		"the husky hook directory must be gone — lefthook owns .git/hooks now"
	).toBe(false);
	expect(
		existsSync(join(repoRoot, ".releaserc.json")),
		"semantic-release config must be gone — CI no longer decides the version"
	).toBe(false);
});

test("every workspace manifest carries the same version", () => {
	// The concrete regression: the root was at 1.12.19 while both workspace
	// packages were still at 1.2.9, because the old prepare hook only rewrote the
	// root. This reads the files rather than trusting the bump script, so a
	// hand-edit that desynchronises them fails here too.
	const readVersion = (relative: string): string =>
		(JSON.parse(readFileSync(join(repoRoot, relative), "utf8")) as { version: string }).version;

	const root = readVersion("package.json");
	for (const manifest of ["apps/api/package.json", "apps/web/package.json"]) {
		expect(readVersion(manifest), `${manifest} drifted from the root version`).toBe(root);
	}
});

test("the deploy workflow still triggers on push to main", () => {
	// UNCHANGED IN INTENT from the old combined test, now scoped to deploy.yml
	// alone: release.yml is tag-triggered on purpose (it publishes images for an
	// already-decided version), so asserting a `push: branches: [main]` block in
	// it would be asserting the pipeline that was just removed.
	//
	// The BLOCK form is the point. The freeze guard was `/^\s{2}push:\s*$/m`,
	// matching only `push:` alone on a line at 2-space indent — an inline
	// `push: branches: [main]` on one line would have matched neither the old
	// guard nor this one, letting the freeze be lifted while still asserting it
	// was in place.
	const file = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
	expect(file, "deploy.yml must trigger on push to main — the P5c unfreeze").toMatch(
		/^\s{2}push:\s*$/m
	);
	expect(file, "deploy.yml push trigger must be scoped to main").toMatch(
		/^\s{2}push:\n\s{4}branches: \[main\]$/m
	);
	// workflow_dispatch must ALSO survive: a manual redeploy is the only recovery
	// path when a release lands but the deploy job fails.
	expect(file, "deploy.yml must keep workflow_dispatch").toContain("workflow_dispatch");
});

test("the offline database placeholder can never name a real host", () => {
	const setupEnv = readFileSync(join(testDir, "helpers/setup-env.ts"), "utf8");
	const liveDb = readFileSync(join(testDir, "helpers/live-db.ts"), "utf8");

	// The DSN setup-env.ts installs when the environment supplies none.
	const assigns = setupEnv.match(/process\.env\.DATABASE_URL\s*\|\|=\s*([^;]+);/);
	expect(
		assigns,
		"setup-env.ts must still install a DATABASE_URL — src/env.ts throws at import without one"
	).not.toBeNull();
	const installed = (assigns?.[1] ?? "").trim();

	// From ONE exported definition, which live-db.ts also imports. Two literals
	// here is how the previous pair drifted apart.
	expect(installed, "the placeholder must come from OFFLINE_DATABASE_URL, not a literal").toBe(
		"OFFLINE_DATABASE_URL"
	);
	expect(setupEnv, "OFFLINE_DATABASE_URL must be exported for live-db.ts to import").toMatch(
		/export const OFFLINE_DATABASE_URL/
	);

	// Build the DSN the same way the code does — by IMPORTING it, not by
	// re-parsing the source. A regex reconstruction would have to know about the
	// `${'place'}holder` split, and would silently check a different string than
	// the one the suite actually installs.
	const dsn = OFFLINE_DATABASE_URL;

	// It has to be unresolvable, and unreachable-by-construction rather than by
	// accident. A private/loopback address satisfies the first; the loopback form
	// also fails INSTANTLY instead of hanging on a network that silently drops
	// the packets, which is what cost deploy.yml's lint job its 15s-per-test
	// timeouts (GitHub runners have no route into 100.64.0.0/10).
	const host = new URL(dsn).hostname;
	expect(
		["127.0.0.1", "localhost", "::1", "[::1]"],
		`the offline placeholder must be on loopback, but it points at ${host}`
	).toContain(host);

	// live-db.ts FAILS (rather than skips) when DATABASE_URL is set to something
	// unusable, so that a broken CI database can never read as a green skip. It
	// recognises the offline case by comparing against the exported constant, so
	// there is a single definition and nothing to drift.
	const usesSharedConstant = liveDb.includes("OFFLINE_DATABASE_URL");
	expect(
		usesSharedConstant,
		"live-db.ts must classify the offline placeholder via OFFLINE_DATABASE_URL, " +
			"not a duplicated literal or a host-only match — a host-only match swallows " +
			"a mistyped port and downgrades a broken database to a green skip"
	).toBe(true);

	// Prove the host-only mistake is still rejected, since that is the specific
	// regression this guards: 127.0.0.1 with the WRONG port is a real intent, and
	// matching on the host would classify it as "unconfigured". The classification
	// must be an equality against the one exported DSN, never a host test.
	const liveDbCode = liveDb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
	expect(
		liveDbCode,
		"live-db.ts must compare the whole DSN, not its host — a host-only match turns " +
			"a mistyped port into a silent skip"
	).toMatch(/url\s*!==\s*OFFLINE_DATABASE_URL/);
	expect(
		liveDbCode,
		'live-db.ts must not branch on the loopback host to decide "unconfigured"'
	).not.toMatch(/hostname[\s\S]{0,40}OFFLINE|startsWith\('127|includes\('127/);

	// And neither file may reintroduce a routable address in CODE. Comments are
	// stripped first, and deliberately so: these files explain the failure by
	// quoting the address that caused it, so a naive whole-file scan fails on the
	// very prose documenting the fix.
	const codeOnly = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

	for (const [name, source] of [
		["setup-env.ts", setupEnv],
		["live-db.ts", liveDb],
	] as const) {
		expect(codeOnly(source), `${name} must not hardcode a routable address`).not.toMatch(
			/\b(?:10|172|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
		);
	}

	// The same reasoning applies to the loopback assertion above: a DSN mentioning
	// a private address inside a comment is documentation, not configuration.
	expect(codeOnly(setupEnv)).toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
});
