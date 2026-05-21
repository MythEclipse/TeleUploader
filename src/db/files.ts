import { eq } from 'drizzle-orm';
import { db, files as fileSchema } from './index';
import type { File } from './schema';

export const findFileByHash = async (hash: string): Promise<File | null> => {
  const result = await db.select().from(fileSchema).where(eq(fileSchema.fileHash, hash)).limit(1);
  return result[0] || null;
};

export const findFileByPublicId = async (publicId: string): Promise<File | null> => {
  const result = await db
    .select()
    .from(fileSchema)
    .where(eq(fileSchema.publicId, publicId))
    .limit(1);
  return result[0] || null;
};

export const findFileByUniqueId = async (telegramFileUniqueId: string): Promise<File | null> => {
  const result = await db
    .select()
    .from(fileSchema)
    .where(eq(fileSchema.telegramFileUniqueId, telegramFileUniqueId))
    .limit(1);
  return result[0] || null;
};
