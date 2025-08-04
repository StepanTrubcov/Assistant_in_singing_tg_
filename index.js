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

// Определение порта
const PORT = process.env.PORT || 3000;

// Конфигурация
ffmpeg.setFfmpegPath(ffmpegStatic);
const token = '8363940753:AAFbh68b2Ggzx3M2pzXetcVLp2sQFiiiCuw';
const bot = new Telegraf(token);

// Настройки сервера
const SERVER_URLS = ['http://77.233.222.46:8000'];
const MAIN_USER_ID = 779619123;
const users = [8114868398,5102803347];

// Создаем необходимые директории
const tempDir = join(__dirname, 'temp');
const audioCacheDir = join(__dirname, 'audio_cache');

if (!existsSync(tempDir)) mkdirSync(tempDir);
if (!existsSync(audioCacheDir)) mkdirSync(audioCacheDir);

// Глобальные переменные
let mainAudioFileId = null;
let userAudioFileId = null;
let nameMainAudioFileId = null;
let mainImageFileId = null; // New variable to store image file ID
let comparisonResult = null;
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
      timeout: 100000
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
        timeout: 1000000
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
        timeout: 1000000
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

    if (!refDuration || !userDuration) return {
      status: 'success',
      method: 'local',
      data: {
        overall_similarity_percent: 0,
        text_similarity_percent: 0,
        pitch_similarity_percent: 0,
        temporal_similarity_percent: 0,
        spectral_similarity_percent: 0,
        text_warning: 'Не удалось извлечь метаданные',
        details: { duration_diff: 0, pitch_diff: 0 },
        warnings: ['Ошибка анализа аудио'],
        suggestions: ['Попробуйте отправить другое аудио']
      }
    };

    const durationDiff = Math.abs(refDuration - userDuration);
    const sizeDiff = Math.abs(refSize - userSize);

    const durationWeight = 0.6;
    const sizeWeight = 0.4;

    const durationSimilarity = 1 - Math.min(1, durationDiff / Math.max(refDuration, userDuration));
    const sizeSimilarity = 1 - Math.min(1, sizeDiff / Math.max(refSize, userSize));

    const totalSimilarity = (durationSimilarity * durationWeight + sizeSimilarity * sizeWeight) * 100;

    return {
      status: 'success',
      method: 'local',
      data: {
        overall_similarity_percent: Math.max(0, Math.min(100, totalSimilarity)),
        text_similarity_percent: 0,
        pitch_similarity_percent: 0,
        temporal_similarity_percent: Math.max(0, Math.min(100, durationSimilarity * 100)),
        spectral_similarity_percent: 0,
        text_warning: 'Локальное сравнение (ограниченный анализ)',
        details: { duration_diff: durationDiff, pitch_diff: 0 },
        warnings: ['Использовано упрощённое сравнение из-за недоступности сервера'],
        suggestions: ['Попробуйте позже для полного анализа']
      }
    };
  } catch (error) {
    console.error('Local comparison error:', error);
    return {
      status: 'success',
      method: 'local',
      data: {
        overall_similarity_percent: 0,
        text_similarity_percent: 0,
        pitch_similarity_percent: 0,
        temporal_similarity_percent: 0,
        spectral_similarity_percent: 0,
        text_warning: 'Ошибка локального анализа',
        details: { duration_diff: 0, pitch_diff: 0 },
        warnings: ['Не удалось выполнить локальное сравнение'],
        suggestions: ['Попробуйте отправить другое аудио']
      }
    };
  }
}

// Основная функция сравнения аудио
async function compareAudioFiles(ctx, refFileId, userFileId) {
  let refPath = `temp/ref_${Date.now()}.wav`;
  let userPath = `temp/user_${Date.now()}.wav`;

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
          timeout: 1000000
        });

        const compareFormData = new FormData();
        compareFormData.append('audio', createReadStream(userPath));
        compareFormData.append('teacher_id', MAIN_USER_ID.toString());

        console.log('Starting comparison on server');
        const response = await axios.post(`${activeServerUrl}/compare_audio`, compareFormData, {
          headers: compareFormData.getHeaders(),
          timeout: 1000000
        });

        if (response.data?.status === 'success') {
          console.log('Server comparison successful');
          console.log('Ответ сервера:', JSON.stringify(response.data, null, 2));
          return {
            status: 'success',
            method: 'server',
            data: response.data.data
          };
        }
      } catch (serverError) {
        console.error('Server comparison failed:', serverError.message);
        activeServerUrl = null;
      }
    }

    console.log('Falling back to local comparison');
    return await localAudioComparison(refPath, userPath);
  } catch (error) {
    console.error('Comparison process error:', error);
    throw new Error('Ошибка при сравнении аудио: ' + error.message);
  } finally {
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

// Команда /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;

  try {
    if (userId === MAIN_USER_ID) {
      await ctx.reply('🎤 Привет, Василий! Ты главный пользователь этого бота.\n\nЗапиши голосовое сообщение, и оно будет отправлено другим участникам для повторения.\n' +
                      'Ты также можешь отправить название и изображение с текстом песнопения.');
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

bot.command('help', (ctx) => {
  ctx.replyWithHTML(
    'ℹ️ <b>Помощь по боту</b>\n\n' +
    'Этот бот предназначен для сравнения голосовых сообщений.\n\n' +
    '<b>Основные команды:</b>\n' +
    '/start - Начать работу с ботом\n' +
    '/help - Показать эту справку\n' +
    '/info - Показать информацию о сравнении\n\n' +
    '<b>Как использовать:</b>\n' +
    '1. Василий отправляет голосовое сообщение с песнопением в бота\n' +
    '2. Бот присылает это голосовое всем остальным пользователям\n' +
    '3. Ваша задача: когда бот пришлёт голосовое от Василия, прослушать его и отправить ответное голосовое сообщение боту\n' +
    '4. Бот сравнивает голосовые сообщения и показывает подробные результаты\n' +
    '5. Если результат слишком низкий, вы можете перезаписать голосовое\n' +
    '6. Когда результат будет удовлетворительным, бот отправит голосовое и результаты Василию\n\n' +
    '⚠️ Если бот не отвечает, попробуйте перезапустить его командой /start'
  );
});

bot.command('info', (ctx) => {
  ctx.replyWithHTML(
    '<b>Как бот сравнивает голосовые сообщения:</b>\n' +
    'Бот анализирует несколько параметров:\n' +
    '🎵 <b>Общее сходство</b>: Как сильно ваше исполнение совпадает с эталоном\n' +
    '📜 <b>Текст</b>: Насколько точно вы воспроизвели слова\n' +
    '🎶 <b>Высота тона</b>: Соответствие мелодии эталону\n' +
    '⏱️ <b>Темп</b>: Совпадение ритма и скорости исполнения\n' +
    '🔊 <b>Спектральные характеристики</b>: Сходство тембра и качества звука\n\n' +
    '<b>Оценки:</b>\n' +
    '🎯 90%–100% — Отличное совпадение\n' +
    '👍 70%–90% — Хорошее совпадение\n' +
    '🤔 50%–70% — Заметные различия\n' +
    '🎵 30%–50% — Значительные отличия\n' +
    '❌ 0%–30% — Возможно, другое песнопение\n\n' +
    'Совет: Если результат ниже 70%, попробуйте перезаписать, обращая внимание на текст, мелодию и темп!'
  );
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
            [{ text: "📤 Отправить без названия и изображения", callback_data: "sending" }],
            [{ text: "✏️ Добавить название", callback_data: "setName" }],
            [{ text: "🖼️ Добавить изображение", callback_data: "setImage" }]
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

// Обработка изображений
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photos = ctx.message.photo;

  try {
    if (userId === MAIN_USER_ID && mainAudioFileId) {
      // Get the highest resolution image
      const photo = photos[photos.length - 1];
      mainImageFileId = photo.file_id;
      await ctx.replyWithHTML(
        `🖼️ <b>Изображение сохранено</b>\n\n` +
        'Отправить аудио участникам?',
        {
          reply_markup: {
            inline_keyboard: [[{ text: "📤 Отправить", callback_data: "sending" }],[{ text: "✏️ Добавить название", callback_data: "setName" }],],
          },
        }
      );
    } else {
      await ctx.reply('⚠️ Изображения принимаются только от Василия после отправки голосового сообщения');
    }
  } catch (error) {
    console.error('Photo message error:', error);
    await ctx.reply('⚠️ Произошла ошибка при обработке изображения');
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
        'Добавить изображение или отправить аудио участникам?',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🖼️ Добавить изображение", callback_data: "setImage" }],
              [{ text: "📤 Отправить", callback_data: "sending" }]
            ],
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

        comparisonResult = await compareAudioFiles(ctx, mainAudioFileId, userAudioFileId);
        clearInterval(progressInterval);

        const { data, method } = comparisonResult;
        const {
          overall_similarity_percent,
          text_similarity_percent,
          pitch_similarity_percent,
          temporal_similarity_percent,
          spectral_similarity_percent,
          text_warning,
          details,
          warnings,
          suggestions
        } = data;

        let message = `🎵 <b>Результат сравнения:</b>\n\n`;
        message += `📊 <b>Общее сходство:</b> ${overall_similarity_percent.toFixed(2)}%\n`;
        message += `📜 Текст: ${text_similarity_percent.toFixed(2)}%${text_warning ? ` (${text_warning})` : ''}\n`;
        message += `🎶 Высота тона: ${pitch_similarity_percent.toFixed(2)}%\n`;
        message += `⏱️ Темп: ${temporal_similarity_percent.toFixed(2)}%\n`;
        message += `🔊 Спектральные характеристики: ${spectral_similarity_percent.toFixed(2)}%\n`;

        if (method === 'local') {
          message += `\n<i>(Использовано упрощённое локальное сравнение)</i>\n`;
        }

        if (overall_similarity_percent > 80) {
          message += `\n🎉 Идеальное совпадение! Василий будет в восторге!`;
        } else if (overall_similarity_percent > 70) {
          message += `\n👍 Хорошее совпадение! Василий будет доволен!`;
        } else if (overall_similarity_percent > 50) {
          message += `\n💪 Неплохо, но нужно больше практики!`;
        } else if (overall_similarity_percent > 30) {
          message += `\n😔 Думаю, Василию не понравится такой результат!`;
        } else {
          message += `\n😡 Возможно, вы поёте не то песнопение`;
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

            if (mainImageFileId) {
              await ctx.telegram.sendPhoto(uid, mainImageFileId, {
              });
            }

            await ctx.telegram.sendVoice(uid, mainAudioFileId);
            successCount++;
          } catch (e) {
            console.error(`Ошибка отправки пользователю ${uid}:`, e.message);
          }
        }
      }

      nameMainAudioFileId = null;
      mainImageFileId = null; // Reset image file ID after sending
      await ctx.replyWithHTML(
        `✅ Аудио отправлено ${successCount} из ${totalUsers} участников!` +
        (successCount < totalUsers ? '\n\nНекоторые пользователи не получили сообщение.' : '')
      );
    } else if (buttonData === 'sendToVasya') {
      if (!comparisonResult) {
        await ctx.reply('❌ Нет результатов сравнения для отправки');
        return;
      }

      const { data } = comparisonResult;
      const {
        overall_similarity_percent,
        text_similarity_percent,
        pitch_similarity_percent,
        temporal_similarity_percent,
        spectral_similarity_percent,
        text_warning,
        details,
        warnings,
        suggestions
      } = data;

      let message = `📤 ${firstName} отправил свой вариант!\n\n`;
      message += `📊 <b>Общее сходство:</b> ${overall_similarity_percent.toFixed(2)}%\n`;
      message += `📜 Текст:${text_similarity_percent.toFixed(2)}%${text_warning ? ` (${text_warning})` : ''}\n`;
      message += `🎶 Высота тона: ${pitch_similarity_percent.toFixed(2)}%\n`;
      message += `⏱️ Темп: ${temporal_similarity_percent.toFixed(2)}%\n`;
      message += `🔊 Спектральные характеристики: ${spectral_similarity_percent.toFixed(2)}%\n`;

      if (comparisonResult.method === 'local') {
        message += `\n<i>(Использовано упрощённое локальное сравнение)</i>`;
      }

      await ctx.telegram.sendMessage(MAIN_USER_ID, message, { parse_mode: 'HTML' });
      await ctx.telegram.sendVoice(MAIN_USER_ID, userAudioFileId);
      await ctx.reply('✅ Результат отправлен Василию!');
    } else if (buttonData === 'rewrite') {
      await ctx.reply('🔄 Запишите голосовое сообщение ещё раз и отправьте его мне.');
      userAudioFileId = null;
      comparisonResult = null;
    } else if (buttonData === 'setName') {
      await ctx.reply('✏️ Напишите название для этого голосового сообщения:');
    } else if (buttonData === 'setImage') {
      await ctx.reply('🖼️ Отправьте изображение с текстом песнопения:');
    }
  } catch (error) {
    console.error('Callback error:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка');
    await ctx.reply('⚠️ Произошла ошибка. Пожалуйста, попробуйте ещё раз.');
  }
});

app.get('/ping', (req, res) => {
  console.log('Received ping at', new Date().toISOString());
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Bot is healthy',
    timestamp: new Date().toISOString()
  });
});

app.get('/wakeup', (req, res) => {
  console.log('Wakeup call received');
  res.send('Bot is awake!');
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