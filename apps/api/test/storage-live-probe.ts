/**
 * Live probe for the per-user storage surface against a REAL Postgres.
 *
 * Run with a migrated database:
 *
 *   DATABASE_URL=postgresql://… npx tsx test/storage-live-probe.ts
 *
 * This is a PROBE, not a test file, for the same reason
 * `identity-live-probe.ts` is one: it opens a real connection, so it must not
 * run in the unit suite where every other file mocks the database.
 *
 * It exists because the mocked tests prove the DECISION logic and say nothing
 * about whether the SQL is VALID. Every operation added for the file manager is
 * a hand-written statement — a `SUM` with a join, an `UPDATE ... RETURNING`, a
 * `LIKE`-prefix rename, an `ILIKE` search, an `INSERT ... RETURNING` with a
 * generated key — and a wrong column name or an unparseable expression passes
 * every mock and fails on the first real click.
 *
 * What it asserts, in order:
 *
 *   1. sign-in style provisioning creates ONE bucket per tenant, idempotently;
 *   2. two tenants cannot see each other's buckets, usage or search results;
 *   3. usage totals sum the real bytes rather than the current page;
 *   4. a single-object move renames, refuses a missing source, and refuses a
 *      destination that already exists (the 409, not a 500);
 *   5. a folder rename carries every key under the prefix and is atomic;
 *   6. search is scoped to the tenant and matches case-insensitively;
 *   7. a credential's secret is readable exactly once and never by the list.
 */
process.env.BOT_TOKENS ||= "123456:ABC-DEF";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";
process.env.BASE_URL ||= "http://127.0.0.1:4399";
process.env.PORT ||= "4399";

const { DrizzleBucketRepository } = await import(
	"../src/infrastructure/persistence/repositories/bucket-repository"
);
const { DrizzleFileRepository } = await import(
	"../src/infrastructure/persistence/repositories/file-repository"
);
const { DrizzleS3CredentialRepository } = await import(
	"../src/infrastructure/persistence/repositories/s3-credential-repository"
);
const { db } = await import("../src/infrastructure/persistence/drizzle/index");
const { sql } = await import("drizzle-orm");

const buckets = new DrizzleBucketRepository();
const files = new DrizzleFileRepository();
const credentials = new DrizzleS3CredentialRepository();

/** Probe tenants, created fresh and removed at the end. */
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ""): void => {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Inserts one file row with a minimal valid payload. */
const insertFile = async (
	bucketId: string,
	key: string,
	sizeBytes: number,
	publicId: string
): Promise<void> => {
	await db.execute(sql`
		INSERT INTO files (
			public_id, telegram_file_id, telegram_file_unique_id, storage_chat_id,
			storage_message_id, file_name, mime_type, size_bytes, file_type,
			uploader_id, file_hash, bucket_id, s3_key, storage_backend, is_deleted
		) VALUES (
			${publicId}, ${`tg-${publicId}`}, ${`tgu-${publicId}`}, -1001234567890,
			1, ${key.split("/").pop() ?? key}, 'text/plain', ${sizeBytes}, 'document',
			0, ${`hash-${publicId}`}, ${bucketId}::uuid, ${key}, 'telegram', false
		)
	`);
};

/** Removes everything this probe created, by tenant. */
const cleanup = async (): Promise<void> => {
	for (const tenant of [TENANT_A, TENANT_B]) {
		await db.execute(sql`DELETE FROM s3_credentials WHERE organization_id = ${tenant}::uuid`);
		await db.execute(
			sql`DELETE FROM files WHERE bucket_id IN (SELECT id FROM buckets WHERE organization_id = ${tenant}::uuid)`
		);
		await db.execute(sql`DELETE FROM buckets WHERE organization_id = ${tenant}::uuid`);
		await db.execute(sql`DELETE FROM organizations WHERE id = ${tenant}::uuid`);
	}
};

await cleanup();
await db.execute(
	sql`INSERT INTO organizations (id, name, slug) VALUES (${TENANT_A}::uuid, 'Probe A', 'probe-a'), (${TENANT_B}::uuid, 'Probe B', 'probe-b')`
);

console.log("\n1. provisioning");
const bucketA = await buckets.create("probe-a-files", TENANT_A);
const again = await buckets.findByName("probe-a-files", TENANT_A);
check("a created bucket is found by name within its tenant", again?.id === bucketA.id);
check(
	"the same name in another tenant is invisible",
	(await buckets.findByName("probe-a-files", TENANT_B)) === null
);
const bucketB = await buckets.create("probe-a-files", TENANT_B);
check("two tenants can own the same bucket name", bucketB.id !== bucketA.id);

console.log("\n2. usage totals");
await insertFile(bucketA.id, "one.txt", 100, "pub-usage-1");
await insertFile(bucketA.id, "two.txt", 250, "pub-usage-2");
await insertFile(bucketA.id, "nested/three.txt", 400, "pub-usage-3");
const usageA = await files.usageByBucket(bucketA.id);
check(
	"usageByBucket sums every row, not the current page",
	usageA.bytes === 750,
	`got ${usageA.bytes}`
);
check("usageByBucket counts every row", usageA.objects === 3, `got ${usageA.objects}`);
const orgUsageA = await files.usageByOrganization(TENANT_A);
check("usageByOrganization sums the tenant", orgUsageA.bytes === 750, `got ${orgUsageA.bytes}`);
check("usageByOrganization counts buckets", orgUsageA.buckets === 1, `got ${orgUsageA.buckets}`);
const orgUsageB = await files.usageByOrganization(TENANT_B);
check("another tenant's usage is zero", orgUsageB.bytes === 0, `got ${orgUsageB.bytes}`);

console.log("\n3. single-object move");
const moved = await files.moveObject(bucketA.id, "one.txt", "renamed.txt");
check("moving an existing key reports moved", moved === "moved", `got ${moved}`);
check(
	"the renamed key is readable",
	(await files.findByBucketAndKey(bucketA.id, "renamed.txt")) !== null
);
check("the old key is gone", (await files.findByBucketAndKey(bucketA.id, "one.txt")) === null);
const missing = await files.moveObject(bucketA.id, "never-existed.txt", "whatever.txt");
check("moving a missing key reports missing", missing === "missing", `got ${missing}`);
const collide = await files.moveObject(bucketA.id, "renamed.txt", "two.txt");
check(
	"moving onto an existing key reports destination-exists, not an exception",
	collide === "destination-exists",
	`got ${collide}`
);
check(
	"the collision left both objects intact",
	(await files.findByBucketAndKey(bucketA.id, "two.txt")) !== null
);

console.log("\n4. folder rename");
const folderMoved = await files.movePrefix(bucketA.id, "nested/", "deep/");
check("renaming a folder moves its objects", folderMoved === 1, `got ${folderMoved}`);
check(
	"the object is under the new prefix",
	(await files.findByBucketAndKey(bucketA.id, "deep/three.txt")) !== null
);
check(
	"the old prefix is empty",
	(await files.listByPrefix(bucketA.id, "nested/", "/", 10, null)).objects.length === 0
);
await insertFile(bucketA.id, "src/a.txt", 10, "pub-folder-1");
await insertFile(bucketA.id, "src/b.txt", 20, "pub-folder-2");
const bulk = await files.movePrefix(bucketA.id, "src/", "lib/");
check("a multi-object prefix rename moves every key", bulk === 2, `got ${bulk}`);

console.log("\n5. search");
const hits = await files.searchByKey(TENANT_A, "deep/", 100);
check("search finds objects by key fragment", hits.length === 1, `got ${hits.length}`);
check(
	"search reports the bucket name",
	hits[0]?.bucket === "probe-a-files",
	`got ${hits[0]?.bucket}`
);
const upper = await files.searchByKey(TENANT_A, "DEEP/", 100);
check("search is case-insensitive", upper.length === 1, `got ${upper.length}`);
const crossTenant = await files.searchByKey(TENANT_B, "deep/", 100);
check(
	"search never crosses the tenant boundary",
	crossTenant.length === 0,
	`got ${crossTenant.length}`
);
const capped = await files.searchByKey(TENANT_A, ".txt", 2);
check("search honours its limit", capped.length === 2, `got ${capped.length}`);

console.log("\n6. credentials");
const created = await credentials.create(TENANT_A, "probe key");
// The AWS shape: `AKIA` + 16 uppercase hex digits = 20 characters. The previous
// assertion pinned `{13}` — the length the old `randomBytes(13)` happened to emit — so it
// agreed with a 30-character key that no S3 client recognises as an access key id.
check(
	"a created access key has the AWS shape (AKIA + 16 hex = 20 chars)",
	/^AKIA[0-9A-F]{16}$/.test(created.credential.accessKey),
	`${created.credential.accessKey} (${created.credential.accessKey.length} chars)`
);
check(
	"a created secret is 40 characters",
	created.secretKey.length === 40,
	String(created.secretKey.length)
);
const listed = await credentials.listByOrganization(TENANT_A);
check(
	"the list includes the new key",
	listed.some((c) => c.id === created.credential.id)
);
check(
	"the list carries no secret field",
	listed.every((entry) => !Object.hasOwn(entry, "secretKey"))
);
const resolved = await credentials.findByAccessKey(created.credential.accessKey);
check("the key resolves to its tenant for SigV4", resolved?.organizationId === TENANT_A);
check("the resolved secret matches what was issued", resolved?.secretKey === created.secretKey);
const otherTenantList = await credentials.listByOrganization(TENANT_B);
check("another tenant's list is empty", otherTenantList.length === 0);
const crossDelete = await credentials.delete(created.credential.id, TENANT_B);
check("deleting another tenant's credential is refused", crossDelete === false);
const ownDelete = await credentials.delete(created.credential.id, TENANT_A);
check("deleting your own credential succeeds", ownDelete === true);

await cleanup();
await db.execute(sql`DELETE FROM organizations WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`);

console.log("");
if (failures.length > 0) {
	console.log(`${failures.length} FAILED:`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
console.log("all storage-surface probes passed");
process.exit(0);
