/**
 * P3b fix — a missing bootstrap membership must NOT become a per-request 403.
 *
 * THE DEFECT THIS PINS
 *
 * `resolveAdminOrganizationId` used to return `null` when the bootstrap admin
 * had no `members` row, and both callers turned that null into a denial: 403 on
 * `GET /api/v1/buckets` (a route documented PUBLIC) and 401 on every oRPC
 * procedure. `BOOTSTRAP_ADMIN_ID` is set by nothing — not .env.example, not
 * deploy.sh, not docker-compose.yml, not CI — so it defaults to
 * 'bootstrap-admin', a row that only exists if `pnpm db:seed` ran. deploy.sh
 * runs neither migrate nor seed, so the denied-everything state was the DEFAULT
 * state of a real deploy.
 *
 * It stayed hidden for two independent reasons, and this file closes both:
 *   1. web-api / s3-bucket-config / multipart-tenancy all stubbed the lookup to
 *      answer 'org-a' for EVERY truthy user id, so the null branch was
 *      unreachable. Those stubs are now keyed by user id.
 *   2. test/live-probe.ts unsets ADMIN_API_TOKEN, so with auth disabled the
 *      probe reported PASS while production would have denied everything.
 *
 * A missing membership is a MISCONFIGURATION. It now throws
 * MissingOrganizationMembershipError at boot instead of denying traffic.
 *
 * Run with a live database:
 *   DATABASE_URL=postgresql://kana:kanaprobe@127.0.0.1:5432/probe_kana \
 *   BOT_TOKENS=1:test STORAGE_CHANNEL_ID=-1001234 BASE_URL=http://127.0.0.1:4311 \
 *   PORT=4311 npx vitest run --config vitest.config.ts \
 *   test/tenant-scope-misconfiguration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.BOT_TOKENS ||= '1:test';
process.env.STORAGE_CHANNEL_ID ||= '-1001234';
process.env.BASE_URL ||= 'http://127.0.0.1:4311';
process.env.PORT ||= '4311';

const { db } = await import('../src/infrastructure/persistence/drizzle/index');
const { DrizzleOrganizationRepository } = await import(
  '../src/infrastructure/persistence/repositories/organization-repository'
);
const resolver = await import('../src/presentation/http/controllers/organization-resolver');

const repo = new DrizzleOrganizationRepository();

/** Memberships created here, removed afterwards. */
const createdMemberships: { organizationId: string; userId: string }[] = [];

const databaseReachable = async (): Promise<boolean> => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
};

let live = false;

beforeAll(async () => {
  live = await databaseReachable();
  if (!live) return;

  // Provision a REAL org + membership, using a unique id so this never collides
  // with rows left by earlier runs (p3b-test-org-1/2 and the 'default' org).
  const organizationId = randomUUID();
  const userId = `probe-admin-${randomUUID()}`;
  await db.execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${organizationId}, ${`probe ${organizationId}`}, ${`probe-${organizationId}`})`,
  );
  await db.execute(
    sql`INSERT INTO members (organization_id, user_id, role) VALUES (${organizationId}, ${userId}, 'owner')`,
  );
  createdMemberships.push({ organizationId, userId });
});

afterAll(async () => {
  if (!live) return;
  for (const m of createdMemberships) {
    await db.execute(sql`DELETE FROM members WHERE user_id = ${m.userId}`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${m.organizationId}`);
  }
});

beforeEach(() => {
  // The resolver memoizes. Drop it so each test observes a fresh lookup, and so
  // one test's cached success cannot mask another's misconfiguration.
  //
  // Guarded on purpose: against the ORIGINAL buggy resolver this export does not
  // exist, and an unguarded call would throw in beforeEach and fail every test
  // for the wrong reason — masking the assertion that actually pins the defect.
  // With the guard, each test fails on its own assertion instead.
  resolver.resetOrganizationResolutionCache?.();
});

describe.skipIf(!process.env.DATABASE_URL)('bootstrap membership lookup (real database)', () => {
  it('resolves the organization for a user that HAS a membership', async () => {
    if (!live) return;
    const [membership] = createdMemberships;
    expect(membership).toBeDefined();

    const organizationId = await repo.findOrganizationIdByUserId(membership.userId);
    expect(organizationId).toBe(membership.organizationId);
  });

  it('returns null for a user with NO membership — the state that bricked the dashboard', async () => {
    if (!live) return;
    const organizationId = await repo.findOrganizationIdByUserId(`probe-absent-${randomUUID()}`);
    expect(organizationId).toBeNull();
  });
});

describe('resolver contract', () => {
  it('throws MissingOrganizationMembershipError rather than resolving to null', async () => {
    // Point BOOTSTRAP_ADMIN_ID at a user id that cannot exist — exactly what a
    // deploy that never ran db:seed looks like.
    //
    // env.ts captures config at MODULE LOAD, so the env var must be set before
    // the resolver is imported and the module registry reset. An earlier draft
    // spied on a separately-imported `config`, which the resolver never reads;
    // the test then passed for the wrong reason (it resolved the real
    // 'bootstrap-admin' membership instead of rejecting).
    const original = process.env.BOOTSTRAP_ADMIN_ID;
    process.env.BOOTSTRAP_ADMIN_ID = `probe-absent-${randomUUID()}`;
    vi.resetModules();

    try {
      const freshResolver = await import(
        '../src/presentation/http/controllers/organization-resolver'
      );
      await expect(freshResolver.resolveAdminOrganizationId()).rejects.toBeInstanceOf(
        freshResolver.MissingOrganizationMembershipError,
      );
    } finally {
      if (original === undefined) delete process.env.BOOTSTRAP_ADMIN_ID;
      else process.env.BOOTSTRAP_ADMIN_ID = original;
      vi.resetModules();
      resolver.resetOrganizationResolutionCache?.();
    }
  });

  it('resolves successfully for a user that DOES have a membership', async () => {
    // The positive case, against the real database and the real config path.
    if (!live) return;
    const [membership] = createdMemberships;
    const original = process.env.BOOTSTRAP_ADMIN_ID;
    process.env.BOOTSTRAP_ADMIN_ID = membership.userId;
    vi.resetModules();

    try {
      const freshResolver = await import(
        '../src/presentation/http/controllers/organization-resolver'
      );
      const organizationId = await freshResolver.resolveAdminOrganizationId();
      expect(organizationId).toBe(membership.organizationId);
    } finally {
      if (original === undefined) delete process.env.BOOTSTRAP_ADMIN_ID;
      else process.env.BOOTSTRAP_ADMIN_ID = original;
      vi.resetModules();
      resolver.resetOrganizationResolutionCache?.();
    }
  });

  it('error message names the remedy, not just the failure', () => {
    const error = new resolver.MissingOrganizationMembershipError('bootstrap-admin');
    expect(error.message).toContain('bootstrap-admin');
    expect(error.message).toContain('db:seed');
    expect(error.name).toBe('MissingOrganizationMembershipError');
  });
});
