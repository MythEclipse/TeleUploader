/**
 * P3b — S3 credential lookup is genuinely exercised.
 *
 * This is the test that would have caught the whole premise being false. Before
 * P3 the ONLY place in `src/` that read `config.s3AccessKey` /
 * `config.s3SecretKey` for verification was s3-router.ts, so a credential that
 * existed only in `s3_credentials` could not authenticate at all: signing a
 * presigned GET with a database-only pair returned `SignatureDoesNotMatch`
 * while the environment pair returned `isValid: true`, because the verification
 * path never touched the database.
 *
 * The SigV4 arithmetic itself is unchanged and is covered by s3-auth.test.ts.
 * What is under test here is only WHICH secret is resolved, and that an unknown
 * key is rejected rather than falling through to the environment pair.
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION OF THIS FILE
 *
 * Every database-backed test was guarded by `if (!live) return;`. A silent
 * early return is not a skip — vitest counts it as PASSED. With CI running no
 * DATABASE_URL, this file reported "6 passed" having asserted nothing, so it
 * could not fail for the very regression it was written to catch.
 *
 * Worse, the two "filedrop-admin" tests were written to accept EITHER outcome
 * (`if (!inStore) expect(invalid) else expect(valid)`). That is an assertion
 * that cannot fail: whatever the resolver does, some branch passes. A credential
 * present only in the environment — the exact bug this file exists to rule out —
 * satisfies it. Verified: with `filedrop-admin` seeded with a known secret, the
 * env-pair test passes whether or not the resolver ever consults the database.
 *
 * Fixed below. The credential this file needs is INSERTED by the test itself,
 * with a per-run unique access key and a secret chosen by the test. That turns
 * the previous tautology into a real assertion in both directions:
 *
 *   - the key IS in s3_credentials, signed with ITS secret  -> must be VALID
 *   - the key IS in s3_credentials, signed with the ENV pair -> must be REJECTED
 *
 * The env pair is read from `config` at run time rather than hardcoded, so the
 * "no env fallback" claim survives whatever the environment happens to hold.
 * Note the test never seeds `filedrop-admin`: that is production's key, and
 * writing to it would make the suite non-idempotent against a shared database.
 */
import { createHash, createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeLiveDatabase } from "./helpers/live-db";
import { asFixtureDb, createOrg, ORG_PREFIX, prepareLiveFixtures } from "./helpers/live-fixtures";

process.env.BOT_TOKENS ||= "123456:ABC-DEF";
process.env.STORAGE_CHANNEL_ID ||= "-1001234567890";
process.env.BASE_URL ||= "https://example.com";
process.env.PORT ||= "4000";
process.env.NODE_ENV = "test";

/**
 * The credential this file authenticates with.
 *
 * Unique per run and created by the test, so the suite is re-runnable and does
 * not depend on what any earlier run — or a developer's seeded database —
 * happens to contain. `crypto.randomUUID` is used rather than a timestamp
 * because `access_key` is UNIQUE: two runs of this file must not collide.
 */
const ACCESS_KEY = `p3b-live-key-${crypto.randomUUID()}`;
const SECRET_KEY = `p3b-live-secret-${crypto.randomUUID()}`;

/**
 * The environment pair is set EXPLICITLY, and deliberately made hostile: its
 * access key is the very key this test stores in the database, but its secret is
 * a DIFFERENT one.
 *
 * That is what gives the "no env fallback" test its teeth. The same access key is
 * knowable from both the environment and the database while only the DATABASE
 * secret can produce a valid signature — so if verification ever regresses to
 * reading `config.s3SecretKey` instead of calling the resolver, the URL signed
 * with the env secret verifies and the test fails.
 *
 * It also fixes a self-inflicted defect in the first draft of this test, which
 * used `config.s3SecretKey || SECRET_KEY`. `config.s3SecretKey` is `''` whenever
 * `S3_SECRET_KEY` is unset, so in a plain CI run the `||` supplied the DATABASE
 * secret, the signature was correct, and `expect(isValid).toBe(false)` FAILED.
 * Setting the pair explicitly removes the dependence on the ambient environment.
 *
 * Both halves are required together — env.ts refuses `S3_ACCESS_KEY` without
 * `S3_SECRET_KEY`. Set before `src/env.ts` is imported below, because `config`
 * snapshots `process.env` at module load.
 */
process.env.S3_ACCESS_KEY = ACCESS_KEY;
process.env.S3_SECRET_KEY = `p3b-env-secret-${crypto.randomUUID()}`;

const { verifyPresignedUrl, verifySignature, parseCredentialScope } = await import(
	"../src/presentation/s3/auth"
);
const { DrizzleS3CredentialRepository } = await import(
	"../src/infrastructure/persistence/repositories/s3-credential-repository"
);
const { db } = await import("../src/infrastructure/persistence/drizzle/index");
const { config } = await import("../src/env");

const REGION = "us-east-1";
const fixtureDb = asFixtureDb(db);

/**
 * Probe BEFORE the suite is registered — `describe.skipIf` is evaluated at
 * collection time, so the answer must already exist. Throws when DATABASE_URL is
 * set but unusable; skips visibly when it is absent.
 */
const status = await probeLiveDatabase(async () => {
	await db.execute(sql`SELECT 1`);
});

/**
 * The reason the database-backed tests are not running, or `''` when they are.
 *
 * vitest 5's `skipIf(condition)` takes no reason argument, so the reason is
 * surfaced by the `live database availability` suite below instead — which runs
 * unconditionally — rather than being passed to skipIf. See the note in
 * tenant-isolation.test.ts for why the 3-argument form was a trap.
 */
const SKIP_REASON = status.state === "live" ? "" : `[live-db] ${status.reason}`;

const live = status.state === "live";

/** A key that exists in NO store — used to prove there is no env fallback. */
const UNKNOWN_KEY = `no-such-key-${crypto.randomUUID()}`;

let teardown: (() => Promise<void>) | null = null;

beforeAll(async () => {
	if (!live) return;
	teardown = await prepareLiveFixtures(fixtureDb);
	const orgId = await createOrg(fixtureDb, ORG_PREFIX);
	await db.execute(
		sql`INSERT INTO s3_credentials (organization_id, access_key, secret_key, label)
        VALUES (${orgId}::uuid, ${ACCESS_KEY}, ${SECRET_KEY}, 'p3b live-db test credential')`
	);
});

afterAll(async () => {
	if (!live) return;
	// Delete by access_key, not only by a remembered id: a run interrupted before
	// `afterAll` still leaves a row the NEXT run must be able to remove.
	await db
		.execute(
			sql`DELETE FROM s3_credentials WHERE access_key = ${ACCESS_KEY} OR access_key LIKE ${`${ORG_PREFIX}-key-%`}`
		)
		.catch(() => {});
	await teardown?.();
});

/**
 * Resolves against the real repository, i.e. against `s3_credentials`.
 *
 * This is the point of the test: the resolver is the production one, so a
 * database-only key must verify and an absent key must not.
 */
const dbBackedResolver = async (accessKey: string): Promise<string | null> => {
	const repo = new DrizzleS3CredentialRepository();
	const credential = await repo.findByAccessKey(accessKey);
	return credential?.secretKey ?? null;
};

/** SHA-256 hex, matching auth.ts's internal helper. */
const sha256hex = (data: string): string => createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer, message: string): Buffer =>
	createHmac("sha256", key).update(message).digest();

/** The four-step SigV4 signing key derivation, mirroring auth.ts. */
const signingKey = (secret: string, dateStamp: string, region: string): Buffer => {
	const kDate = hmac(Buffer.from(`AWS4${secret}`), dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, "s3");
	return hmac(kService, "aws4_request");
};

/** Build a valid presigned GET URL for the given key pair. */
const presign = (host: string, path: string, accessKey: string, secret: string): string => {
	const dateStamp = "20260707";
	const amzDate = "20260707T120000Z";
	const sp = new URLSearchParams({
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${accessKey}/${dateStamp}/${REGION}/s3/aws4_request`,
		"X-Amz-Date": amzDate,
		"X-Amz-Expires": "3600",
		"X-Amz-SignedHeaders": "host",
	});
	const canonicalRequest = `GET\n${path}\n${sp.toString()}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
	const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
	sp.set(
		"X-Amz-Signature",
		hmac(signingKey(secret, dateStamp, REGION), stringToSign).toString("hex")
	);
	return `https://${host}${path}?${sp.toString()}`;
};

describe("parseCredentialScope", () => {
	it("splits a scope into its five parts", () => {
		expect(parseCredentialScope("key/20260707/us-east-1/s3/aws4_request")).toEqual({
			accessKey: "key",
			date: "20260707",
			region: "us-east-1",
			service: "s3",
			termination: "aws4_request",
		});
	});

	it("rejects a scope that is not exactly five parts", () => {
		expect(parseCredentialScope("key/20260707/us-east-1")).toBeNull();
		expect(parseCredentialScope("key/20260707/us-east-1/s3/aws4_request/extra")).toBeNull();
		// Empty segments are not a usable credential.
		expect(parseCredentialScope("/20260707/us-east-1/s3/aws4_request")).toBeNull();
	});
});

/**
 * Always runs — never skipped — and states outright whether the credential
 * assertions below executed.
 *
 * This is the guard against the original defect: `if (!live) return` inside the
 * tests below reported "passed" while verifying nothing. See the identical suite
 * in tenant-isolation.test.ts for the full write-up.
 */
describe("live database availability", () => {
	it('reports its own skip state, so "did not run" is distinguishable from "passed"', () => {
		if (live) {
			expect(SKIP_REASON).toBe("");
			return;
		}
		expect(SKIP_REASON).toContain("[live-db]");
		expect(SKIP_REASON).toMatch(/DATABASE_URL is not set/);
		console.info(SKIP_REASON);
	});
});

describe("credential resolution", () => {
	// These read `s3_credentials` for real — that IS the behaviour under test, so
	// it cannot be mocked the way the other suites mock their repositories. They
	// skip VISIBLY (never as a silent early return reported as passed) when no
	// database is configured, and FAIL when one is configured but unusable.
	it.skipIf(!live)("a key that exists ONLY in s3_credentials authenticates", async () => {
		// The load-bearing assertion. Before P3 this returned SignatureDoesNotMatch
		// because the verification path never consulted the database at all.
		const url = presign("localhost", "/bucket/key.txt", ACCESS_KEY, SECRET_KEY);
		const result = await verifyPresignedUrl({
			url,
			method: "GET",
			headers: { host: "localhost" },
			resolveSecret: dbBackedResolver,
			region: REGION,
			now: new Date("2026-07-07T12:05:00Z"),
		});

		expect(result.isValid).toBe(true);
		expect(result.credential?.accessKey).toBe(ACCESS_KEY);
	});

	it.skipIf(!live)(
		"the same key signed with the ENVIRONMENT pair is REJECTED (no env fallback)",
		async () => {
			// This replaces a tautology. The previous version asserted
			// `if (!inStore) expect(invalid) else expect(valid)` against
			// `filedrop-admin`, a key this test does not control: every possible
			// behaviour of the resolver satisfied some branch, so it could not fail.
			//
			// Here ACCESS_KEY is knowable from both the environment and the database
			// (both were set to the same value above) while only the DATABASE secret
			// can produce a valid signature. `config.s3SecretKey` is asserted distinct
			// from SECRET_KEY first, so a collapsed pair fails loudly instead of
			// quietly making the signature below correct.
			expect(config.s3AccessKey).toBe(ACCESS_KEY);
			expect(config.s3SecretKey).not.toBe(SECRET_KEY);

			const url = presign("localhost", "/bucket/key.txt", ACCESS_KEY, config.s3SecretKey);
			const result = await verifyPresignedUrl({
				url,
				method: "GET",
				headers: { host: "localhost" },
				resolveSecret: dbBackedResolver,
				region: REGION,
				now: new Date("2026-07-07T12:05:00Z"),
			});

			expect(result.isValid).toBe(false);
			expect(result.errorCode).toBe("SignatureDoesNotMatch");
		}
	);

	it.skipIf(!live)("a key present in no store is rejected", async () => {
		const url = presign("localhost", "/bucket/key.txt", UNKNOWN_KEY, "whatever");
		const result = await verifyPresignedUrl({
			url,
			method: "GET",
			headers: { host: "localhost" },
			resolveSecret: dbBackedResolver,
			region: REGION,
			now: new Date("2026-07-07T12:05:00Z"),
		});
		expect(result.isValid).toBe(false);
		expect(result.errorCode).toBe("SignatureDoesNotMatch");
	});

	it.skipIf(!live)("a wrong secret for a known-scope key does not verify", async () => {
		const url = presign("localhost", "/bucket/key.txt", ACCESS_KEY, "the-wrong-secret");
		const result = await verifyPresignedUrl({
			url,
			method: "GET",
			headers: { host: "localhost" },
			resolveSecret: dbBackedResolver,
			region: REGION,
			now: new Date("2026-07-07T12:05:00Z"),
		});
		// The key IS in the store here, so this distinguishes "unknown key" from
		// "known key, bad signature" and proves the resolver is really returning
		// the stored secret rather than short-circuiting on a miss.
		expect(result.isValid).toBe(false);
		expect(result.errorCode).toBe("SignatureDoesNotMatch");
	});

	it.skipIf(!live)(
		"header-based auth also resolves through the callback, not the environment",
		async () => {
			const dateStamp = "20260707";
			const amzDate = "20260707T120000Z";
			const headers = {
				authorization: `AWS4-HMAC-SHA256 Credential=${UNKNOWN_KEY}/${dateStamp}/${REGION}/s3/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`,
				"x-amz-date": amzDate,
				host: "localhost",
			};
			const result = await verifySignature(
				"GET",
				"http://localhost/",
				headers,
				null,
				dbBackedResolver,
				REGION
			);
			expect(result.isValid).toBe(false);
			expect(result.errorCode).toBe("SignatureDoesNotMatch");
		}
	);
});
