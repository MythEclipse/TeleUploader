import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` must document every variable the service actually reads.
 *
 * WHY THIS GUARD
 *
 * `.env.example` is the only place an operator learns what a variable does. It
 * had drifted to 8 unread variables behind `env.ts` — `BATCH_MAX_ITEMS`,
 * `BATCH_MAX_SIZE_BYTES`, `MAX_REQUEST_BODY_BYTES`, `TELEGRAM_BOT_CONCURRENCY`,
 * `PROXY_S3_GET`, `ADDITIONAL_BOT_TOKENS` and `BOOTSTRAP_ADMIN_ID`. Nothing fails
 * when a variable is undocumented: the code reads it, the operator never sets it,
 * and the default silently applies. That is the failure mode this asserts against.
 *
 * `BOOTSTRAP_ADMIN_ID` is the one that mattered — `env.ts` reads it,
 * `resolveAdminOrganizationId()` depends on it, and it is set nowhere in the
 * repository, so it is now documented as a known gap rather than left invisible.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

const envExample = read(".env.example");
const envModule = read("apps/api/src/env.ts");

/** Strip comments so a variable named in prose is not counted as documented. */
const stripComments = (source: string): string =>
	source
		.split("\n")
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");

/**
 * Split the "NOT YET IMPLEMENTED" block off before scanning for live entries.
 *
 * It documents `REDIS_URL` / `BETTER_AUTH_*` on purpose, as a visible gap. Those
 * must not count as live configuration, and they must not count as stale either —
 * so the block is removed from both sides of the comparison rather than special-
 * cased in each assertion.
 */
const pendingBlock = /# -{10,}\n# NOT YET IMPLEMENTED[\s\S]*?(?=\n[^\s#]|\n*$)/;
const liveEnvExample = envExample.replace(pendingBlock, "");
if (liveEnvExample === envExample) {
	throw new Error(
		".env.example lost its NOT YET IMPLEMENTED block; the split below would silently start counting REDIS_URL and BETTER_AUTH_* as live configuration"
	);
}

const documented = new Set(
	[...liveEnvExample.matchAll(/^\s*#?\s*([A-Z][A-Z_0-9]{2,})\s*=/gm)].map((m) => m[1])
);
const readVariables = new Set(
	[...envModule.matchAll(/process\.env\.([A-Z][A-Z_0-9]+)/g)].map((m) => m[1])
);

describe(".env.example vs apps/api/src/env.ts", () => {
	it("reads more than zero variables, so the comparison is not vacuous", () => {
		expect(readVariables.size).toBeGreaterThan(15);
	});

	it("documents every variable env.ts reads", () => {
		const missing = [...readVariables].filter((name) => !documented.has(name)).sort();
		expect(missing).toEqual([]);
	});

	it("does not document a variable env.ts never reads", () => {
		// A stale entry is worse than a missing one: it implies the variable works.
		const stale = [...documented].filter((name) => !readVariables.has(name)).sort();
		expect(stale).toEqual([]);
	});

	it("states plainly that REDIS_URL and BETTER_AUTH_* are not implemented yet", () => {
		// Item 6 owns these. If better-auth/Redis ever lands, this assertion is the
		// reminder to delete the "NOT YET IMPLEMENTED" block rather than leave a lie.
		const code = stripComments(envExample);
		expect(code).not.toMatch(/^REDIS_URL=/m);
		expect(code).not.toMatch(/^BETTER_AUTH_/m);
		expect(envExample).toContain("NOT YET IMPLEMENTED");
	});
});
