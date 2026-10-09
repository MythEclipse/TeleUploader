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
 * It also asserts that the `.semrel/*.mjs` hooks referenced by `.releaserc.json`
 * exist. `dispatch.mjs` is what triggers the deploy after a release. They were
 * deleted by commit d2839ab, a commit about an unrelated topic, which would
 * have silently disabled the release→deploy path in P5c. A missing file there
 * fails semantic-release at release time, i.e. in production, not in CI.
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

test("the semantic-release hooks referenced by .releaserc.json exist", () => {
	const releaserc = readFileSync(join(repoRoot, ".releaserc.json"), "utf8");

	// Extract the ./.semrel/*.mjs paths the config actually invokes, rather than
	// hardcoding the list — so a new hook is covered the day it is added.
	const referenced = [...releaserc.matchAll(/\.\/\.semrel\/[\w.-]+\.mjs/g)].map((m) => m[0]);

	expect(
		referenced.length,
		"expected .releaserc.json to reference at least one ./.semrel hook"
	).toBeGreaterThan(0);

	for (const relative of [...new Set(referenced)]) {
		expect(
			existsSync(join(repoRoot, relative)),
			`${relative} is executed by .releaserc.json but does not exist. semantic-release runs ` +
				"these on a release, so a missing file breaks the release→deploy path in production, not in CI."
		).toBe(true);
	}
});

test("the deploy and release workflows are UNFROZEN (P5c)", () => {
	// P0–P5b froze these; P5c lifted the freeze, so a merge to main deploys again. This
	// assertion is INVERTED rather than deleted, so a silent re-freeze fails here too.
	// It deliberately duplicates deploy-config.test.ts: if that file is deleted, the
	// trigger guard survives in a suite the glob cannot skip.
	//
	// The BLOCK form is the point. The freeze guard was `/^\s{2}push:\s*$/m`, matching only
	// `push:` alone on a line at 2-space indent — an inline `push: branches: [main]` on
	// one line would have matched neither the old guard nor this one, letting the freeze
	// be lifted while still asserting it was in place.
	for (const wf of ["deploy.yml", "release.yml"]) {
		const file = readFileSync(join(repoRoot, ".github/workflows", wf), "utf8");
		expect(file, `${wf} must trigger on push to main — the P5c unfreeze`).toMatch(
			/^\s{2}push:\s*$/m
		);
		// Scoped to main, not every branch.
		expect(file, `${wf} push trigger must be scoped to main`).toMatch(
			/^\s{2}push:\n\s{4}branches: \[main\]$/m
		);
		// workflow_dispatch must ALSO survive: .semrel/dispatch.mjs POSTs to the deploy
		// dispatch endpoint, so dropping it breaks the release→deploy path in production.
		expect(file, `${wf} must keep workflow_dispatch for .semrel/dispatch.mjs`).toContain(
			"workflow_dispatch"
		);
	}
});

test("mirror-gitea.yml mirrors by explicit refspec, never --mirror (TODO item 5)", () => {
	// `git push --mirror` deletes every ref the checkout lacks, and actions/checkout
	// fetches only refs/heads/*. Verified against a scratch remote, not assumed:
	//
	//   GITEA before: refs/heads/main, refs/heads/feature-x, refs/notes/…, refs/pull/1/head, refs/tags/v1.0.0
	//   RUNNER has:   refs/remotes/origin/main, refs/remotes/origin/feature-x, refs/tags/v1.0.0
	//   $ git push --dry-run --mirror origin
	//      - [deleted]  feature-x
	//      - [deleted]  main                  <-- the branch it exists to mirror
	//      - [deleted]  refs/notes/semantic-release-1.2.9
	//      - [deleted]  refs/pull/1/head
	//
	// `[deleted] main` is the one that is easy to miss: the runner's copy lives under
	// refs/remotes/origin/*, a DIFFERENT namespace from the remote's refs/heads/*, so
	// --mirror had nothing to push there and deleted it instead.
	//
	// This test used to ASSERT the hazard was still present (`toContain('git push
	// --mirror')`), because fixing it was a human decision. The decision is made:
	// the refspecs below are what ships, so the assertions flip. A future edit that
	// restores --mirror now fails here instead of quietly re-arming the deletion.
	const file = readFileSync(join(repoRoot, ".github/workflows/mirror-gitea.yml"), "utf8");

	expect(file, "mirror-gitea.yml must trigger on push to main — the P5c unfreeze").toMatch(
		/^\s{2}push:\s*$/m
	);
	expect(file, "mirror-gitea.yml must keep workflow_dispatch").toContain("workflow_dispatch");

	// THE ASSERTION THAT MATTERS: --mirror must not appear in the PUSH COMMAND.
	// Matching is anchored to a shell invocation — an optional `git`, then `push`,
	// then flags — so the file's own prose about why --mirror is gone (which
	// necessarily contains the token, including a quoted `$ git push --dry-run
	// --mirror origin` transcript) cannot satisfy or break this.
	const pushCommand = /^\s*(?:\$?\s*)?git\s+push\b[^\n]*$/gm;
	const commands = file.match(pushCommand) ?? [];
	for (const command of commands) {
		expect(command, "the push must not use --mirror").not.toContain("--mirror");
	}
	// At least one push must exist, or the loop above is vacuously green.
	expect(commands.length, "the mirror must actually push something").toBeGreaterThan(0);

	// Branches and tags are mirrored explicitly and exhaustively; anything not named
	// (refs/pull/*, refs/notes/*) is therefore left alone.
	expect(file, "must mirror branches").toContain("refs/heads/*:refs/heads/*");
	expect(file, "must mirror tags").toContain("refs/tags/*:refs/tags/*");

	// `--force` would defeat the fast-forward check: it force-overwrites a main that
	// was pushed to Gitea directly. `--force-if-includes` refuses unless the remote's
	// ref is an ancestor of what we push, so a rewritten remote branch is rejected
	// rather than clobbered. Verified: it rejects a divergent main exactly as the
	// no-force case does.
	for (const command of commands) {
		expect(command, "a bare --force would clobber a branch pushed to Gitea directly").not.toMatch(
			/(?:^|\s)--force(?:\s|$)/
		);
	}
	expect(file, "must guard the mirror with --force-if-includes").toMatch(
		/git\s+push[^\n]*--force-if-includes/
	);

	// The reasoning stays in the file so the next person does not "simplify" it back.
	expect(file, "must document the deleted refs").toMatch(/refs\/pull/);
	expect(file, "must document the deleted refs").toMatch(/refs\/notes/);
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
