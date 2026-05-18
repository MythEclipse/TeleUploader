import postgres from 'postgres';
import { config } from '../env';
import logger from '../utils/logger';

const schemaSql = await Bun.file('schema.sql').text();
const sql = postgres(config.databaseUrl, { max: 1 });

try {
  await sql.unsafe(schemaSql);
  logger.info('Database migration completed');
} catch (error: any) {
  logger.error('Database migration failed', { error: error.message });
  process.exitCode = 1;
} finally {
  await sql.end();
}
