import { Telegraf } from 'telegraf';
import logger from './logger.js';
import { config } from '../env.js';

const bot = new Telegraf(config.botToken);
const TELEGRAM_API_URL = `https://api.telegram.org/bot${config.botToken}/`;

export const forwardToStorage = async (fileChunk, fileName, forceDocument = false) => {
  try {
    const caption = forceDocument ? `📁 ${fileName}` : fileName;
    const input = forceDocument ? { document: fileChunk, caption } : { photo: [fileChunk], caption };

    const result = await bot.api.sendPhoto(config.storageChatId, input);

    logger.info('File forwarded to storage', { fileName, message: result.message_id });

    return {
      telegramFileId: result.photo?.slice(-1)[0]?.file_id,
      telegramFileUniqueId: result.photo?.slice(-1)[0]?.file_unique_id,
      storageMessageId: result.message_id
    };
  } catch (error) {
    logger.error('Failed to forward file to storage', { fileName, error: error.message });
    throw error;
  }
};

export const getFileInfo = async (telegramFileId, telegramFileUniqueId) => {
  try {
    const result = await fetch(`${TELEGRAM_API_URL}getFile`);
    const data = await result.json();

    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    const fileId = data.result.file_id === telegramFileId ? telegramFileId : telegramFileUniqueId;
    const fileResult = await fetch(`${TELEGRAM_API_URL}getInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    });
    const fileInfo = await fileResult.json();

    if (!fileInfo.ok) {
      throw new Error(fileInfo.description || 'Telegram info error');
    }

    return {
      file_size: fileInfo.result.file_size,
      mime_type: fileInfo.result.mime_type,
      file_path: fileInfo.result.file_path
    };
  } catch (error) {
    logger.error('Failed to get file info', { error: error.message });
    throw error;
  }
};

export const getBot = () => bot;
