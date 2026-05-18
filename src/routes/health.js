import logger from '../utils/logger.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export const handleHealth = async (req) => {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    return Response.json({ status: 'error', error: error.message }, { status: 500 });
  }
};
