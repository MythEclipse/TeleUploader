/**
 * Live probe: does an AUTHENTICATED caller actually get data back through the oRPC
 * surface — buckets, a listing, storage totals, a credential round trip, and a delete?
 *
 * Run against the scratch database:
 *
 *   DATABASE_URL=… npx tsx test/authenticated-surface-live-probe.ts
 *
 * ## Why an anonymisation-only probe is not enough
 *
 * `rpc-surface-live-probe.ts` proves every procedure is MOUNTED and refuses anonymous
 * callers. That is necessary and insufficient: a procedure can be mounted, return 200 for
 * a session, and still hand back `{}` because its handler reads a context field the
 * router never populated, or because it resolves the tenant to `undefined`. Every failure
 * of that kind looks identical to success in a browser.
 *
 * ## Why it drives the REAL client, not hand-built HTTP
 *
 * Earlier versions of this file hand-encoded the RPC wire format and were wrong in three
 * different ways, each of which produced a `FAIL` that was really a probe bug:
 *
 *   - procedures whose contract declares `method: "GET"` must be called with GET and
 *     query params; POSTing the input as a body answered `400 Input validation failed`
 *     because the handler read an empty query;
 *   - oRPC wraps a success payload as `{ "json": … }`, so a hand-parsed `body.objects`
 *     was always `undefined`;
 *   - the session cookie is named `tu_session` (`config.sessionCookieName`'s default),
 *     not `filedrop_session`.
 *
 * Rather than encode the protocol again, the probe imports `@orpc/client` and points
 * `RPCLink` at the Hono app's `request`. That is the same client the SPA uses, so the
 * probe exercises the real transport — correct method, correct encoding, correct result
 * unwrapping. A failure here is a server failure, not a probe artefact.
 *
 * ## Why it talks to the database directly for setup
 *
 * There is no way to complete a Google OAuth handshake in a probe. Minting the session row
 * directly is what the callback does after Google returns: insert a `sessions` row with
 * the SHA-256 of a token, hand the client the raw token. That exercises the real auth path
 * — `getAuthenticatedCaller` hashes what arrives and looks it up — without pretending to
 * be Google.
 *
 * Everything this probe writes is cleaned up, so re-running it is safe.
 */

import { createHash, randomBytes } from "node:crypto";

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
process.env.BOOTSTRAP_ADMIN_ID ||= "probe-admin";

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
const { createORPCClient } = await import("@orpc/client");
const { RPCLink } = await import("@orpc/client/fetch");

const app = await createApp();

// ── Fixture: one user, one org, one bucket, one live session ────────────────

const runId = randomBytes(4).toString("hex");
// `users.id` and `sessions.user_id` are UUIDs; `members.user_id` is TEXT. That mismatch is
// real in `schema.sql` — verified with `\d` — so the same uuid STRING goes into both, with
// a `::uuid` cast only on the uuid columns. That is what the application does too.
const userId = crypto.randomUUID();
const orgSlug = `probe-${runId}`;
const orgId = crypto.randomUUID();
const bucketId = crypto.randomUUID();
const bucketName = `probe-bkt-${runId}`;

/** The raw token the client sends. Only its hash is stored — the same contract as prod. */
const rawToken = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(rawToken).digest("hex");
const cookie = `tu_session=${rawToken}`;

/**
 * Deletes rows a previous interrupted run left behind.
 *
 * `organizations.name` is UNIQUE, so a stale `Probe Org` row turns the next run into a
 * duplicate-key failure before it can assert anything. Every filter here is scoped to the
 * probe's own prefixes so a real tenant is never touched. Order matters: dependants first,
 * or the foreign keys reject the delete.
 */
const purgeStaleProbeRows = async (): Promise<void> => {
	await db.execute(sql`
		delete from sessions where user_id in (select id from users where email like '%@probe.test')
	`);
	await db.execute(sql`
		delete from files where bucket_id in (
			select b.id from buckets b
			join organizations o on o.id = b.organization_id
			where o.slug like 'probe-%'
		)
	`);
	await db.execute(sql`
		delete from s3_credentials where organization_id in (
			select id from organizations where slug like 'probe-%'
		)
	`);
	await db.execute(sql`
		delete from buckets where organization_id in (
			select id from organizations where slug like 'probe-%'
		)
	`);
	await db.execute(sql`
		delete from members where organization_id in (
			select id from organizations where slug like 'probe-%'
		)
	`);
	await db.execute(sql`delete from organizations where slug like 'probe-%' or slug like 'other-%'`);
	await db.execute(sql`delete from users where email like '%@probe.test'`);
};

/**
 * Inserts the fixture rows.
 *
 * Column lists were read out of `information_schema.columns` rather than guessed: `files`
 * has ELEVEN not-null columns, five of them Telegram identifiers only the upload path can
 * supply, and two earlier versions of this probe failed on a column it had invented
 * (`organization_id`, which `files` does not have) or omitted.
 */
const setup = async (): Promise<void> => {
	await purgeStaleProbeRows();

	await db.execute(sql`
		insert into users (id, email, name, avatar_url, created_at)
		values (${userId}::uuid, ${`${runId}@probe.test`}, ${"Probe User"}, ${null}, now())
	`);
	await db.execute(sql`
		insert into organizations (id, slug, name, created_at)
		values (${orgId}::uuid, ${orgSlug}, ${`Probe Org ${runId}`}, now())
	`);
	await db.execute(sql`
		insert into members (organization_id, user_id, role, created_at)
		values (${orgId}::uuid, ${userId}, ${"owner"}, now())
	`);
	await db.execute(sql`
		insert into buckets (id, name, organization_id, created_at)
		values (${bucketId}::uuid, ${bucketName}, ${orgId}::uuid, now())
	`);
	await db.execute(sql`
		insert into files (id, s3_key, bucket_id, size_bytes, file_hash, public_id,
			telegram_file_id, telegram_file_unique_id, storage_chat_id, storage_message_id,
			file_name, mime_type, file_type, uploader_id, uploader_user_id, created_at)
		values
			(${crypto.randomUUID()}::uuid, ${"probe/one.txt"}, ${bucketId}::uuid, ${10},
			 ${"hash-one"}, ${`pub-one-${runId}`},
			 ${"tg-one"}, ${"tgu-one"}, ${-1001234567890}, ${0},
			 ${"one.txt"}, ${"text/plain"}, ${"document"}, ${0},
			 ${userId}::uuid, now()),
			(${crypto.randomUUID()}::uuid, ${"probe/two.txt"}, ${bucketId}::uuid, ${25},
			 ${"hash-two"}, ${`pub-two-${runId}`},
			 ${"tg-two"}, ${"tgu-two"}, ${-1001234567890}, ${0},
			 ${"two.txt"}, ${"text/plain"}, ${"document"}, ${0},
			 ${userId}::uuid, now())
	`);
	await db.execute(sql`
		insert into sessions (id, token_hash, user_id, expires_at, created_at)
		values (${crypto.randomUUID()}::uuid, ${tokenHash}, ${userId}::uuid,
		        now() + interval '1 hour', now())
	`);
};

/** Removes every row this probe created. */
const cleanup = async (): Promise<void> => {
	await purgeStaleProbeRows();
};

/**
 * The REAL oRPC client, pointed at the Hono app.
 *
 * `RPCLink`'s `fetch` receives a `Request`; routing it through `app.request` means the
 * probe goes through the actual Hono middleware chain — auth, tenant resolution, the RPC
 * handler — with no network listener. The cookie is injected here because a server-side
 * client has no cookie jar.
 */
const client = createORPCClient(
	new RPCLink({
		url: `http://localhost/rpc?org=${encodeURIComponent(orgSlug)}`,
		fetch: async (request: Request) => {
			const headers = new Headers(request.headers);
			headers.set("cookie", cookie);
			return app.request(new Request(request, { headers }));
		},
	})
) as Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;

/**
 * Calls one procedure through the real client.
 *
 * @param namespace - e.g. `bucket`.
 * @param procedure - e.g. `listBuckets`.
 * @param input - The procedure's input, or `undefined` for a no-input procedure.
 * @returns The unwrapped result.
 */
const call = async (namespace: string, procedure: string, input?: unknown): Promise<unknown> => {
	const group = client[namespace];
	if (!group) throw new Error(`no namespace ${namespace}`);
	const fn = group[procedure];
	if (!fn) throw new Error(`no procedure ${namespace}/${procedure}`);
	return input === undefined ? await fn() : await fn(input);
};

/** Calls a procedure and reports whether it threw, so an expected failure is assertable. */
const attempt = async (
	namespace: string,
	procedure: string,
	input?: unknown
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> => {
	try {
		return { ok: true, value: await call(namespace, procedure, input) };
	} catch (error) {
		return { ok: false, error };
	}
};

await setup();

try {
	console.log("\n── 1. the session is recognised ──");

	const me = await app.request("http://localhost/api/v1/auth/me", { headers: { cookie } });
	check("GET /api/v1/auth/me is 200 for a live session", me.status === 200, `got ${me.status}`);
	const meBody = (await me.json().catch(() => ({}))) as {
		userId?: string;
		organizations?: { slug: string }[];
	};
	check("it reports the probe user", meBody.userId === userId, `got ${meBody.userId}`);
	check(
		"it lists the probe organization",
		Array.isArray(meBody.organizations) && meBody.organizations.some((o) => o.slug === orgSlug),
		`got ${JSON.stringify(meBody.organizations)}`
	);

	console.log("\n── 2. the bucket reads return real data ──");

	const buckets = (await call("bucket", "listBuckets")) as {
		buckets?: { name: string; objectCount: number }[];
	};
	const probeRow = buckets?.buckets?.find((b) => b.name === bucketName);
	check("bucket/listBuckets lists the probe bucket", probeRow !== undefined);
	// `objectCount` is a JOIN count, not a column. A wrong join returns 0 for a bucket that
	// visibly has files, which a 200 alone would hide.
	check(
		"the object count is computed, not defaulted to 0",
		probeRow?.objectCount === 2,
		`got ${probeRow?.objectCount}`
	);

	const listing = (await call("bucket", "listObjects", {
		bucket: bucketName,
		prefix: "probe/",
		delimiter: "/",
		maxKeys: 200,
	})) as { objects?: { key: string }[] };
	check(
		"the listing returns both probe objects",
		Array.isArray(listing?.objects) && listing.objects.length === 2,
		`got ${JSON.stringify(listing).slice(0, 240)}`
	);
	check(
		"each object reports its own key",
		listing?.objects?.some((o) => o.key === "probe/one.txt") === true,
		`got ${JSON.stringify(listing?.objects?.map((o) => o.key))}`
	);

	console.log("\n── 3. storage accounting adds up ──");

	const usage = (await call("bucket", "usage", { bucket: bucketName })) as {
		bytes?: number;
		objects?: number;
	};
	check("it sums the two sizes (10 + 25 = 35)", usage?.bytes === 35, `got ${usage?.bytes}`);
	check("it counts 2 objects", usage?.objects === 2, `got ${usage?.objects}`);

	const orgUsage = (await call("storage", "usage")) as {
		organization?: { bytes: number };
	};
	check(
		"the tenant total includes the probe bucket",
		(orgUsage?.organization?.bytes ?? 0) >= 35,
		`got ${JSON.stringify(orgUsage?.organization)}`
	);

	console.log("\n── 4. a write reaches the database ──");

	const newName = `probe-new-${runId}`;
	const created = (await call("bucket", "createBucket", { name: newName })) as { name?: string };
	check(
		"bucket/createBucket returns the new bucket",
		created?.name === newName,
		`got ${JSON.stringify(created)}`
	);
	const rows = (await db.execute(sql`
		select name from buckets where organization_id = ${orgId}::uuid and name = ${newName}
	`)) as unknown as { name: string }[];
	check("the bucket row exists afterwards", rows.length === 1, `found ${rows.length}`);
	await db.execute(sql`
		delete from buckets where organization_id = ${orgId}::uuid and name = ${newName}
	`);

	// The unique-name path is the one that surfaced the `DrizzleQueryError` bug: a
	// collision must be a client error carrying the server's message, not a 500.
	const duplicate = await attempt("bucket", "createBucket", { name: bucketName });
	check(
		"a duplicate bucket name is refused, not silently accepted",
		duplicate.ok === false,
		"the duplicate name was accepted"
	);

	console.log("\n── 5. credentials are tenant-scoped and the secret is one-shot ──");

	const issued = (await call("credentials", "create", { label: "probe key" })) as {
		credential?: { accessKey: string };
		secretKey?: string;
	};
	check(
		"the create response carries a secret",
		typeof issued?.secretKey === "string" && issued.secretKey.length > 0,
		`got ${typeof issued?.secretKey}`
	);
	check(
		"the access key is a 20-character AKIA key",
		typeof issued?.credential?.accessKey === "string" &&
			/^AKIA[0-9A-F]{16}$/.test(issued.credential.accessKey),
		`got ${issued?.credential?.accessKey}`
	);

	const listed = (await call("credentials", "list")) as {
		credentials?: { accessKey: string }[];
	};
	check(
		"the listing includes the new key",
		listed?.credentials?.some((c) => c.accessKey === issued?.credential?.accessKey) === true,
		`got ${JSON.stringify(listed).slice(0, 240)}`
	);
	// The whole point of the summary type: a listing must NEVER carry a secret.
	check(
		"the listing carries NO secret field",
		JSON.stringify(listed ?? {}).includes("secretKey") === false,
		"the listing leaked a secretKey field"
	);

	console.log("\n── 6. a second tenant cannot see any of it ──");

	const otherSlug = `other-${runId}`;
	await db.execute(sql`
		insert into organizations (id, slug, name, created_at)
		values (${crypto.randomUUID()}::uuid, ${otherSlug}, ${`Other Org ${runId}`}, now())
	`);
	const crossTenant = await app.request(
		`http://localhost/rpc/bucket/listBuckets?org=${encodeURIComponent(otherSlug)}`,
		{ method: "POST", headers: { cookie } }
	);
	check(
		"a non-member tenant is refused even with a valid session",
		crossTenant.status === 403 || crossTenant.status === 401,
		`got ${crossTenant.status}`
	);
	const crossBody = await crossTenant.text();
	check(
		"the refusal carries no bucket names",
		crossBody.includes(bucketName) === false,
		`leaked: ${crossBody.slice(0, 200)}`
	);

	console.log("\n── 7. a delete is real, and the row is gone ──");

	const removed = await attempt("bucket", "deleteObject", {
		bucket: bucketName,
		key: "probe/one.txt",
	});
	check("bucket/deleteObject succeeds", removed.ok === true, `threw: ${JSON.stringify(removed)}`);
	// The handler returns `{"success":true}` unconditionally, so the ROW is the only
	// trustworthy evidence — the same reasoning `file-browser.tsx` encodes by re-listing.
	const live = (await db.execute(sql`
		select s3_key from files where bucket_id = ${bucketId}::uuid and is_deleted = false
	`)) as unknown as { s3_key: string }[];
	check(
		"the deleted key is no longer live",
		live.some((row) => row.s3_key === "probe/one.txt") === false,
		`still live: ${live.map((r) => r.s3_key).join(",")}`
	);
} finally {
	await cleanup();
}

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} probe(s) FAILED:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("all authenticated-surface probes passed");
process.exit(0);
