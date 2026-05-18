import logger from '../utils/logger';
import { db, files as fileSchema } from '../db';
import { nanoid } from 'nanoid';
import { forwardToStorage, getBot } from '../utils/telegram';
import { getFileType, checkFileSize, extractMimeType } from '../utils/file';
import { config } from '../env';

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
      { status: 400 }
    );
  } catch (error: any) {
    logger.error('Upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
};

const handleMultipartUpload = async (req: Request): Promise<Response> => {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const fileName = (formData.get('fileName') as string) || (file instanceof File ? file.name : null) || 'file';

    if (!file || !(file instanceof File)) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileBytes = await file.arrayBuffer();
    const fileBuffer = Buffer.from(fileBytes);
    const mimeType = file.type || extractMimeType({}, req) || 'application/octet-stream';
    const fileType = getFileType(mimeType, fileName);

    if (!checkFileSize(fileBuffer.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const isDocument = fileName.endsWith('.pdf') || fileName.endsWith('.txt') || !['photo', 'video', 'audio', 'voice', 'animation'].includes(fileType);
    const result = await forwardToStorage(fileBuffer, fileName, isDocument);
    const bot = getBot();
    const fileInfo = (await bot.telegram.getFile(result.telegramFileId)) as any;

    const uploaded = {
      publicId: nanoid(),
      telegramFileId: result.telegramFileId,
      telegramFileUniqueId: result.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: result.storageMessageId,
      fileName: fileName,
      mimeType: fileInfo.mime_type || mimeType || 'application/octet-stream',
      sizeBytes: fileInfo.file_size || fileBuffer.byteLength,
      fileType: fileType,
      uploaderId: 0,
      createdAt: new Date(),
      updatedAt: new Date()
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
      download_url: `${config.baseUrl}/f/${uploaded.publicId}`
    };

    return Response.json(responsePayload, { status: 200 });
  } catch (error: any) {
    logger.error('Multipart upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
};

const handleJSONUpload = async (req: Request): Promise<Response> => {
  try {
    const { file, fileName = 'file' } = (await req.json()) as any;

    if (!file || typeof file !== 'string') {
      return Response.json(
        { error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' },
        { status: 400 }
      );
    }

    const fileBytes = Buffer.from(file, 'base64');
    const mimeType = 'application/octet-stream';
    const fileType = getFileType(mimeType, fileName) === 'application' ? 'document' : getFileType(mimeType, fileName);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const isDocument = fileName.endsWith('.pdf') || fileName.endsWith('.txt') || !['photo', 'video', 'audio', 'voice', 'animation'].includes(fileType);
    const result = await forwardToStorage(fileBytes, fileName, isDocument);
    const bot = getBot();
    const fileInfo = (await bot.telegram.getFile(result.telegramFileId)) as any;

    const uploaded = {
      publicId: nanoid(),
      telegramFileId: result.telegramFileId,
      telegramFileUniqueId: result.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: result.storageMessageId,
      fileName: fileName,
      mimeType: fileInfo.mime_type || mimeType || 'application/octet-stream',
      sizeBytes: fileInfo.file_size || fileBytes.byteLength,
      fileType: fileType,
      uploaderId: 0,
      createdAt: new Date(),
      updatedAt: new Date()
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
      download_url: `${config.baseUrl}/f/${uploaded.publicId}`
    };

    return Response.json(responsePayload, { status: 200 });
  } catch (error: any) {
    logger.error('JSON upload error', { error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
};
