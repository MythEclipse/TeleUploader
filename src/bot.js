import { Telegraf } from 'telegraf';
import logger from './utils/logger.js';
import { config } from './env.js';
import { db, files as fileSchema } from './db/index.js';
import { nanoid } from 'nanoid';
import { forwardToStorage } from './utils/telegram.js';

export const startBot = async () => {
  try {
    const bot = new Telegraf(config.botToken);

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Halo! Kirimkan file (document, photo, video, audio, voice, animation) ke bot ini. ` +
        `File akan disimpan di private channel dan kamu dapat download link permanen.`
      );
    });

    bot.on(['document', 'photo', 'video', 'audio', 'voice', 'animation'], async (ctx) => {
      try {
        const fileType = ctx.message.document ? 'document' :
                        ctx.message.photo ? 'photo' :
                        ctx.message.video ? 'video' :
                        ctx.message.audio ? 'audio' :
                        ctx.message.voice ? 'voice' : 'animation';

        const fileObj = fileType === 'photo' ? ctx.message.photo.slice(-1)[0] : ctx.message[fileType];
        const { file_id, file_unique_id, file_size, mime_type } = fileObj;
        const fileName = ctx.message.document?.file_name ||
                        ctx.message.photo?.slice(-1)[0]?.file_name ||
                        ctx.message.video?.file_name ||
                        ctx.message.audio?.file_name ||
                        ctx.message.voice?.file_name ||
                        'file';

        const maxSize = fileType === 'photo' ? 10 * 1024 * 1024 :
                       fileType === 'audio' ? 200 * 1024 * 1024 :
                       fileType === 'voice' ? 200 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;

        if (file_size > maxSize) {
          return ctx.reply(`File size exceeds ${maxSize / (1024 * 1024)}MB limit`);
        }

        const result = await forwardToStorage(file_id, fileName);
        const publicId = nanoid();

        const uploaded = {
          public_id: publicId,
          telegram_file_id: result.telegramFileId,
          telegram_file_unique_id: result.telegramFileUniqueId,
          storage_chat_id: config.storageChatId,
          storage_message_id: result.storageMessageId,
          file_name: fileName,
          mime_type: mime_type,
          size_bytes: file_size,
          file_type: fileType,
          uploader_id: ctx.from.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await db.insert(fileSchema).values(uploaded);

        const url = `${config.baseUrl}/f/${publicId}`;
        await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
          reply_parameters: { message_id: ctx.message.message_id }
        });

        logger.info('File uploaded via bot', { publicId, fileType, fileName, uploader: ctx.from.id });
      } catch (error) {
        logger.error('Bot file handler error', { error: error.message, chat_id: ctx.chat?.id });
        await ctx.reply('❌ Gagal mengupload file. Coba lagi nanti.');
      }
    });

    bot.use((ctx, next) => {
      logger.info('Telegram event received', { type: ctx.update.type, chat_id: ctx.chat?.id });
      return next();
    });

    await bot.launch();

    logger.info('Telegram bot started', { botToken: config.botToken?.substring(0, 10) + '...' });

    return bot;
  } catch (error) {
    logger.error('Failed to start bot', { error: error.message });
    throw error;
  }
};
