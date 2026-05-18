import { Telegraf } from 'telegraf';
import { config } from '../env';
import logger from './logger';
import { enqueueUpload } from './telegramQueue';

const botTokens = Array.from(new Set([config.botToken, ...config.additionalBotTokens]));

const bots = botTokens.map((token) => new Telegraf(token));
const TELEGRAM_API_URL = `https://api.telegram.org/bot${config.botToken}/`;

let currentBotIndex = 0;

const executeWithBotRetry = async (
  action: (botInstance: Telegraf) => Promise<any>,
  retries = 5,
  attemptedBots = 0,
): Promise<any> => {
  const currentBot = bots[currentBotIndex];
  try {
    return await action(currentBot);
  } catch (error: any) {
    const errorStr = error.message || String(error);
    const match = errorStr.match(/retry after (\d+)/i);

    if (match) {
      // 429 rate limit hit! Rotate bot index instantly
      const prevIndex = currentBotIndex;
      currentBotIndex = (currentBotIndex + 1) % bots.length;
      const nextIndex = currentBotIndex;
      attemptedBots++;

      if (attemptedBots < bots.length) {
        logger.info(
          `Bot Index ${prevIndex} hit 429. Instantly rotating to Bot Index ${nextIndex}...`,
        );
        return executeWithBotRetry(action, retries, attemptedBots);
      }

      // If all bots in the pool have been tried and hit 429, sleep
      if (retries > 0) {
        const seconds = parseInt(match[1], 10);
        logger.warn(`All bots in the pool are rate-limited. Sleeping for ${seconds} seconds...`, {
          error: errorStr,
        });
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return executeWithBotRetry(action, retries - 1, 0);
      }
    }
    throw error;
  }
};

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
    const result: any = await enqueueUpload(async () => {
      const filePayload = { source: fileChunk, filename: fileName };
      const uploadResult = await executeWithBotRetry((activeBot) => {
        if (fileType === 'photo') {
          return activeBot.telegram.sendPhoto(config.storageChatId, filePayload, {
            caption: fileName,
          });
        } else if (fileType === 'audio') {
          return activeBot.telegram.sendAudio(config.storageChatId, filePayload, {
            caption: fileName,
          });
        } else if (fileType === 'video') {
          return activeBot.telegram.sendVideo(config.storageChatId, filePayload, {
            caption: fileName,
          });
        } else if (fileType === 'voice') {
          return activeBot.telegram.sendVoice(config.storageChatId, filePayload, {
            caption: fileName,
          });
        } else if (fileType === 'animation') {
          return activeBot.telegram.sendAnimation(config.storageChatId, filePayload, {
            caption: fileName,
          });
        } else if (fileType === 'sticker') {
          return activeBot.telegram.sendSticker(config.storageChatId, filePayload);
        } else {
          return activeBot.telegram.sendDocument(config.storageChatId, filePayload, {
            caption: `📁 ${fileName}`,
          });
        }
      });

      // Advance round-robin index for next job
      currentBotIndex = (currentBotIndex + 1) % bots.length;

      return uploadResult;
    });

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

export interface MediaGroupItem {
  fileId: string;
  fileName: string;
  fileType: string;
}

export const forwardMediaGroupToStorage = async (
  items: MediaGroupItem[],
): Promise<{
  storageMessageId: number;
  telegramFileIds: string[];
  telegramFileUniqueIds: string[];
}> => {
  try {
    const result: any = await enqueueUpload(async () => {
      const mediaGroup: any = items.map((item) => {
        let type: 'photo' | 'video' | 'audio' | 'document' = 'document';
        if (item.fileType === 'photo') type = 'photo';
        else if (item.fileType === 'video') type = 'video';
        else if (item.fileType === 'audio') type = 'audio';

        return {
          type,
          media: item.fileId,
          caption: item.fileName,
        };
      });

      const uploadResult = await executeWithBotRetry((activeBot) => {
        return activeBot.telegram.sendMediaGroup(config.storageChatId, mediaGroup);
      });

      currentBotIndex = (currentBotIndex + 1) % bots.length;

      return uploadResult;
    });

    const messages = Array.isArray(result) ? result : [result];
    const storageMessageId = messages[0]?.message_id || 0;

    const telegramFileIds: string[] = [];
    const telegramFileUniqueIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const fileType = items[i]?.fileType || 'document';
      let uploadedFile: any;

      if (msg.document) uploadedFile = msg.document;
      else if (msg.photo) uploadedFile = msg.photo?.slice(-1)[0];
      else if (msg.video) uploadedFile = msg.video;
      else if (msg.audio) uploadedFile = msg.audio;
      else if (msg.voice) uploadedFile = msg.voice;
      else if (msg.animation) uploadedFile = msg.animation;
      else if (msg.sticker) uploadedFile = msg.sticker;
      else if (msg.video_note) uploadedFile = msg.video_note;
      else uploadedFile = msg[fileType];

      telegramFileIds.push(uploadedFile?.file_id || '');
      telegramFileUniqueIds.push(uploadedFile?.file_unique_id || '');
    }

    return {
      storageMessageId,
      telegramFileIds,
      telegramFileUniqueIds,
    };
  } catch (error: any) {
    logger.error('Failed to forward media group to storage', { error: error.message });
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

export const getBot = (): Telegraf => bots[0];
