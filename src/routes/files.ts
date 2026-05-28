import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { findFileByPublicId } from '../db/files';
import { fileInfoCache } from '../utils/cache';
import { formatCreatedAt, getErrorMessage } from '../utils/file';
import logger from '../utils/logger';
import { getBot } from '../utils/telegram';
import { locateZipEntry } from '../utils/zip';

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

const cleanupTempFile = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch (err) {
    logger.warn('Failed to cleanup temp file', { tempPath, error: getErrorMessage(err) });
  }
};

const sanitizeFilenameHeader = (fileName: string): string =>
  fileName.replace(/[\\"]/g, '').replace(/[\n\r]/g, '');

const fail = (status: number, error: string): Response =>
  Response.json({ error }, { status });

export const handleFileRedirect = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return fail(400, 'Missing file id');
    }

    const file = await findFileByPublicId(public_id);
    if (!file) {
      logger.warn('File not found', { public_id });
      return fail(404, 'File not found');
    }

    const archiveEntryName = file.archiveEntryName;
    if (archiveEntryName) {
      const archiveFileId = file.archiveTelegramFileId || file.telegramFileId;
      const archiveInfo = await getTelegramFileInfo(archiveFileId, public_id);
      const archiveResponse = await fetch(buildTelegramFileUrl(archiveInfo.file_path));

      if (!archiveResponse.ok) {
        logger.error('Archive download failed', { public_id, status: archiveResponse.status });
        return fail(500, 'Server error');
      }

      const tempZipPath = `/tmp/teleuploader-dl-${nanoid()}.zip`;
      await Bun.write(tempZipPath, archiveResponse);

      const loc = await locateZipEntry(tempZipPath, archiveEntryName);
      if (!loc) {
        await cleanupTempFile(tempZipPath);
        logger.error('Archive entry not found', { public_id, archiveEntryName });
        return fail(404, 'File not found');
      }

      const fileStream = createReadStream(tempZipPath, {
        start: loc.start,
        end: loc.start + loc.length - 1,
      });

      fileStream.on('close', () => {
        void cleanupTempFile(tempZipPath);
      });
      fileStream.on('error', () => {
        void cleanupTempFile(tempZipPath);
      });

      return new Response(fileStream as any, {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${sanitizeFilenameHeader(file.fileName)}"`,
          'Content-Length': String(loc.length),
        },
      });
    }

    const fileInfo = await getTelegramFileInfo(file.telegramFileId, public_id);
    const tgResponse = await fetch(buildTelegramFileUrl(fileInfo.file_path));

    if (!tgResponse.ok) {
      logger.error('File download failed', { public_id, status: tgResponse.status });
      return fail(502, 'Server error');
    }

    return new Response(tgResponse.body, {
      status: 200,
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${sanitizeFilenameHeader(file.fileName)}"`,
        'Content-Length': String(file.sizeBytes),
      },
    });
  } catch (error: unknown) {
    logger.error('File redirect error', { public_id, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};

export const handleFileInfo = async (req: RequestWithParams): Promise<Response> => {
  const public_id = req.params?.public_id;
  try {
    if (!public_id) {
      return fail(400, 'Missing file id');
    }

    const file = await findFileByPublicId(public_id);
    if (!file) {
      logger.warn('File not found', { public_id });
      return fail(404, 'File not found');
    }

    return Response.json(
      {
        public_id: file.publicId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        file_type: file.fileType,
        created_at: formatCreatedAt(file.createdAt),
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('File info error', { public_id, error: getErrorMessage(error) });
    return fail(500, 'Server error');
  }
};
