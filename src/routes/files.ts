import { findFileByPublicId } from '../db/files';
import { fileInfoCache } from '../utils/cache';
import { formatCreatedAt, getErrorMessage } from '../utils/file';
import logger from '../utils/logger';
import { checkRateLimit } from '../utils/rateLimit';
import { getBot } from '../utils/telegram';
import { extractZipEntry } from '../utils/zip';

type RequestWithParams = Request & {
  params?: {
    public_id?: string;
  };
};

const getTelegramFileInfo = async (telegramFileId: string, public_id: string) => {
  const cacheKey = `file_info_${telegramFileId}`;
  let fileInfo = fileInfoCache.get(cacheKey);

  if (!fileInfo) {
    const bot = getBot();
    const apiFileInfo = await bot.telegram.getFile(telegramFileId);
    fileInfo = {
      file_size: (apiFileInfo as any).file_size || 0,
      mime_type: (apiFileInfo as any).mime_type || 'application/octet-stream',
      file_path: (apiFileInfo as any).file_path || '',
    };
    fileInfoCache.set(cacheKey, fileInfo);
    logger.debug('File info cached', { public_id, cacheKey });
  } else {
    logger.debug('File info from cache', { public_id, cacheKey });
  }

  return fileInfo;
};

const buildTelegramFileUrl = (filePath: string): string =>
  `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;

export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (!public_id || !checkRateLimit(ip)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const file = await findFileByPublicId(public_id);

    if (!file) {
      logger.warn('File not found', { public_id });
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const archiveEntryName = file.archiveEntryName;
    if (archiveEntryName) {
      const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
      const archiveInfo = await getTelegramFileInfo(archiveFileId, public_id);
      const archiveResponse = await fetch(buildTelegramFileUrl(archiveInfo.file_path));

      if (!archiveResponse.ok) {
        logger.error('Archive download failed', { public_id, status: archiveResponse.status });
        return Response.json({ error: 'Server error' }, { status: 500 });
      }

      const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
      const extractedFile = await extractZipEntry(archiveBuffer, archiveEntryName);
      if (!extractedFile) {
        logger.error('Archive entry not found', { public_id, archiveEntryName });
        return Response.json({ error: 'File not found' }, { status: 404 });
      }

      return new Response(extractedFile, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType,
          'Content-Disposition': `attachment; filename="${file.fileName.replace(/"/g, '')}"`,
          'Content-Length': String(extractedFile.byteLength),
        },
      });
    }

    const fileInfo = await getTelegramFileInfo(file.telegramFileId, public_id);
    const redirectUrl = buildTelegramFileUrl(fileInfo.file_path);
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
      },
    });
  } catch (error: unknown) {
    logger.error('File redirect error', { public_id, error: getErrorMessage(error) });
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
};

export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return Response.json({ error: 'Missing file id' }, { status: 400 });
    }

    const file = await findFileByPublicId(public_id);

    if (!file) {
      logger.warn('File not found', { public_id });
      return Response.json({ error: 'File not found' }, { status: 404 });
    }
    return Response.json(
      {
        public_id: file.publicId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        file_type: file.fileType,
        uploader_id: file.uploaderId,
        created_at: formatCreatedAt(file.createdAt),
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('File info error', { public_id, error: getErrorMessage(error) });
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
};
