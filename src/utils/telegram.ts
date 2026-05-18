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
  fileType: string,
): Promise<ForwardResult> => {
  try {
    const filePayload = { source: fileChunk, filename: fileName };
    let result: any;

    if (fileType === 'photo') {
      result = await bot.telegram.sendPhoto(config.storageChatId, filePayload, {
        caption: fileName,
      });
    } else if (fileType === 'audio') {
      result = await bot.telegram.sendAudio(config.storageChatId, filePayload, {
        caption: fileName,
      });
    } else if (fileType === 'video') {
      result = await bot.telegram.sendVideo(config.storageChatId, filePayload, {
        caption: fileName,
      });
    } else if (fileType === 'voice') {
      result = await bot.telegram.sendVoice(config.storageChatId, filePayload, {
        caption: fileName,
      });
    } else if (fileType === 'animation') {
      result = await bot.telegram.sendAnimation(config.storageChatId, filePayload, {
        caption: fileName,
      });
    } else if (fileType === 'sticker') {
      result = await bot.telegram.sendSticker(config.storageChatId, filePayload);
    } else {
      result = await bot.telegram.sendDocument(config.storageChatId, filePayload, {
        caption: `📁 ${fileName}`,
      });
    }

    let uploadedFile: any;
    if (result.document) uploadedFile = result.document;
    else if (result.photo) uploadedFile = result.photo?.slice(-1)[0];
    else if (result.video) uploadedFile = result.video;
    else if (result.audio) uploadedFile = result.audio;
    else if (result.voice) uploadedFile = result.voice;
    else if (result.animation) uploadedFile = result.animation;
    else if (result.sticker) uploadedFile = result.sticker;
    else if (result.video_note) uploadedFile = result.video_note;
    else uploadedFile = result[fileType];

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
