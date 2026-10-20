import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` must document every variable the service actually reads.
 *
 * ## Why this guard exists
 *
 * `.env.example` is the only place an operator learns what a variable does. It had
 * drifted to 8 undocumented variables behind `env.ts` (`BATCH_MAX_ITEMS`,
 * `BATCH_MAX_SIZE_BYTES`, `MAX_REQUEST_BODY_BYTES`, `TELEGRAM_BOT_CONCURRENCY`,
 * `PROXY_S3_GET`, `ADDITIONAL_BOT_TOKENS`, `BOOTSTRAP_ADMIN_ID`). Nothing fails when
 * a variable is undocumented: the code reads it, the operator never sets it, and
 * the default silently applies. That is the failure mode this asserts against.
 *
 * ## The "NOT YET IMPLEMENTED" block is GONE, and that is deliberate
 *
 * This file used to require a block declaring `REDIS_URL` / `BETTER_AUTH_SECRET` /
 * `BETTER_AUTH_URL` as documented-but-inert, because TODO item 6 planned
 * better-auth + Redis and the variables were listed so the gap was visible.
 *
 * Multi-user auth shipped WITHOUT that stack: sessions are Postgres rows and the
 * OAuth state ledger is a second small table, so there is nothing for a Redis URL or
 * a better-auth secret to configure. Keeping the block would have been the exact
 * defect this suite exists to catch — a declaration that reads as live
 * configuration while nothing reads it.
 *
 * The tripwire that fired when the block was removed is therefore replaced by its
 * successor: these variables must NOT reappear anywhere in the file, and the
 * session model must be documented as Postgres-backed instead.
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

const documented = new Set(
	[...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z_0-9]{2,})\s*=/gm)].map((m) => m[1])
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

	it("documents the Google sign-in variables, since that is how people log in", () => {
		// Without these the dashboard has no interactive login at all, so their
		// absence from the operator-facing file would be a silent lockout.
		for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) {
			expect(documented.has(name)).toBe(true);
			expect(readVariables.has(name)).toBe(true);
		}
	});

	it("does NOT document the abandoned better-auth/Redis stack as live config", () => {
		// TODO item 6 planned better-auth + Redis; what shipped is Postgres-backed
		// sessions. These names must not reappear as settable entries, because an
		// operator who sets them would be configuring nothing.
		const code = stripComments(envExample);
		expect(code).not.toMatch(/^REDIS_URL=/m);
		expect(code).not.toMatch(/^BETTER_AUTH_/m);
	});

	it("states that sessions are Postgres-backed rather than cache-backed", () => {
		// The comment block that replaced the "NOT YET IMPLEMENTED" one has to say
		// what the session store actually IS, or the next reader will re-add Redis.
		expect(envExample).toContain("Sessions are stored in Postgres");
	});

	it("marks ADMIN_API_TOKEN as a machine credential, not a login form field", () => {
		// It is still a Bearer token for scripts; it is no longer how a human signs in.
		// Conflating the two is how the single-tenant session shipped in the first place.
		expect(envExample).toContain("NO LONGER a login form field");
	});
});
