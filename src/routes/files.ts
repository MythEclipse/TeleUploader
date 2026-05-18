import { eq } from 'drizzle-orm';
import { db, files as fileSchema } from '../db';
import logger from '../utils/logger';
import { checkRateLimit } from '../utils/rateLimit';

type RequestWithParams = Request & {
  params?: {
    public_id?: string;
  };
};

export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (!public_id || !checkRateLimit(ip)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const result = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.publicId, public_id))
      .limit(1);

    if (!result.length) {
      logger.warn('File not found', { public_id });
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const file = result[0];
    const { getBot } = await import('../utils/telegram');
    const bot = getBot();
    const fileInfo = await bot.telegram.getFile(file.telegramFileId);

    const redirectUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
      },
    });
  } catch (error: any) {
    logger.error('File redirect error', { public_id, error: error.message });
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
};

export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return Response.json({ error: 'Missing file id' }, { status: 400 });
    }

    const result = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.publicId, public_id))
      .limit(1);

    if (!result.length) {
      logger.warn('File not found', { public_id });
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const file = result[0];
    return Response.json(
      {
        public_id: file.publicId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        file_type: file.fileType,
        uploader_id: file.uploaderId,
        created_at:
          typeof file.createdAt === 'string'
            ? file.createdAt
            : (file.createdAt as Date).toISOString(),
      },
      { status: 200 },
    );
  } catch (error: any) {
    logger.error('File info error', { public_id, error: error.message });
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
};
