import { sql } from 'drizzle-orm';
import { db } from '../db';
import { getErrorMessage } from '../utils/file';
import logger from '../utils/logger';

export const handleHealth = async (_req: Request): Promise<Response> => {
  try {
    await db.execute(sql`SELECT 1`);
    return Response.json({ status: 'ok' }, { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('Health check failed', { error: message });
    return Response.json({ status: 'error', error: message }, { status: 500 });
  }
};
