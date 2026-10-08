import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../../../env';
import { getErrorMessage } from '../../file';
import logger from '../../observability/logger';

/**
 * Journal entry for the pre-drizzle schema.
 *
 * The baseline migration file is intentionally comment-only, so applying it is a
 * no-op — there is nothing to timestamp-trick. `when` in the journal is its real
 * generation time and is left alone. An earlier revision set it to a far-future
 * value to force the skip; that was wrong, because the migrator compares against
 * the NEWEST recorded row, so a future-dated baseline permanently blocks every
 * later migration (verified: a simulated P3 tenancy migration silently never
 * applied). See drizzle/0000_baseline.sql.
 */
const BASELINE_ENTRY = { tag: '0000_baseline' };

/**
 * Locate the drizzle migrations folder.
 *
 * In a compiled bundle the module sits at dist/, in dev it sits at
 * src/infrastructure/persistence/drizzle/. The migrations folder is data, not
 * code, so it is not bundled into the JS and has to be found at runtime.
 */
const resolveMigrationsFolder = (): string | null => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dir, '../../../../drizzle'), // from dist/
    join(dir, '../../drizzle'), // from src/infrastructure/persistence/drizzle/
    join(dir, '../../../drizzle'), // from src/infrastructure/persistence/
    join(dir, './drizzle'), // next to the module
    join(process.cwd(), 'drizzle'), // run from apps/api
    join(process.cwd(), 'apps/api/drizzle'), // run from the repo root
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  return null;
};

/**
 * Mark the pre-drizzle schema as already applied.
 *
 * Production predates drizzle: its five tables were created by executing
 * schema.sql at boot, so the journal table does not exist there yet. Without
 * this, the migrator's very first action would be to create the baseline row's
 * journal entry on an EMPTY table and then apply later migrations — but on a
 * database that already has all five tables, a real generated migration would
 * fail with "relation already exists".
 *
 * The baseline migration file itself carries no DDL, so the cleanest way to
 * represent "the pre-existing schema is current" is exactly this: seed the journal
 * with the baseline entry's own hash and timestamp, then let `migrate()` skip it
 * like any other already-applied migration. Timestamps stay real; nothing is
 * future-dated.
 *
 * Idempotent: guarded by WHERE NOT EXISTS on created_at, because drizzle's table
 * has no unique constraint on hash or created_at to conflict on.
 */
const runBaseline = async (sql: postgres.Sql, journalFolder: string): Promise<void> => {
  // Read the baseline entry's real hash the same way drizzle's migrator does:
  // sha256 of the migration file's contents. If the file changes, this changes.
  const baselineSql = await readFile(join(journalFolder, '0000_baseline.sql'), 'utf8');
  const hash = createHash('sha256').update(baselineSql).digest('hex');
  const journal = JSON.parse(
    await readFile(join(journalFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  const entry = journal.entries.find((e) => e.tag === BASELINE_ENTRY.tag);
  if (!entry) throw new Error(`Journal entry ${BASELINE_ENTRY.tag} not found`);

  // One statement per call: postgres.js uses the extended protocol for tagged
  // templates, which rejects a multi-command batch with
  // "cannot insert multiple commands into a prepared statement".
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;
  await sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    SELECT ${hash}, ${entry.when}
    WHERE NOT EXISTS (
      SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}
    )
  `;
};

/**
 * Apply pending migrations. This is the ONLY migration runner: the boot-time
 * auto-migration that executed schema.sql inside a try/catch is removed in this
 * same commit, because two sources of truth for the schema is exactly the defect
 * drizzle replaces.
 *
 * `drizzle-kit migrate` is deliberately NOT used against production. The prod
 * DSN points at PgBouncer in transaction-pooling mode (port 6432), where a
 * session-scoped advisory lock can be released on a different pooled connection
 * mid-migration.
 *
 * ⚠️ THIS RUNNER IS CURRENTLY ORPHANED — read before assuming deploy.sh calls it.
 *
 * P2a deleted the boot-time auto-migration and replaced it with this file, on the
 * stated assumption that "deploy.sh runs `node dist/migrate.js` over SSH". That
 * assumption was WRONG and was caught by an adversarial review, not by a test.
 * Verified: `deploy.sh` mentions migrate.js in exactly three places — the
 * `--check` list, the post-build existence assertion, and the `scp` — and never
 * EXECUTES it.
 *
 * So today there is NO code path that applies migrations: not at boot (removed),
 * and not during deploy (never existed). Shipping a build containing migrations
 * 0001-0003 would leave production on the pre-P3a schema while the new binary
 * runs org-scoped code, and 0002's precondition guard would RAISE on any deploy
 * that did try to run it.
 *
 * P5 must add the invocation to deploy.sh, immediately before `systemctl restart`
 * and AFTER the binary is installed. Until then, `pnpm db:migrate` must be run by
 * hand. Do not delete the boot-time call without adding the deploy-time one.
 */
export const runMigration = async (): Promise<void> => {
  const migrationsFolder = resolveMigrationsFolder();
  if (!migrationsFolder) {
    logger.error(
      'Migration failed: drizzle migrations folder not found (looked for meta/_journal.json next to the module, in cwd, and at apps/api/drizzle)',
    );
    process.exitCode = 1;
    return;
  }

  const sql = postgres(config.databaseUrl, { max: 1 });

  try {
    await runBaseline(sql, migrationsFolder);
    const db = drizzle(sql);

    await migrate(db, { migrationsFolder });
    logger.info('Database migration completed');
  } catch (error: unknown) {
    logger.error('Database migration failed', { error: getErrorMessage(error) });
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
};

// When run directly: `node dist/migrate.js` or `tsx src/.../migrate.ts`.
// Node has no `Bun.main`, so compare this module's URL with the invoked entry.
const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await runMigration();
}
