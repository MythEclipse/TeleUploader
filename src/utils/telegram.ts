import { Telegraf } from 'telegraf';
import { config } from '../env';
import logger from './logger';

const bot = new Telegraf(config.botToken);
const TELEGRAM_API_URL = `https://api.telegram.org/bot${config.botToken}/`;

interface ForwardResult {
  telegramFileId: string;
  telegramFileUniqueId: string;
  storageMessageId: number;
}

interface TelegramFileInfo {
  file_size: number;
  mime_type: string;
  file_path: string;
}

export const forwardToStorage = async (
  fileChunk: any,
  fileName: string,
  forceDocument = false,
): Promise<ForwardResult> => {
  try {
    const caption = forceDocument ? `📁 ${fileName}` : fileName;
    const filePayload = { source: fileChunk, filename: fileName };
    const result: any = forceDocument
      ? await bot.telegram.sendDocument(config.storageChatId, filePayload, { caption })
      : await bot.telegram.sendPhoto(config.storageChatId, filePayload, { caption });
    const uploadedFile = forceDocument ? result.document : result.photo?.slice(-1)[0];

    logger.info('File forwarded to storage', { fileName, message: result.message_id });

    return {
      telegramFileId: uploadedFile?.file_id || '',
      telegramFileUniqueId: uploadedFile?.file_unique_id || '',
      storageMessageId: result.message_id,
    };
  } catch (error: any) {
    logger.error('Failed to forward file to storage', { fileName, error: error.message });
    throw error;
  }
};

export const getFileInfo = async (
  telegramFileId: string,
  telegramFileUniqueId: string,
): Promise<TelegramFileInfo> => {
  try {
    const result = await fetch(`${TELEGRAM_API_URL}getFile`);
    const data: any = await result.json();

    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    const fileId = data.result.file_id === telegramFileId ? telegramFileId : telegramFileUniqueId;
    const fileResult = await fetch(`${TELEGRAM_API_URL}getInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const fileInfo: any = await fileResult.json();

    if (!fileInfo.ok) {
      throw new Error(fileInfo.description || 'Telegram info error');
    }

    return {
      file_size: fileInfo.result.file_size,
      mime_type: fileInfo.result.mime_type,
      file_path: fileInfo.result.file_path,
    };
  } catch (error: any) {
    logger.error('Failed to get file info', { error: error.message });
    throw error;
  }
};

export const getBot = (): Telegraf => bot;
