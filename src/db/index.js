import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import logger from '../utils/logger.js';
import { files } from './schema.js';

const client = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10
});

export const db = drizzle(client, { schema: { files } });
export { files };
export default db;