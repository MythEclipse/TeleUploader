import { sql } from 'drizzle-orm';
import { db } from '../db';
import logger from '../utils/logger';

export const handleHealth = async (_req: Request): Promise<Response> => {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch (error: any) {
    logger.error('Health check failed', { error: error.message });
    return Response.json({ status: 'error', error: error.message }, { status: 500 });
  }
};
