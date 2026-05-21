import { Telegraf } from 'telegraf';
import { config } from '../env';
import logger from './logger';
import { enqueueUpload } from './telegramQueue';

const botTokens = Array.from(new Set([config.botToken, ...config.additionalBotTokens]));

const bots = botTokens.map((token) => new Telegraf(token));
const TELEGRAM_API_URL = `https://api.telegram.org/bot${config.botToken}/`;

let currentBotIndex = 0;

const rotateBot = (): { previousIndex: number; nextIndex: number } => {
  const previousIndex = currentBotIndex;
  currentBotIndex = (currentBotIndex + 1) % bots.length;
  return { previousIndex, nextIndex: currentBotIndex };
};

const sleep = (seconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

const executeWithBotRetry = async <T>(
  action: (botInstance: Telegraf) => Promise<T>,
  retries = 5,
  attemptedBots = 0,
): Promise<T> => {
  const currentBot = bots[currentBotIndex];
  try {
    return await action(currentBot);
  } catch (error: unknown) {
    const errorStr = error instanceof Error ? error.message : String(error);
    const match = errorStr.match(/retry after (\d+)/i);

    if (match) {
      const { previousIndex, nextIndex } = rotateBot();
      attemptedBots++;

      if (attemptedBots < bots.length) {
        logger.info(
          `Bot Index ${previousIndex} hit 429. Instantly rotating to Bot Index ${nextIndex}...`,
        );
        return executeWithBotRetry(action, retries, attemptedBots);
      }

      // If all bots in the pool have been tried and hit 429, sleep
      if (retries > 0) {
        const seconds = parseInt(match[1], 10);
        logger.warn(`All bots in the pool are rate-limited. Sleeping for ${seconds} seconds...`, {
          error: errorStr,
        });
        await sleep(seconds);
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

interface TelegramGetFileResponse {
  ok: boolean;
  description?: string;
  result: {
    file_id: string;
  };
}

interface TelegramGetInfoResponse {
  ok: boolean;
  description?: string;
  result: TelegramFileInfo;
}

interface UploadedTelegramFile {
  file_id?: string;
  file_unique_id?: string;
}

interface TelegramMessageResult {
  message_id: number;
  document?: UploadedTelegramFile;
  photo?: UploadedTelegramFile[];
  video?: UploadedTelegramFile;
  audio?: UploadedTelegramFile;
  voice?: UploadedTelegramFile;
  animation?: UploadedTelegramFile;
  sticker?: UploadedTelegramFile;
  video_note?: UploadedTelegramFile;
  [key: string]: unknown;
}

type FilePayload = { source: unknown; filename: string };
type SendPayload = { caption?: string };
type SendMethod = (
  chatId: number,
  filePayload: FilePayload,
  payload?: SendPayload,
) => Promise<TelegramMessageResult>;

const sendMethodMap: Record<string, keyof Telegraf['telegram']> = {
  photo: 'sendPhoto',
  audio: 'sendAudio',
  video: 'sendVideo',
  voice: 'sendVoice',
  animation: 'sendAnimation',
  sticker: 'sendSticker',
  document: 'sendDocument',
  video_note: 'sendDocument',
};

const extractUploadedFile = (
  result: TelegramMessageResult,
  fileType: string,
): UploadedTelegramFile | undefined => {
  if (result.document) return result.document;
  if (result.photo) return result.photo?.slice(-1)[0];
  if (result.video) return result.video;
  if (result.audio) return result.audio;
  if (result.voice) return result.voice;
  if (result.animation) return result.animation;
  if (result.sticker) return result.sticker;
  if (result.video_note) return result.video_note;
  return result[fileType] as UploadedTelegramFile | undefined;
};

const buildSendPayload = (fileType: string, fileName: string): SendPayload => {
  const basePayload = { caption: fileName };
  if (fileType === 'sticker') return {};
  if (fileType === 'document') return { caption: `📁 ${fileName}` };
  return basePayload;
};

const getMediaGroupType = (fileType: string): string => {
  if (fileType === 'photo') return 'photo';
  if (fileType === 'video') return 'video';
  if (fileType === 'audio') return 'audio';
  return 'document';
};

interface MediaGroupPayloadItem {
  type: string;
  media: string;
  caption: string;
}

const buildMediaGroup = (items: MediaGroupItem[]): MediaGroupPayloadItem[] => {
  return items.map((item) => ({
    type: getMediaGroupType(item.fileType),
    media: item.fileId,
    caption: item.fileName,
  }));
};

export const forwardToStorage = async (
  fileChunk: unknown,
  fileName: string,
  fileType: string,
): Promise<ForwardResult> => {
  try {
    const result = await enqueueUpload(async (): Promise<TelegramMessageResult> => {
      const filePayload = { source: fileChunk, filename: fileName };
      const sendMethod = sendMethodMap[fileType] || 'sendDocument';
      const payload = buildSendPayload(fileType, fileName);

      const uploadResult = await executeWithBotRetry((activeBot) => {
        const telegram = activeBot.telegram as unknown as Record<string, SendMethod>;
        return telegram[sendMethod](config.storageChatId, filePayload, payload);
      });

      currentBotIndex = (currentBotIndex + 1) % bots.length;
      return uploadResult;
    });

    const uploadedFile = extractUploadedFile(result, fileType);
    logger.info('File forwarded to storage', { fileName, message: result.message_id });

    return {
      telegramFileId: uploadedFile?.file_id || '',
      telegramFileUniqueId: uploadedFile?.file_unique_id || '',
      storageMessageId: result.message_id,
    };
  } catch (error: unknown) {
    logger.error('Failed to forward file to storage', {
      fileName,
      error: error instanceof Error ? error.message : String(error),
    });
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
    const result = await enqueueUpload(async (): Promise<TelegramMessageResult[]> => {
      const mediaGroup = buildMediaGroup(items);

      const uploadResult = await executeWithBotRetry((activeBot) => {
        const sendMediaGroup = activeBot.telegram.sendMediaGroup as unknown as (
          chatId: number,
          media: MediaGroupPayloadItem[],
        ) => Promise<TelegramMessageResult[]>;
        return sendMediaGroup(config.storageChatId, mediaGroup);
      });

      currentBotIndex = (currentBotIndex + 1) % bots.length;
      return uploadResult;
    });

    const messages = Array.isArray(result) ? result : [result];
    const storageMessageId = messages[0]?.message_id || 0;

    const telegramFileIds: string[] = [];
    const telegramFileUniqueIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const uploadedFile = extractUploadedFile(messages[i], items[i]?.fileType || 'document');
      telegramFileIds.push(uploadedFile?.file_id || '');
      telegramFileUniqueIds.push(uploadedFile?.file_unique_id || '');
    }

    return {
      storageMessageId,
      telegramFileIds,
      telegramFileUniqueIds,
    };
  } catch (error: unknown) {
    logger.error('Failed to forward media group to storage', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const getFileInfo = async (
  telegramFileId: string,
  telegramFileUniqueId: string,
): Promise<TelegramFileInfo> => {
  try {
    const result = await fetch(`${TELEGRAM_API_URL}getFile`);
    const data = (await result.json()) as TelegramGetFileResponse;

    if (!data.ok) {
      throw new Error(data.description || 'Telegram API error');
    }

    const fileId = data.result.file_id === telegramFileId ? telegramFileId : telegramFileUniqueId;
    const fileResult = await fetch(`${TELEGRAM_API_URL}getInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const fileInfo = (await fileResult.json()) as TelegramGetInfoResponse;

    if (!fileInfo.ok) {
      throw new Error(fileInfo.description || 'Telegram info error');
    }

    return {
      file_size: fileInfo.result.file_size,
      mime_type: fileInfo.result.mime_type,
      file_path: fileInfo.result.file_path,
    };
  } catch (error: unknown) {
    logger.error('Failed to get file info', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const getBot = (): Telegraf => bots[0];
