import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { type Context, Telegraf } from 'telegraf';
import { db, files as fileSchema } from './db';
import { config } from './env';
import logger from './utils/logger';
import { forwardToStorage } from './utils/telegram';

interface MediaGroupBufferItem {
  ctx: any;
  fileId: string;
  fileSize: number;
  mimeType: string;
  fileName: string;
  fileType: string;
  fileUniqueId: string;
}

const mediaGroupCache = new Map<string, { timer: any; items: MediaGroupBufferItem[] }>();

export const startBot = async (): Promise<Telegraf<Context>> => {
  try {
    const bot = new Telegraf(config.botToken);

    bot.command('start', async (ctx) => {
      await ctx.reply(
        `👋 Halo! Kirimkan file (document, photo, video, audio, voice, animation) ke bot ini. ` +
          `File akan disimpan di private channel dan kamu dapat download link permanen.`,
      );
    });

    // Cast bot.on elements individually or explicitly as any to bypass Telegraf v4 typescript deprecation warnings on array syntax
    (bot as any).on(
      ['document', 'photo', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note'],
      async (ctx: any) => {
        try {
          const fileType:
            | 'document'
            | 'photo'
            | 'video'
            | 'audio'
            | 'voice'
            | 'animation'
            | 'sticker'
            | 'video_note' = ctx.message.document
            ? 'document'
            : ctx.message.photo
              ? 'photo'
              : ctx.message.video
                ? 'video'
                : ctx.message.audio
                  ? 'audio'
                  : ctx.message.voice
                    ? 'voice'
                    : ctx.message.animation
                      ? 'animation'
                      : ctx.message.sticker
                        ? 'sticker'
                        : ctx.message.video_note
                          ? 'video_note'
                          : 'document';

          const fileObj =
            fileType === 'photo'
              ? ctx.message.photo.slice(-1)[0]
              : fileType === 'sticker'
                ? ctx.message.sticker
                : ctx.message[fileType];
          const { file_id, file_size, mime_type } = fileObj;
          const fileName =
            ctx.message.document?.file_name ||
            ctx.message.photo?.slice(-1)[0]?.file_name ||
            ctx.message.video?.file_name ||
            ctx.message.audio?.file_name ||
            ctx.message.voice?.file_name ||
            'file';

          const maxSize =
            fileType === 'photo'
              ? 10 * 1024 * 1024
              : fileType === 'audio'
                ? 200 * 1024 * 1024
                : fileType === 'voice'
                  ? 200 * 1024 * 1024
                  : 2 * 1024 * 1024 * 1024;

          if (file_size > maxSize) {
            return ctx.reply(`File size exceeds ${maxSize / (1024 * 1024)}MB limit`);
          }

          const mediaGroupId = ctx.message.media_group_id;

          if (mediaGroupId) {
            if (!mediaGroupCache.has(mediaGroupId)) {
              mediaGroupCache.set(mediaGroupId, { timer: null, items: [] });
            }

            const group = mediaGroupCache.get(mediaGroupId)!;

            if (group.timer) {
              clearTimeout(group.timer);
            }

            group.items.push({
              ctx,
              fileId: file_id,
              fileSize: file_size,
              mimeType: mime_type,
              fileName: fileName,
              fileType: fileType,
              fileUniqueId: fileObj.file_unique_id,
            });

            group.timer = setTimeout(async () => {
              mediaGroupCache.delete(mediaGroupId);

              try {
                const itemsToUpload: MediaGroupBufferItem[] = [];
                const responses: string[] = [];

                for (const item of group.items) {
                  const existing = await db
                    .select()
                    .from(fileSchema)
                    .where(eq(fileSchema.telegramFileUniqueId, item.fileUniqueId))
                    .limit(1);

                  if (existing && existing.length > 0) {
                    const url = `${config.baseUrl}/f/${existing[0].publicId}`;
                    responses.push(`File *${item.fileName}* sudah diupload! 📎\nDownload: ${url}`);
                  } else {
                    itemsToUpload.push(item);
                  }
                }

                if (itemsToUpload.length > 0) {
                  const uploadItems = itemsToUpload.map((item) => ({
                    fileId: item.fileId,
                    fileName: item.fileName,
                    fileType: item.fileType,
                  }));

                  const { forwardMediaGroupToStorage } = await import('./utils/telegram');
                  const batchResult = await forwardMediaGroupToStorage(uploadItems);

                  const dbInserts = [];
                  for (let i = 0; i < itemsToUpload.length; i++) {
                    const item = itemsToUpload[i];
                    const publicId = nanoid();
                    const uploaded = {
                      publicId,
                      telegramFileId: batchResult.telegramFileIds[i],
                      telegramFileUniqueId: batchResult.telegramFileUniqueIds[i],
                      storageChatId: config.storageChatId,
                      storageMessageId: batchResult.storageMessageId,
                      fileName: item.fileName,
                      mimeType: item.mimeType || 'application/octet-stream',
                      sizeBytes: item.fileSize,
                      fileType: item.fileType,
                      uploaderId: ctx.from.id,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    };

                    dbInserts.push(uploaded);
                    responses.push(
                      `File *${item.fileName}* berhasil diupload! 📎\nDownload: ${config.baseUrl}/f/${publicId}`,
                    );
                  }

                  if (dbInserts.length > 0) {
                    await db.insert(fileSchema).values(dbInserts);
                  }
                }

                await ctx.reply(responses.join('\n\n'));
                logger.info('Media group uploaded as batch', {
                  mediaGroupId,
                  totalFiles: group.items.length,
                  uploadedFiles: itemsToUpload.length,
                  uploader: ctx.from.id,
                });
              } catch (error: any) {
                logger.error('Failed to process media group batch', {
                  error: error.message,
                  mediaGroupId,
                });
                await ctx.reply('❌ Gagal mengupload beberapa file di media group.');
              }
            }, 600);

            return;
          }

          const existing = await db
            .select()
            .from(fileSchema)
            .where(eq(fileSchema.telegramFileUniqueId, fileObj.file_unique_id))
            .limit(1);

          if (existing && existing.length > 0) {
            const url = `${config.baseUrl}/f/${existing[0].publicId}`;
            await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
              reply_parameters: { message_id: ctx.message.message_id },
            });
            logger.info('Duplicate file detected in bot, returned existing link', {
              publicId: existing[0].publicId,
              fileType,
              fileName,
              uploader: ctx.from.id,
            });
            return;
          }

          const result = await forwardToStorage(file_id, fileName, fileType);
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
            updatedAt: new Date(),
          };

          await db.insert(fileSchema).values(uploaded);

          const url = `${config.baseUrl}/f/${publicId}`;
          await ctx.reply(`File berhasil diupload! 📎\n\nDownload: ${url}`, {
            reply_parameters: { message_id: ctx.message.message_id },
          });

          logger.info('File uploaded via bot', {
            publicId,
            fileType,
            fileName,
            uploader: ctx.from.id,
          });
        } catch (error: any) {
          logger.error('Bot file handler error', { error: error.message, chat_id: ctx.chat?.id });
          await ctx.reply('❌ Gagal mengupload file. Coba lagi nanti.');
        }
      },
    );

    bot.use((ctx, next) => {
      logger.info('Telegram event received', {
        type: (ctx.update as any).type,
        chat_id: ctx.chat?.id,
      });
      return next();
    });

    await bot.launch();

    logger.info('Telegram bot started', { botToken: `${config.botToken?.substring(0, 10)}...` });

    return bot;
  } catch (error: any) {
    logger.error('Failed to start bot', { error: error.message });
    throw error;
  }
};
