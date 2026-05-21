import { createReadStream, unlinkSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { db, files as fileSchema } from '../db';
import { findFileByHash } from '../db/files';
import type { NewFile } from '../db/schema';
import { config } from '../env';
import {
  buildUploadResponse,
  checkFileSize,
  computeHash,
  ensureExtension,
  extractMimeType,
  getErrorMessage,
  getFileType,
} from '../utils/file';
import logger from '../utils/logger';
import { forwardToStorage, getBot } from '../utils/telegram';

type UploadedFile = NewFile & {
  createdAt: Date;
  updatedAt: Date;
};

type TelegramFileLookup = {
  mime_type?: string;
  file_size?: number;
};

interface JsonUploadPayload {
  file?: unknown;
  fileName?: string;
}

const parseBase64File = (file: string): { base64Data: string; mimeType: string } => {
  if (!file.startsWith('data:')) {
    return { base64Data: file, mimeType: 'application/octet-stream' };
  }

  const match = file.match(/^data:([^;]+);base64,(.+)$/);
  return match
    ? { base64Data: match[2], mimeType: match[1] }
    : { base64Data: file, mimeType: 'application/octet-stream' };
};

const normalizeFileType = (mimeType: string, fileName: string): string => {
  const fileType = getFileType(mimeType, fileName);
  return fileType === 'application' ? 'document' : fileType;
};

const performUpload = async (
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<UploadedFile> => {
  const tempPath = `/tmp/teleuploader-${nanoid()}`;
  try {
    await Bun.write(tempPath, fileBuffer);
    const fileStream = createReadStream(tempPath);
    const result = await forwardToStorage(fileStream, fileName, getFileType(mimeType, fileName));
    const bot = getBot();
    const fileInfo = (await bot.telegram.getFile(result.telegramFileId)) as TelegramFileLookup;

    return {
      publicId: nanoid(),
      telegramFileId: result.telegramFileId,
      telegramFileUniqueId: result.telegramFileUniqueId,
      storageChatId: config.storageChatId,
      storageMessageId: result.storageMessageId,
      fileName,
      mimeType: fileInfo.mime_type || mimeType || 'application/octet-stream',
      sizeBytes: fileInfo.file_size || fileBuffer.byteLength,
      fileType: getFileType(mimeType, fileName),
      uploaderId: 0,
      fileHash: computeHash(fileBuffer),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  } finally {
    setTimeout(() => {
      try {
        unlinkSync(tempPath);
      } catch {}
    }, 50);
  }
};

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
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('Upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};

const handleMultipartUpload = async (req: Request): Promise<Response> => {
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

    const existingFile = await findFileByHash(hash);
    if (existingFile) {
      return Response.json(buildUploadResponse(existingFile, config.baseUrl), { status: 200 });
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

    const uploaded = await performUpload(fileBuffer, finalFileName, mimeType);
    await db.insert(fileSchema).values(uploaded);

    return Response.json(buildUploadResponse(uploaded, config.baseUrl), { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('Multipart upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};

const handleJSONUpload = async (req: Request): Promise<Response> => {
  try {
    const { file, fileName = 'file' } = (await req.json()) as JsonUploadPayload;

    if (!file || typeof file !== 'string') {
      return Response.json(
        { error: 'Invalid JSON. Must include "file" (base64) and optional "fileName"' },
        { status: 400 },
      );
    }

    const { base64Data, mimeType: rawMimeType } = parseBase64File(file);
    const fileBytes = Buffer.from(base64Data, 'base64');
    const hash = computeHash(fileBytes);

    const existingFile = await findFileByHash(hash);
    if (existingFile) {
      return Response.json(buildUploadResponse(existingFile, config.baseUrl), { status: 200 });
    }

    const { fileName: finalFileName, mimeType } = ensureExtension(fileName, fileBytes, rawMimeType);
    const fileType = normalizeFileType(mimeType, finalFileName);

    if (!checkFileSize(fileBytes.byteLength, fileType)) {
      return Response.json({ error: `File size exceeds ${fileType} limit` }, { status: 400 });
    }

    const uploaded = await performUpload(fileBytes, finalFileName, mimeType);
    await db.insert(fileSchema).values(uploaded);

    return Response.json(buildUploadResponse(uploaded, config.baseUrl), { status: 200 });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error('JSON upload error', { error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};
