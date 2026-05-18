import { createReadStream, unlinkSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, files as fileSchema } from '../db';
import { config } from '../env';
import {
  checkFileSize,
  computeHash,
  ensureExtension,
  extractMimeType,
  getFileType,
} from '../utils/file';
import logger from '../utils/logger';
import { forwardToStorage, getBot } from '../utils/telegram';

export const handleUpload = async (req: Request): Promise<Response> => {
  try {
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      return handleMultipartUpload(req);
    } else if (contentType.includes('application/json')) {
      return handleJSONUpload(req);
    }

    return Response.json(
      { error: 'Unsupported content type. Use multipart/form-data or application/json' },
      { status: 400 },
    );
  } catch (error: any) {
    logger.error('Upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
};

const handleMultipartUpload = async (req: Request): Promise<Response> => {
  let tempPath = '';
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const fileName =
      (formData.get('fileName') as string) || (file instanceof File ? file.name : null) || 'file';

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileBytes = await file.arrayBuffer();
    const fileBuffer = Buffer.from(fileBytes);
    const hash = computeHash(fileBuffer);

    // Check for duplicate in DB
    const existing = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.fileHash, hash))
      .limit(1);

    if (existing.length > 0) {
      const existingFile = existing[0];
      const responsePayload = {
        public_id: existingFile.publicId,
        telegram_file_id: existingFile.telegramFileId,
        telegram_file_unique_id: existingFile.telegramFileUniqueId,
        storage_chat_id: existingFile.storageChatId,
        storage_message_id: existingFile.storageMessageId,
        file_name: existingFile.fileName,
        mime_type: existingFile.mimeType,
        size_bytes: existingFile.sizeBytes,
        file_type: existingFile.fileType,
        uploader_id: existingFile.uploaderId,
        created_at:
          existingFile.createdAt instanceof Date
            ? existingFile.createdAt.toISOString()
            : new Date(existingFile.createdAt).toISOString(),
        download_url: `${config.baseUrl}/f/${existingFile.publicId}`,
      };
      return Response.json(responsePayload, { status: 200 });
    }

    const rawMimeType = file.type || extractMimeType({}, req) || 'application/octet-stream';
    const { fileName: finalFileName, mimeType } = ensureExtension(
      fileName,
      fileBuffer,
      rawMimeType,
    );
    const fileType = getFileType(mimeType, finalFileName);

    if (!checkFileSize(fileBuffer.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    // Write file to disk temporarily
    tempPath = `/tmp/teleuploader-${nanoid()}`;
    await Bun.write(tempPath, fileBuffer);

    const fileStream = createReadStream(tempPath);
    const result = await forwardToStorage(fileStream, finalFileName, fileType);
    const bot = getBot();
    const fileInfo = (await bot.telegram.getFile(result.telegramFileId)) as any;

    const uploaded = {
      publicId: nanoid(),
      telegramFileId: result.telegramFileId,
      telegramFileUniqueId: result.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: result.storageMessageId,
      fileName: finalFileName,
      mimeType: fileInfo.mime_type || mimeType || 'application/octet-stream',
      sizeBytes: fileInfo.file_size || fileBuffer.byteLength,
      fileType: fileType,
      uploaderId: 0,
      fileHash: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(fileSchema).values(uploaded);

    const responsePayload = {
      public_id: uploaded.publicId,
      telegram_file_id: uploaded.telegramFileId,
      telegram_file_unique_id: uploaded.telegramFileUniqueId,
      storage_chat_id: uploaded.storageChatId,
      storage_message_id: uploaded.storageMessageId,
      file_name: uploaded.fileName,
      mime_type: uploaded.mimeType,
      size_bytes: uploaded.sizeBytes,
      file_type: uploaded.fileType,
      uploader_id: uploaded.uploaderId,
      created_at: uploaded.createdAt.toISOString(),
      download_url: `${config.baseUrl}/f/${uploaded.publicId}`,
    };

    return Response.json(responsePayload, { status: 200 });
  } catch (error: any) {
    logger.error('Multipart upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  } finally {
    if (tempPath) {
      const p = tempPath;
      setTimeout(() => {
        try {
          unlinkSync(p);
        } catch {}
      }, 50);
    }
  }
};

const handleJSONUpload = async (req: Request): Promise<Response> => {
  let tempPath = '';
  try {
    const { file, fileName = 'file' } = (await req.json()) as any;

    if (!file || typeof file !== 'string') {
      return Response.json(
        { error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' },
        { status: 400 },
      );
    }

    let base64Data = file;
    let rawMimeType = 'application/octet-stream';
    if (file.startsWith('data:')) {
      const match = file.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        rawMimeType = match[1];
        base64Data = match[2];
      }
    }

    const fileBytes = Buffer.from(base64Data, 'base64');
    const hash = computeHash(fileBytes);

    // Check for duplicate in DB
    const existing = await db
      .select()
      .from(fileSchema)
      .where(eq(fileSchema.fileHash, hash))
      .limit(1);

    if (existing.length > 0) {
      const existingFile = existing[0];
      const responsePayload = {
        public_id: existingFile.publicId,
        telegram_file_id: existingFile.telegramFileId,
        telegram_file_unique_id: existingFile.telegramFileUniqueId,
        storage_chat_id: existingFile.storageChatId,
        storage_message_id: existingFile.storageMessageId,
        file_name: existingFile.fileName,
        mime_type: existingFile.mimeType,
        size_bytes: existingFile.sizeBytes,
        file_type: existingFile.fileType,
        uploader_id: existingFile.uploaderId,
        created_at:
          existingFile.createdAt instanceof Date
            ? existingFile.createdAt.toISOString()
            : new Date(existingFile.createdAt).toISOString(),
        download_url: `${config.baseUrl}/f/${existingFile.publicId}`,
      };
      return Response.json(responsePayload, { status: 200 });
    }

    const { fileName: finalFileName, mimeType } = ensureExtension(fileName, fileBytes, rawMimeType);
    const fileType =
      getFileType(mimeType, finalFileName) === 'application'
        ? 'document'
        : getFileType(mimeType, finalFileName);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    // Write file to disk temporarily
    tempPath = `/tmp/teleuploader-${nanoid()}`;
    await Bun.write(tempPath, fileBytes);

    const fileStream = createReadStream(tempPath);
    const result = await forwardToStorage(fileStream, finalFileName, fileType);
    const bot = getBot();
    const fileInfo = (await bot.telegram.getFile(result.telegramFileId)) as any;

    const uploaded = {
      publicId: nanoid(),
      telegramFileId: result.telegramFileId,
      telegramFileUniqueId: result.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: result.storageMessageId,
      fileName: finalFileName,
      mimeType: fileInfo.mime_type || mimeType || 'application/octet-stream',
      sizeBytes: fileInfo.file_size || fileBytes.byteLength,
      fileType: fileType,
      uploaderId: 0,
      fileHash: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(fileSchema).values(uploaded);

    const responsePayload = {
      public_id: uploaded.publicId,
      telegram_file_id: uploaded.telegramFileId,
      telegram_file_unique_id: uploaded.telegramFileUniqueId,
      storage_chat_id: uploaded.storageChatId,
      storage_message_id: uploaded.storageMessageId,
      file_name: uploaded.fileName,
      mime_type: uploaded.mimeType,
      size_bytes: uploaded.sizeBytes,
      file_type: uploaded.fileType,
      uploader_id: uploaded.uploaderId,
      created_at: uploaded.createdAt.toISOString(),
      download_url: `${config.baseUrl}/f/${uploaded.publicId}`,
    };

    return Response.json(responsePayload, { status: 200 });
  } catch (error: any) {
    logger.error('JSON upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  } finally {
    if (tempPath) {
      const p = tempPath;
      setTimeout(() => {
        try {
          unlinkSync(p);
        } catch {}
      }, 50);
    }
  }
};
