import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { config } from '../../../env';
import { getErrorMessage } from '../../../infrastructure/file';
import logger from '../../observability/logger';

/**
 * Run raw SQL migration from schema.sql.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 * Searches multiple relative paths to support execution from compiled dist,
 * bun --hot, or direct script invocation.
 */
export const runMigration = async (): Promise<void> => {
  // In compiled dist: the module lives in dist/; in dev (tsx src/...) it lives
  // at src/infrastructure/persistence/drizzle/. Both are found by walking up.
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    `${dir}/../../../../schema.sql`, // from dist/
    `${dir}/../../../schema.sql`, // from src/infrastructure/persistence/
    `${dir}/../../schema.sql`, // from src/infrastructure/
    `${dir}/../schema.sql`, // from src/infrastructure/persistence/drizzle/
    `${dir}/schema.sql`, // from next to file (bun run directly)
  ];

  let schemaSql: string | null = null;
  for (const p of candidates) {
    try {
      schemaSql = await readFile(p, 'utf8');
      break;
    } catch {
      // Not a candidate that exists — try the next path.
    }
  }

  if (!schemaSql) {
    logger.error(`Migration failed: schema.sql not found (tried ${candidates.join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(config.databaseUrl, { max: 1 });

  try {
    await sql.unsafe(schemaSql);
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
