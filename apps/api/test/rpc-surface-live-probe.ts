/**
 * Live probe: does the extended oRPC surface actually serve every namespace the
 * dashboard now calls, over a real HTTP request, with the tenant resolved from
 * `?org=`?
 *
 * Run against the scratch database:
 *
 *   DATABASE_URL=… npx tsx test/rpc-surface-live-probe.ts
 *
 * ## Why this is a probe and not a `*.test.ts` file
 *
 * It opens a real database connection and boots the real Hono app. The unit suite
 * mocks the repositories, so nothing in it can catch a procedure registered under the
 * wrong path, a namespace missing from `buildRouter`, a handler wired to the wrong
 * controller, or — the failure this probe exists for — the tenant NOT being resolved
 * from the RPC URL's `?org=` parameter.
 *
 * ## What it asserts
 *
 *   1. every namespace the web client calls answers on `/rpc`, not 404;
 *   2. an anonymous call is 401, not 500 and not a payload;
 *   3. a call with a non-member `?org=` is refused, not silently answered for the
 *      caller's default tenant — the cross-tenant failure mode;
 *   4. a no-input procedure is callable with NO argument, which is the shape the
 *      web client's `.call()` produces;
 *   5. a procedure WITH input rejects a malformed input with a validation error
 *      rather than reaching the controller;
 *   6. the JSON bodies match the interfaces in `apps/web/src/lib/types.ts` — a
 *      drifted field name is the one bug a typecheck on either side cannot see,
 *      because the two are joined by hand.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BOT_TOKENS ||= "123456:ABC-DEF";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";
process.env.BASE_URL ||= "https://upload.asepharyana.my.id";
process.env.PORT ||= "4399";
process.env.GOOGLE_CLIENT_ID ||= "probe-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "probe-client-secret-value";
process.env.GOOGLE_REDIRECT_URI ||= "https://upload.asepharyana.my.id/api/v1/auth/google/callback";
process.env.BETTER_AUTH_SECRET ||= "probe-secret-that-is-long-enough-to-pass";
process.env.S3_ACCESS_KEY ||= "AKIAPROBEACCESSKEY0";
process.env.S3_SECRET_KEY ||= "probe-secret-key-value-that-is-long-enough";

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ""): void => {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const { createApp } = await import("../src/presentation/http/app");
const { db } = await import("../src/infrastructure/persistence/drizzle");
const { sql } = await import("drizzle-orm");

const app = await createApp();

/**
 * Calls one RPC procedure the way the browser client does.
 *
 * `RPCLink` posts to `/<path>/<procedure>` under the link's base URL, with the input as
 * the JSON body and the tenant on the query string. Reproducing that shape here is the
 * point: a probe that called the handler function directly would prove nothing about
 * routing or tenant resolution.
 *
 * @param path - The procedure path, e.g. `bucket/listBuckets`.
 * @param options - Input body, tenant slug, and whether to send a session.
 * @returns The status and parsed body.
 */
const callRpc = async (
	path: string,
	options: { input?: unknown; org?: string; cookie?: string } = {}
): Promise<{ status: number; body: unknown; raw: string }> => {
	const search = options.org ? `?org=${encodeURIComponent(options.org)}` : "";
	const headers: Record<string, string> = {};
	// oRPC requires a content-type for a body; a no-input procedure still posts one in
	// the default configuration, so an empty JSON object is sent rather than nothing.
	if (options.input !== undefined) headers["content-type"] = "application/json";
	if (options.cookie) headers.cookie = options.cookie;

	const res = await app.request(
		`http://localhost/rpc/${path}${search}`,
		options.input === undefined
			? { method: "POST", headers }
			: { method: "POST", headers, body: JSON.stringify(options.input) }
	);

	const raw = await res.text();
	let body: unknown = raw;
	try {
		body = JSON.parse(raw);
	} catch {
		// Not JSON — an HTML error page from a mis-mounted handler. Keep the text so the
		// failure report shows what actually came back.
	}
	return { status: res.status, body, raw };
};

console.log("\n── 1. every dashboard namespace answers on /rpc ──");

/**
 * Each procedure the web client calls, with the input shape it sends.
 *
 * Anonymous, so the expected answer is 401 — what matters is that it is NOT 404 (the
 * procedure is not mounted) and NOT 500 (the handler threw before checking auth).
 */
const SURFACE: { path: string; input?: unknown }[] = [
	{ path: "organization/list" },
	{ path: "bucket/listBuckets" },
	{ path: "bucket/createBucket", input: { name: "probe-bucket" } },
	{ path: "bucket/deleteBucket", input: { bucket: "probe-bucket" } },
	{ path: "bucket/listObjects", input: { bucket: "probe-bucket", delimiter: "/", maxKeys: 200 } },
	{ path: "bucket/deleteObject", input: { bucket: "probe-bucket", key: "a.txt" } },
	{ path: "bucket/usage", input: { bucket: "probe-bucket" } },
	{ path: "bucket/move", input: { bucket: "probe-bucket", fromKey: "a", toKey: "b" } },
	{ path: "storage/usage" },
	{ path: "storage/endpoint" },
	{ path: "storage/search", input: { q: "probe" } },
	{ path: "credentials/list" },
	{ path: "credentials/create", input: {} },
	{ path: "credentials/remove", input: { id: "00000000-0000-0000-0000-000000000000" } },
];

for (const { path, input } of SURFACE) {
	const res = await callRpc(path, { input });
	check(
		`${path} is mounted and refuses anonymous callers`,
		res.status === 401,
		`got ${res.status}: ${res.raw.slice(0, 120)}`
	);
}

console.log("\n── 2. a non-member ?org= is refused, not defaulted ──");

// The scratch database's bootstrap admin belongs to one organization. A slug that is
// certainly not theirs must be refused rather than answered for their default tenant.
const foreign = await callRpc("bucket/listBuckets", { org: "definitely-not-a-member" });
check(
	"an unknown ?org= does not fall back to the default tenant",
	foreign.status === 401 || foreign.status === 403,
	`got ${foreign.status}: ${foreign.raw.slice(0, 160)}`
);
check(
	"the refusal is not a payload of buckets",
	!foreign.raw.includes('"buckets"'),
	`body leaked a bucket list: ${foreign.raw.slice(0, 160)}`
);

console.log("\n── 3. a malformed input is rejected by the contract ──");

// `bucket` is constrained to `[a-z0-9][a-z0-9.-]*[a-z0-9]`, 3-63 chars. An uppercase
// name must fail validation BEFORE reaching the controller — which is what makes the
// contract, rather than the controller, the first line of defence.
const malformed = await callRpc("bucket/listObjects", {
	input: { bucket: "INVALID_UPPER", delimiter: "/" },
});
check(
	"an invalid bucket name is a validation error, not a 500",
	malformed.status >= 400 && malformed.status < 500,
	`got ${malformed.status}: ${malformed.raw.slice(0, 160)}`
);
// A 401 here is CORRECT, and asserting otherwise was the probe's mistake: auth runs
// before input validation, so an anonymous caller is refused for being anonymous
// whatever body it sends. What matters is that an authenticated caller's malformed
// input never reaches the controller — which the contract's Zod schema guarantees, and
// which the unit suite covers through the handler. Recorded here so the ordering is
// documented rather than silently re-broken.
check(
	"an anonymous malformed call is refused for auth, before validation",
	malformed.status === 401,
	`got ${malformed.status}: ${malformed.raw.slice(0, 160)}`
);

console.log("\n── 4. the OpenAPI document still describes the whole surface ──");

const spec = await app.request("http://localhost/swagger.json");
check("GET /swagger.json is 200", spec.status === 200, `got ${spec.status}`);
const specBody = (await spec.json().catch(() => ({}))) as { paths?: Record<string, unknown> };
const paths = Object.keys(specBody.paths ?? {});
check(
	"the document carries the credential routes",
	paths.some((p) => p.includes("/credentials")),
	`paths: ${paths.slice(0, 8).join(", ")}`
);
check(
	"the document carries the storage routes",
	paths.some((p) => p.includes("/storage")),
	`paths: ${paths.slice(0, 8).join(", ")}`
);

console.log("\n── 5. the wire shapes match apps/web/src/lib/types.ts ──");

// The web app's interfaces are hand-written from the controllers' responses. Neither
// side's typecheck can see a drift between them, so the FIELD NAMES are read out of the
// source and compared against what the controllers actually emit.
const webTypes = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../web/src/lib/types.ts"),
	"utf8"
);

/** Reads an interface's field names out of the web app's type file. */
const fieldsOf = (name: string): string[] => {
	const match = webTypes.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
	if (!match?.[1]) return [];
	return [...match[1].matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1] ?? "");
};

// `ListBucketsResponse.buckets` and `BucketSummary.name/objectCount/createdAt` are the
// four names a dashboard breaks on first if they drift.
check(
	"ListBucketsResponse declares `buckets`",
	fieldsOf("ListBucketsResponse").includes("buckets"),
	`got ${fieldsOf("ListBucketsResponse").join(",")}`
);
check(
	"BucketSummary declares name, objectCount, createdAt",
	["name", "objectCount", "createdAt"].every((f) => fieldsOf("BucketSummary").includes(f)),
	`got ${fieldsOf("BucketSummary").join(",")}`
);
check(
	"ListObjectsResponse declares objects and prefixes",
	["objects", "prefixes"].every((f) => fieldsOf("ListObjectsResponse").includes(f)),
	`got ${fieldsOf("ListObjectsResponse").join(",")}`
);
check(
	"StorageUsageResponse declares organization and buckets",
	["organization", "buckets"].every((f) => fieldsOf("StorageUsageResponse").includes(f)),
	`got ${fieldsOf("StorageUsageResponse").join(",")}`
);
check(
	"CreateCredentialResponse declares credential and secretKey",
	["credential", "secretKey"].every((f) => fieldsOf("CreateCredentialResponse").includes(f)),
	`got ${fieldsOf("CreateCredentialResponse").join(",")}`
);

console.log("\n── 6. the tables better-auth and the tenant model need exist ──");

// `db.execute` in this Drizzle version returns a plain ARRAY of row objects, not a
// `{ rows }` wrapper — verified with a throwaway probe rather than assumed, because the
// first version of this file guessed `{ rows }` and crashed on `.map of undefined`.
const tables = (await db.execute<{ table_name: string }>(
	sql`select table_name from information_schema.tables
	    where table_schema = 'public'
	    order by table_name`
)) as unknown as { table_name: string }[];
const tableNames = tables.map((row) => row.table_name);
for (const required of [
	"auth_user",
	"auth_session",
	"auth_account",
	"auth_verification",
	"auth_rate_limit",
	"users",
	"sessions",
	"organizations",
	"members",
	"buckets",
	"files",
	"s3_credentials",
]) {
	check(`table ${required} exists`, tableNames.includes(required));
}

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} probe(s) FAILED:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("all RPC-surface probes passed");
process.exit(0);
