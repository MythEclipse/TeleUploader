#!/usr/bin/env node
/**
 * Builds the API bundle, baking the version in at build time.
 *
 * ## Why this is a script and not an inline `package.json` command
 *
 * The version has to reach esbuild as a JS STRING LITERAL:
 *
 *   --define:__APP_VERSION__='"1.16.1"'
 *
 * Getting there from a `package.json` script means surviving npm's own shell
 * quoting, then the shell's, then esbuild's. The first attempt at this produced
 * `'"1.16.1"'` — the single quotes became part of the value, so `/health` would
 * have reported `"1.16.1"` with visible quote marks. That is a silent wrong
 * answer, which is exactly the class of bug this whole change exists to remove,
 * so the quoting is done in JS where it is unambiguous instead of being nested
 * three levels deep in a JSON string.
 *
 * ## Why the version is baked in at all
 *
 * `env.ts` used to read `package.json` at runtime, resolving
 * `/opt/teleuploader/dist/../package.json` on the VPS — a file `deploy.sh` never
 * ships. A stale copy from an old manual install sat there declaring `1.0.0`, so
 * `/health` reported `1.0.0` through every release up to 1.16.1. Baking the
 * value in makes the reported version a property of the ARTEFACT, so it cannot
 * disagree with the code that is running.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The version to embed, read from this package's own manifest. */
const { version } = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8"));

if (typeof version !== "string" || version.length === 0) {
	console.error(
		"[build] package.json has no version — refusing to build a bundle that cannot report it"
	);
	process.exit(1);
}

// The banner re-creates `require` for CommonJS deps; see the file for why.
const banner = readFileSync(join(apiRoot, "scripts/esbuild-banner.js"), "utf8");

/** The three entry points, in build order. */
const entries = [
	["src/index.ts", "dist/index.js"],
	["src/infrastructure/persistence/drizzle/migrate.ts", "dist/migrate.js"],
	["src/infrastructure/db/seed.ts", "dist/seed.js"],
];

for (const [entry, outfile] of entries) {
	execFileSync(
		"npx",
		[
			"esbuild",
			entry,
			"--bundle",
			"--keep-names",
			"--platform=node",
			"--target=node22",
			"--format=esm",
			// JSON.stringify produces the quoted literal esbuild needs, so the
			// value is `"1.16.1"` (a string) and not `1.16.1` (a syntax error) or
			// `'"1.16.1"'` (a string containing quotes).
			`--define:__APP_VERSION__=${JSON.stringify(version)}`,
			`--banner:js=${banner}`,
			`--outfile=${outfile}`,
		],
		{ cwd: apiRoot, stdio: "inherit" }
	);
}
