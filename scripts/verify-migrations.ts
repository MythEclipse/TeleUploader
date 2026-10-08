/**
 * P5 migration verification harness.
 *
 * Answers one question: does the migration path that deploy.sh now invokes actually
 * leave the database in a state the new binary can run against?
 *
 * It applies the three real stages, in the order a fresh deployment hits them:
 *
 *   1. apps/api/schema.sql  — the pre-drizzle baseline (5 tables, no DDL of its own
 *                             beyond them). Production predates drizzle, so this
 *                             shape is what a legacy database actually looks like.
 *   2. dist/migrate.js      — the SAME runner deploy.sh runs, not a reimplementation.
 *   3. src/infrastructure/db/seed.ts — the bootstrap organization 0002 backfills
 *                             against (seed.ts:12-15).
 *
 * Then it asserts the invariants a deploy must not silently break:
 *
 *   - buckets.organization_id exists and is NOT NULL
 *   - zero buckets with a NULL or dangling organization_id (no silent orphaning)
 *   - every organizations/members/s3_credentials row is likewise attached
 *   - row counts on all five pre-existing tables are PRESERVED across the migration
 *   - the drizzle journal holds exactly the migrations on disk
 *   - every journal tag has a matching .sql file (a missing one makes the migrator
 *     throw "No file <tag>.sql found")
 *
 * WHY NOT RUN THIS AGAINST PRODUCTION
 *
 * It needs --allow-writes and refuses to touch a database whose name does not look
 * like a scratch database unless --allow-non-scratch is also passed. Both flags must
 * be given explicitly, so an accidental run against prod is a no-op rather than a
 * migration. See the guard in main().
 *
 * USAGE
 *
 *   # against a scratch DB — builds nothing, uses the existing dist/migrate.js
 *   DATABASE_URL=postgresql://kana:kanaprobe@127.0.0.1:5432/probe_p5 \
 *     npx tsx scripts/verify-migrations.ts --allow-writes
 *
 *   # point at a different runner (e.g. to test the deployed layout)
 *   DATABASE_URL=... npx tsx scripts/verify-migrations.ts \
 *     --allow-writes --migrate-path /tmp/p5probe/deployed/migrate.js
 *
 * REQUIRED ENV (mirrors src/env.ts, which the runner imports)
 *   DATABASE_URL, BOT_TOKENS, STORAGE_CHANNEL_ID, BASE_URL, PORT
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = join(repoRoot, 'apps', 'api');

// `postgres` is a dependency of apps/api, not of the workspace root, so a bare
// `import 'postgres'` from scripts/ fails with ERR_MODULE_NOT_FOUND. Resolve it
// through a require rooted at apps/api instead of hardcoding a path — a literal
// absolute path would work in exactly one checkout and break in CI and on the VPS.
// It is a CJS module whose export IS the factory, so there is no `.default` to unwrap.
const apiRequire = createRequire(join(API_ROOT, 'package.json'));
const postgres = apiRequire('postgres') as typeof import('postgres');

/** The five tables that existed before the tenancy migration. */
const PRESERVED_TABLES = ['files', 'buckets', 'multipart_uploads', 'multipart_parts', 'file_parts'];

interface Options {
  allowWrites: boolean;
  allowNonScratch: boolean;
  migratePath: string;
}

const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    allowWrites: false,
    allowNonScratch: false,
    migratePath: join(API_ROOT, 'dist', 'migrate.js'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-writes') opts.allowWrites = true;
    else if (arg === '--allow-non-scratch') opts.allowNonScratch = true;
    else if (arg === '--migrate-path') {
      const next = argv[i + 1];
      if (!next) throw new Error('--migrate-path requires a value');
      opts.migratePath = resolve(next);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'verify-migrations — applies schema.sql → migrate → seed and asserts the\n' +
          'post-conditions a deploy depends on.\n\n' +
          '  --allow-writes        REQUIRED. Without it the harness exits 0 without writing.\n' +
          '  --allow-non-scratch   additionally permit a database name that is not scratch-shaped.\n' +
          '  --migrate-path PATH   runner to execute (default apps/api/dist/migrate.js)\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
};

/**
 * Refuse to write unless the target is opt-in AND scratch-shaped.
 *
 * Two independent gates, because the failure this prevents is destroying production
 * data and one typo should not be able to clear both:
 *   1. --allow-writes must be present at all.
 *   2. the database name must look like a scratch DB, unless --allow-non-scratch
 *      is also passed.
 */
const assertSafeTarget = (opts: Options, databaseUrl: string): void => {
  if (!opts.allowWrites) {
    console.log(
      'verify-migrations: --allow-writes not given — no changes made.\n' +
        '                 (This harness applies real DDL. Re-run with --allow-writes\n' +
        '                  against a scratch database.)',
    );
    process.exit(0);
  }

  let dbName: string;
  try {
    const name = new URL(databaseUrl).pathname.replace(/^\//, '');
    if (!name) throw new Error('no database name in URL');
    dbName = name;
  } catch {
    throw new Error(`DATABASE_URL is not a parsable URL: ${databaseUrl}`);
  }

  const SCRATCHY = /^(probe|scratch|tmp|test|ci)[_-]/i;
  if (!SCRATCHY.test(dbName) && !opts.allowNonScratch) {
    throw new Error(
      `Refusing to write to database "${dbName}": the name is not scratch-shaped ` +
        '(expected a prefix like probe_, scratch_, tmp_, test_ or ci_).\n' +
        'This harness applies real DDL. If you are certain, re-run with --allow-non-scratch.',
    );
  }
  console.log(`verify-migrations: target database "${dbName}" accepted for writing.`);
};

/**
 * Run a command, failing loudly with its real exit code AND its output.
 *
 * stdout is captured rather than inherited and dropped: migrate.js reports its
 * failure ("Migration failed: drizzle migrations folder not found") on stdout via
 * winston, so discarding it turns every diagnosis into a bare "exit 1".
 */
const run = (label: string, cmd: string, args: string[], cwd: string): void => {
  process.stdout.write(`  → ${label} ... `);
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    const stdout = (error as { stdout?: Buffer }).stdout?.toString() ?? '';
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    throw new Error(`${label} failed (exit ${(error as { status?: number }).status ?? '?'})`);
  }
};

/**
 * Row counts for every table, keyed by table name.
 *
 * A missing table counts as 0, because the harness is expected to run against a
 * database that predates drizzle — where the tables do not exist yet until
 * schema.sql creates them.
 *
 * Existence is checked in a SEPARATE query rather than inside a CASE. A CASE does
 * not help: Postgres resolves every relation in a statement at parse/plan time, so
 * `case when to_regclass('public.files') is null then 0 else (select count(*) from
 * public.files) end` still raises "relation does not exist" on a fresh database
 * (verified). Two round-trips beat a query that cannot run.
 *
 * The table name is interpolated, never bound: postgres.js's `unsafe()` does not
 * parameterize (verified — a `$1` arrives as literal text). The names come from the
 * two constants in this file, never from input, so there is nothing to inject.
 */
const counts = async (sql: postgres.Sql): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const table of [...PRESERVED_TABLES, 'organizations', 'members', 's3_credentials']) {
    const exists = await sql.unsafe<{ present: boolean }[]>(
      `select to_regclass('public.${table}') is not null as present`,
    );
    if (!exists[0]?.present) {
      out[table] = 0;
      continue;
    }
    const rows = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from public."${table}"`,
    );
    out[table] = rows[0]?.n ?? 0;
  }
  return out;
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (the runner imports src/env.ts and needs it)');
  }
  assertSafeTarget(opts, databaseUrl);

  if (!existsSync(opts.migratePath)) {
    throw new Error(
      `migrate runner not found at ${opts.migratePath} — build first (pnpm run build)`,
    );
  }
  const drizzleFolder = join(opts.migratePath, '..', 'drizzle');
  // The runner must find its journal beside itself or in cwd, or it exits 1 without
  // applying anything. In this repo migrate.js lives in dist/ while the SQL lives in
  // apps/api/drizzle/, so the beside-the-binary folder is legitimately absent and
  // resolveMigrationsFolder()'s cwd candidates carry it — this run passes API_ROOT as
  // cwd, which is why it resolves.
  //
  // On the VPS the cwd candidates do NOT apply (the unit's WorkingDirectory is
  // /var/lib/teleuploader), so the beside-the-binary folder is the only thing that can
  // resolve there — which is exactly why deploy.sh now ships it. Point --migrate-path
  // at a deployed-layout copy to exercise that case.
  if (!existsSync(join(drizzleFolder, 'meta', '_journal.json'))) {
    console.log(
      `verify-migrations: (no drizzle/ beside ${opts.migratePath} — resolving via cwd\n` +
        '                     instead; deploy.sh ships the folder so the VPS does not\n' +
        '                     depend on this fallback)',
    );
  }

  // The journal asserted against is the source of truth: apps/api/drizzle/. This is
  // the same tree the runner applied, and the same tree deploy.sh ships to the VPS.
  const journalFolder = join(API_ROOT, 'drizzle');

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log('\n=== before ===');
    const before = await counts(sql);
    console.log('  ' + JSON.stringify(before));

    // Stage 1 — the pre-drizzle baseline.
    console.log('\n=== 1. schema.sql (pre-drizzle baseline) ===');
    run(
      'psql schema.sql',
      'psql',
      ['-v', 'ON_ERROR_STOP=1', '-d', databaseUrl, '-f', join(API_ROOT, 'schema.sql')],
      API_ROOT,
    );

    // Stage 2 — the real runner deploy.sh invokes. NOT `drizzle-kit migrate` and NOT
    // a reimplementation: the point is to exercise the exact binary that ships.
    //
    // cwd is API_ROOT, which is what makes the migration resolvable from a source
    // checkout: resolveMigrationsFolder() falls back to process.cwd()/drizzle
    // (migrate.ts:40), and running from dist/ instead makes every candidate miss.
    // On the VPS this is the beside-the-binary folder that deploy.sh now ships, so
    // the deployed path does not depend on cwd at all.
    console.log('\n=== 2. migrate.js (same runner deploy.sh runs) ===');
    run('node migrate.js', 'node', [opts.migratePath], API_ROOT);

    // Stage 3 — the bootstrap organization 0002 backfills against.
    console.log('\n=== 3. seed.ts (bootstrap organization) ===');
    run(
      'tsx src/infrastructure/db/seed.ts',
      'npx',
      ['tsx', join(API_ROOT, 'src', 'infrastructure', 'db', 'seed.ts')],
      API_ROOT,
    );

    console.log('\n=== 4. invariants ===');
    const failures: string[] = [];
    const check = (ok: boolean, msg: string): void => {
      console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
      if (!ok) failures.push(msg);
    };

    const after = await counts(sql);
    console.log('  after: ' + JSON.stringify(after));

    // Row preservation on the five pre-existing tables. Migrations add columns and
    // backfill; they must never delete a row.
    for (const table of PRESERVED_TABLES) {
      check(
        after[table] === before[table],
        `${table}: row count preserved (${before[table]} → ${after[table]})`,
      );
    }

    // buckets.organization_id must be present and NOT NULL. This is the P3b
    // precondition: the org-scoped code selects on it, and 0002 tightens it last.
    const col = await sql.unsafe<{ is_nullable: string; data_type: string }[]>(
      `select is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'buckets' and column_name = 'organization_id'`,
    );
    if (col.length === 0) {
      check(false, 'buckets.organization_id exists');
    } else {
      check(
        col[0].is_nullable === 'NO',
        `buckets.organization_id is NOT NULL (got ${col[0].is_nullable})`,
      );
    }

    // Zero orphans. A LEFT JOIN is used deliberately: a plain count of NULL
    // organization_id would miss a row pointing at a deleted organization.
    const orphanBuckets = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from buckets b
        left join organizations o on o.id = b.organization_id
       where b.organization_id is null or o.id is null`,
    );
    check(orphanBuckets[0].n === 0, `zero orphan buckets (got ${orphanBuckets[0].n})`);

    for (const [table, column] of [
      ['members', 'organization_id'],
      ['s3_credentials', 'organization_id'],
    ] as const) {
      const present = await sql.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} where ${column} is null`,
      );
      check(present[0].n === 0, `zero ${table} rows with NULL ${column} (got ${present[0].n})`);
    }

    // Journal must match the SQL files on disk. The migrator throws
    // "No file <tag>.sql found" for any journal entry whose .sql is absent, so a
    // mismatch here is a broken future deploy, not a cosmetic discrepancy.
    const journalPath = join(journalFolder, 'meta', '_journal.json');
    if (existsSync(journalPath)) {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      const expected = journal.entries.length;
      const applied = await sql.unsafe<{ n: number }[]>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      check(
        applied[0].n === expected,
        `journal rows match journal entries (${applied[0].n} vs ${expected})`,
      );

      const missing = journal.entries.filter(
        (e) => !existsSync(join(journalFolder, `${e.tag}.sql`)),
      );
      check(
        missing.length === 0,
        missing.length === 0
          ? 'every journal tag has a .sql file'
          : `missing .sql for: ${missing.map((m) => m.tag).join(', ')}`,
      );
    } else {
      check(false, `drizzle journal present at ${journalPath}`);
    }

    console.log('');
    if (failures.length > 0) {
      console.error(`verify-migrations: ${failures.length} FAILED`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log('verify-migrations: all invariants hold');
  } finally {
    await sql.end();
  }
};

await main();
