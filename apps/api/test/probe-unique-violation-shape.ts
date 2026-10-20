/**
 * Probe: does a Postgres unique violation reach our catch blocks as `error.code`?
 *
 * `ensurePersonalOrganization` relies on catching `23505` to distinguish "someone else
 * created this workspace first" (expected, recover) from a real fault (propagate). It
 * reads `(error as { code?: string }).code`.
 *
 * If Drizzle wraps the driver error, that property is `undefined` and EVERY unique
 * violation looks like a hard failure — the recovery path becomes dead code, and a
 * concurrent sign-in throws instead of returning the workspace that already exists.
 *
 * This prints the real shape rather than assuming it.
 */

process.env.BOT_TOKENS ||= "";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";

const { db } = await import("../src/infrastructure/persistence/drizzle/index");
const { sql } = await import("drizzle-orm");

const tag = `probe-dup-${Date.now().toString(36)}`;

// First insert succeeds; the second violates the UNIQUE index on organizations.name.
await db.execute(sql`INSERT INTO organizations (name, slug) VALUES (${tag}, ${`${tag}-a`})`);

try {
	await db.execute(sql`INSERT INTO organizations (name, slug) VALUES (${tag}, ${`${tag}-b`})`);
	console.log("UNEXPECTED: duplicate insert succeeded");
} catch (error: unknown) {
	const asRecord = error as { code?: unknown; cause?: { code?: unknown }; name?: unknown };
	console.log("PROBE constructor:", (error as object)?.constructor?.name);
	console.log("PROBE error.code:", String(asRecord.code));
	console.log("PROBE error.cause.code:", String(asRecord.cause?.code));
	console.log("PROBE error.name:", String(asRecord.name));
	console.log("PROBE code-visible-at-top-level:", String(asRecord.code === "23505"));
}

// Cleanup so re-runs start clean.
await db.execute(sql`DELETE FROM organizations WHERE name = ${tag}`);
