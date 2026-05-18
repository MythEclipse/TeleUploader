import { Telegraf, type Context } from 'telegraf';
import logger from './utils/logger';
import { config } from './env';
import { db, files as fileSchema } from './db';
import { nanoid } from 'nanoid';
import { forwardToStorage } from './utils/telegram';

export const startBot = async (): Promise<Telegraf<Context>> => {
  try {
    const bot = new Telegraf(config.botToken);

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Halo! Kirimkan file (document, photo, video, audio, voice, animation) ke bot ini. ` +
        `File akan disimpan di private channel dan kamu dapat download link permanen.`
      );
    });

    // Cast bot.on elements individually or explicitly as any to bypass Telegraf v4 typescript deprecation warnings on array syntax
    (bot as any).on(['document', 'photo', 'video', 'audio', 'voice', 'animation'], async (ctx: any) => {
      try {
        const fileType: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' = ctx.message.document ? 'document' :
                        ctx.message.photo ? 'photo' :
                        ctx.message.video ? 'video' :
                        ctx.message.audio ? 'audio' :
                        ctx.message.voice ? 'voice' : 'animation';

        const fileObj = fileType === 'photo' ? ctx.message.photo.slice(-1)[0] : ctx.message[fileType];
        const { file_id, file_size, mime_type } = fileObj;
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
          publicId: publicId,
          telegramFileId: result.telegramFileId,
          telegramFileUniqueId: result.telegramFileUniqueId,
          storageChatId: config.storageChatId,
          storageMessageId: result.storageMessageId,
          fileName: fileName,
          mimeType: mime_type || 'application/octet-stream',
          sizeBytes: file_size,
          fileType: fileType,
          uploaderId: ctx.from.id,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        await db.insert(fileSchema).values(uploaded);

        const url = `${config.baseUrl}/f/${publicId}`;
        await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
          reply_parameters: { message_id: ctx.message.message_id }
        });

        logger.info('File uploaded via bot', { publicId, fileType, fileName, uploader: ctx.from.id });
      } catch (error: any) {
        logger.error('Bot file handler error', { error: error.message, chat_id: ctx.chat?.id });
        await ctx.reply('❌ Gagal mengupload file. Coba lagi nanti.');
      }
    });

    bot.use((ctx, next) => {
      logger.info('Telegram event received', { type: (ctx.update as any).type, chat_id: ctx.chat?.id });
      return next();
    });

    await bot.launch();

    logger.info('Telegram bot started', { botToken: config.botToken?.substring(0, 10) + '...' });

    return bot;
  } catch (error: any) {
    logger.error('Failed to start bot', { error: error.message });
    throw error;
  }
};
