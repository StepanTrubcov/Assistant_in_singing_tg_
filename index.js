import { Telegraf } from "telegraf";
import express from 'express';
import FormData from 'form-data';
import axios from 'axios';
import { createWriteStream, createReadStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Инициализация Express
const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// Определение порта (добавлено исправление)
const PORT = process.env.PORT || 3000;

// Конфигурация
ffmpeg.setFfmpegPath(ffmpegStatic);
const token = '7832405095:AAH-wtOOLUNJJ7Z5N8lDzBtnmmQpn-lHd0I';
const bot = new Telegraf(token);

// Настройки сервера
const SERVER_URLS = ['https://bek-bot.onrender.com'];
const MAIN_USER_ID = 5102803347;
const users = [7779459253];

// Создаем необходимые директории
const tempDir = join(__dirname, 'temp');
const audioCacheDir = join(__dirname, 'audio_cache');

if (!existsSync(tempDir)) mkdirSync(tempDir);
if (!existsSync(audioCacheDir)) mkdirSync(audioCacheDir);

// Глобальные переменные
let mainAudioFileId = null;
let userAudioFileId = null;
let nameMainAudioFileId = null;
let similarityPercentage = null;
let activeServerUrl = null;

const pipelineAsync = promisify(pipeline);

// Функция конвертации в WAV
async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!existsSync(inputPath)) {
      return reject(new Error(`Input file not found: ${inputPath}`));
    }

    const command = ffmpeg(inputPath)
      .audioCodec('pcm_s16le')
      .audioFrequency(48000)
      .audioChannels(1)
      .format('wav')
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(new Error('Ошибка конвертации аудио'));
      })
      .on('end', () => {
        if (!existsSync(outputPath)) {
          reject(new Error('Output file was not created'));
        } else {
          console.log('Conversion finished');
          resolve(outputPath);
        }
      })
      .save(outputPath);
  });
}

// Загрузка и конвертация аудио
async function downloadAndConvert(fileId, filePath, ctx) {
  const tempPath = join(tempDir, `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.ogg`);
  
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios({
      method: 'GET',
      url: fileLink,
      responseType: 'stream',
      timeout: 60000
    });

    await pipelineAsync(response.data, createWriteStream(tempPath));

    if (!existsSync(tempPath)) {
      throw new Error('Файл не был сохранён');
    }

    await convertToWav(tempPath, filePath);
    return filePath;
  } catch (error) {
    console.error('Download/convert error:', error);
    throw new Error('Не удалось обработать аудиофайл');
  } finally {
    setTimeout(() => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          console.error('Cleanup error:', cleanupError);
        }
      }
    }, 5000);
  }
}

// Проверка доступности серверов с кешированием
async function findAvailableServer() {
  if (activeServerUrl) {
    try {
      const response = await axios.get(`${activeServerUrl}/health`, { 
        timeout: 10000 
      });
      if (response.data?.status === 'success') {
        return activeServerUrl;
      }
    } catch (error) {
      console.log(`Cached server ${activeServerUrl} unavailable: ${error.message}`);
    }
  }

  for (const url of SERVER_URLS) {
    try {
      const response = await axios.get(`${url}/health`, { 
        timeout: 10000 
      });
      if (response.data?.status === 'success') {
        console.log(`Using server: ${url}`);
        return url;
      }
    } catch (error) {
      console.log(`Server ${url} unavailable: ${error.message}`);
    }
  }
  return null;
}

// Улучшенное локальное сравнение аудио
async function localAudioComparison(refPath, userPath) {
  try {
    const getMetadata = (filePath) => {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata);
        });
      });
    };

    const [refMeta, userMeta] = await Promise.all([
      getMetadata(refPath),
      getMetadata(userPath)
    ]);

    const refDuration = refMeta.format.duration;
    const userDuration = userMeta.format.duration;
    const refSize = refMeta.format.size;
    const userSize = userMeta.format.size;
    
    if (!refDuration || !userDuration) return 0;
    
    const durationDiff = Math.abs(refDuration - userDuration);
    const sizeDiff = Math.abs(refSize - userSize);
    
    const durationWeight = 0.6;
    const sizeWeight = 0.4;
    
    const durationSimilarity = 1 - Math.min(1, durationDiff / Math.max(refDuration, userDuration));
    const sizeSimilarity = 1 - Math.min(1, sizeDiff / Math.max(refSize, userSize));
    
    const totalSimilarity = (durationSimilarity * durationWeight + sizeSimilarity * sizeWeight) * 100;
    
    return Math.max(0, Math.min(100, totalSimilarity));
  } catch (error) {
    console.error('Local comparison error:', error);
    return 0;
  }
}

// Основная функция сравнения аудио
async function compareAudioFiles(ctx, refFileId, userFileId) {
  let refPath = `temp/ref_${Date.now()}.wav`;
  let userPath = `temp/user_${Date.now()}.wav`;
  let result = { status: 'error', similarity: 0 };
  
  try {
    console.log('Starting audio comparison process');
    
    await Promise.all([
      downloadAndConvert(refFileId, refPath, ctx),
      downloadAndConvert(userFileId, userPath, ctx)
    ]);
    console.log('Both audio files downloaded and converted');

    if (!activeServerUrl) {
      console.log('Looking for available server');
      activeServerUrl = await findAvailableServer();
    }

    if (activeServerUrl) {
      console.log(`Attempting server comparison with ${activeServerUrl}`);
      try {
        const refFormData = new FormData();
        refFormData.append('audio', createReadStream(refPath));
        refFormData.append('teacher_id', MAIN_USER_ID.toString());

        console.log('Uploading reference audio');
        await axios.post(`${activeServerUrl}/upload_reference`, refFormData, {
          headers: refFormData.getHeaders(),
          timeout: 300000
        });

        const compareFormData = new FormData();
        compareFormData.append('audio', createReadStream(userPath));
        compareFormData.append('teacher_id', MAIN_USER_ID.toString());

        console.log('Starting comparison on server');
        const response = await axios.post(`${activeServerUrl}/compare_audio`, compareFormData, {
          headers: compareFormData.getHeaders(),
          timeout: 300000
        });

        if (response.data?.status === 'success') {
          console.log('Server comparison successful');
          result = {
            status: 'success',
            similarity: response.data.data.similarity_percent,
            method: 'server'
          };
        }
      } catch (serverError) {
        console.error('Server comparison failed:', serverError.message);
        activeServerUrl = null;
      }
      finally {
        setTimeout(() => {
          [refPath, userPath].forEach(path => {
            if (existsSync(path)) {
              console.log(`Removing temp file: ${path}`);
              try {
                unlinkSync(path);
              } catch (e) {
                console.error(`Error removing ${path}:`, e);
              }
            }
          });
        }, 10000);
      }
    }

    if (result.status !== 'success') {
      console.log('Falling back to local comparison');
      const localSimilarity = await localAudioComparison(refPath, userPath);
      result = {
        status: 'success',
        similarity: localSimilarity,
        method: 'local'
      };
      console.log(`Local comparison result: ${localSimilarity.toFixed(2)}%`);
    }

    return result;
  } catch (error) {
    console.error('Comparison process error:', error);
    throw new Error('Ошибка при сравнении аудио: ' + error.message);
  } finally {
    [refPath, userPath].forEach(path => {
      if (existsSync(path)) {
        console.log(`Removing temp file: ${path}`);
        unlinkSync(path);
      }
    });
  }
}

// Команда /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;

  try {
    if (userId === MAIN_USER_ID) {
      await ctx.reply('🎤 Привет, Василий! Ты главный пользователь этого бота.\n\nЗапиши голосовое сообщение, и оно будет отправлено другим участникам для повторения.');
    } else {
      await ctx.replyWithHTML(
        `👋 Привет, ${ctx.from.first_name}! Этот бот создан для <b>Ржевского хора</b>.\n\n` +
        'Василий будет отправлять голосовые сообщения с песнопениями, а твоя задача - повторять их и отправлять свои версии для сравнения.\n\n' +
        'Когда Василий отправит аудио, ты получишь уведомление!'
      );
    }
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('Произошла ошибка при обработке команды /start');
  }
});

// Обработка голосовых сообщений
bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const voice = ctx.message.voice;

  try {
    console.log(`Voice message received from ${userId}, duration: ${voice.duration} sec`);
    
    if (userId === MAIN_USER_ID) {
      mainAudioFileId = voice.file_id;
      await ctx.reply('🎤 Голосовое сообщение получено!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📤 Отправить без названия", callback_data: "sending" }],
            [{ text: "✏️ Добавить название", callback_data: "setName" }]
          ],
        },
      });
    } else if (!mainAudioFileId) {
      await ctx.reply('⏳ Пожалуйста, дождитесь аудио от Василия');
    } else {
      userAudioFileId = voice.file_id;
      await ctx.replyWithHTML(
        '🔍 <b>Сравнить ваше аудио с эталоном?</b>\n\n' +
        `Длительность: ${voice.duration} сек`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Сравнить", callback_data: "sendingUsers" }]],
          },
        }
      );
    }
  } catch (error) {
    console.error('Voice message error:', error);
    await ctx.reply('⚠️ Произошла ошибка при обработке голосового сообщения');
  }
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text.trim();

  try {
    if (userId === MAIN_USER_ID && mainAudioFileId) {
      if (userMessage.length > 100) {
        await ctx.reply('❌ Слишком длинное название (максимум 100 символов)');
        return;
      }
      
      nameMainAudioFileId = userMessage;
      await ctx.replyWithHTML(
        `📝 <b>Название сохранено:</b> "${userMessage}"\n\n` +
        'Отправить аудио участникам?',
        {
          reply_markup: {
            inline_keyboard: [[{ text: "📤 Отправить", callback_data: "sending" }]],
          },
        }
      );
    }
  } catch (error) {
    console.error('Text message error:', error);
    await ctx.reply('⚠️ Произошла ошибка при обработке сообщения');
  }
});

// Обработка callback-кнопок
bot.on("callback_query", async (ctx) => {
  const buttonData = ctx.callbackQuery.data;
  const firstName = ctx.from.first_name;
  const userId = ctx.from.id;

  try {
    await ctx.answerCbQuery();

    if (buttonData === 'sendingUsers') {
      if (!mainAudioFileId || !userAudioFileId) {
        await ctx.reply('❌ Необходимы оба аудиофайла для сравнения');
        return;
      }

      const progressMessage = await ctx.replyWithHTML(
        '🔍 <b>Анализируем ваше аудио...</b>\n\n' +
        'Это может занять несколько минут...\n' +
        '⏳ 0%'
      );

      try {
        const startTime = Date.now();
        const progressInterval = setInterval(async () => {
          try {
            const elapsed = Math.min(90, Math.floor((Date.now() - startTime) / 1000));
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              progressMessage.message_id,
              null,
              `🔍 <b>Анализируем ваше аудио...</b>\n\n` +
              `Это может занять несколько минут...\n` +
              `⏳ ${elapsed}%`,
              { parse_mode: 'HTML' }
            );
          } catch (e) {
            console.log('Progress update error:', e.message);
          }
        }, 15000);

        const comparisonResult = await compareAudioFiles(ctx, mainAudioFileId, userAudioFileId);
        clearInterval(progressInterval);
        similarityPercentage = comparisonResult.similarity;
        
        let message = `🎵 <b>Результат сравнения:</b> ${comparisonResult.similarity.toFixed(2)}%\n`;
        if (comparisonResult.method === 'local') {
          message += "<i>(использовано упрощенное сравнение)</i>\n\n";
        } else {
          message += "\n";
        }

        if (comparisonResult.similarity > 80) {
          message += "🎉 Отличное совпадение! Почти идеально!";
        } else if (comparisonResult.similarity > 60) {
          message += "👍 Хорошее совпадение! Можно ещё лучше!";
        } else if (comparisonResult.similarity > 30) {
          message += "💪 Неплохо, но нужно больше практики!";
        } else {
          message += "🔄 Попробуйте ещё раз, обратите внимание на ритм и высоту тона";
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
        await ctx.replyWithHTML(message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📤 Отправить результат Васе", callback_data: "sendToVasya" }],
              [{ text: "🔄 Записать заново", callback_data: "rewrite" }]
            ],
          },
        });
      } catch (error) {
        console.error('Comparison failed:', error);
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
        await ctx.replyWithHTML('⚠️ <b>Не удалось сравнить аудио</b>\n\nПожалуйста, попробуйте позже или отправьте другое сообщение.');
      }

    } else if (buttonData === 'sending') {
      await ctx.reply('⏳ Отправляем аудио участникам...');

      let successCount = 0;
      const totalUsers = users.filter(uid => uid !== MAIN_USER_ID).length;

      for (const uid of users) {
        if (uid !== MAIN_USER_ID) {
          try {
            await ctx.telegram.sendChatAction(uid, 'typing');
            await ctx.telegram.sendMessage(
              uid, 
              '🎤 Василий отправил новое голосовое сообщение для повторения!'
            );
            
            if (nameMainAudioFileId) {
              await ctx.telegram.sendMessage(
                uid, 
                `📝 <b>Название:</b> ${nameMainAudioFileId}`,
                { parse_mode: 'HTML' }
              );
            }
            
            await ctx.telegram.sendVoice(uid, mainAudioFileId);
            successCount++;
          } catch (e) {
            console.error(`Ошибка отправки пользователю ${uid}:`, e.message);
          }
        }
      }

      nameMainAudioFileId = null;
      await ctx.replyWithHTML(
        `✅ Аудио отправлено ${successCount} из ${totalUsers} участников!` +
        (successCount < totalUsers ? '\n\nНекоторые пользователи не получили сообщение.' : '')
      );
    } else if (buttonData === 'sendToVasya') {
      await ctx.telegram.sendMessage(
        MAIN_USER_ID,
        `📤 ${firstName} отправил свой вариант!\n` +
        `🔍 Сходство: ${similarityPercentage.toFixed(2)}%`
      );
      await ctx.telegram.sendVoice(MAIN_USER_ID, userAudioFileId);
      await ctx.reply('✅ Результат отправлен Василию!');
    } else if (buttonData === 'rewrite') {
      await ctx.reply('🔄 Запишите голосовое сообщение ещё раз и отправьте его мне.');
      userAudioFileId = null;
    } else if (buttonData === 'setName') {
      await ctx.reply('✏️ Напишите название для этого голосового сообщения:');
    }
  } catch (error) {
    console.error('Callback error:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка');
    await ctx.reply('⚠️ Произошла ошибка. Пожалуйста, попробуйте ещё раз.');
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  
  if (process.env.RENDER) {
    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/bot${token}`;
    bot.telegram.setWebhook(webhookUrl)
      .then(() => {
        console.log('Webhook configured');
        app.use(bot.webhookCallback(`/bot${token}`));
      })
      .catch(err => console.error('Webhook setup error:', err));
  } else {
    bot.launch()
      .then(() => console.log('✅ Бот успешно запущен'))
      .catch(err => console.error('❌ Ошибка запуска бота:', err));
  }
});

// Обработка завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Обработка ошибок
process.on('uncaughtException', (err) => {
  console.error('⚠️ Необработанное исключение:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Необработанный промис:', promise, 'причина:', reason);
});