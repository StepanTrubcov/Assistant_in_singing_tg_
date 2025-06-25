import { Telegraf } from "telegraf";
import FormData from 'form-data';
import axios from 'axios';
import { createWriteStream, createReadStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
ffmpeg.setFfmpegPath(ffmpegPath);
import express from 'express';

// Инициализация Express сервера
const app = express();
const PORT = process.env.PORT || 3000;

// Конфигурация
ffmpeg.setFfmpegPath(ffmpegPath.path);
const token = '7523112354:AAF84dgow0u0klV8BFRhvJRwiQHFKtTCsbk';
const bot = new Telegraf(token);

// Настройки сервера
const SERVER_URLS = ['https://bek-bot.onrender.com'];
const MAIN_USER_ID = 5102803347;
const users = [7779459253];

// Создаем необходимые директории
if (!existsSync('temp')) mkdirSync('temp');
if (!existsSync('audio_cache')) mkdirSync('audio_cache');

// Глобальные переменные
let mainAudioFileId = null;
let userAudioFileId = null;
let nameMainAudioFileId = null;
let similarityPercentage = null;
let activeServerUrl = null;

const pipelineAsync = promisify(pipeline);

// Улучшенная функция конвертации в WAV с обработкой ошибок
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
      .on('start', (cmd) => console.log(`Starting conversion: ${cmd}`))
      .on('progress', (progress) => console.log(`Processing: ${progress.timemark}`))
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

// Загрузка и конвертация аудио с улучшенной обработкой ошибок
async function downloadAndConvert(fileId, filePath, ctx) {
  const tempPath = `temp/temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.ogg`;
  
  try {
    console.log(`Starting download for file ${fileId}`);
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    const response = await axios({
      method: 'GET',
      url: fileLink,
      responseType: 'stream',
      timeout: 60000
    });

    // Убедимся, что директория существует
    if (!existsSync('temp')) mkdirSync('temp');
    
    await pipelineAsync(response.data, createWriteStream(tempPath));
    console.log(`File downloaded to ${tempPath}`);

    if (!existsSync(tempPath)) {
      throw new Error('Файл не был сохранён');
    }

    console.log(`Starting conversion to ${filePath}`);
    await convertToWav(tempPath, filePath);
    console.log(`Conversion successful`);
    
    return filePath;
  } catch (error) {
    console.error('Download/convert error:', error);
    throw new Error('Не удалось обработать аудиофайл');
  } finally {
    // Задержка перед удалением временного файла
    setTimeout(() => {
      if (existsSync(tempPath)) {
        console.log(`Cleaning up temp file ${tempPath}`);
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          console.error('Cleanup error:', cleanupError);
        }
      }
    }, 5000); // 5 секунд задержки
  }
}

// Проверка доступности серверов с кешированием
async function findAvailableServer() {
  // Если уже есть активный URL, проверяем его первым
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

  // Проверяем все серверы по очереди
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
    // Получаем метаданные для обоих файлов
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

    // Проверяем основные параметры
    const refDuration = refMeta.format.duration;
    const userDuration = userMeta.format.duration;
    const refSize = refMeta.format.size;
    const userSize = userMeta.format.size;
    
    if (!refDuration || !userDuration) return 0;
    
    // Сравниваем несколько параметров
    const durationDiff = Math.abs(refDuration - userDuration);
    const sizeDiff = Math.abs(refSize - userSize);
    
    // Весовые коэффициенты для разных параметров
    const durationWeight = 0.6;
    const sizeWeight = 0.4;
    
    // Нормализованные различия (0-1)
    const durationSimilarity = 1 - Math.min(1, durationDiff / Math.max(refDuration, userDuration));
    const sizeSimilarity = 1 - Math.min(1, sizeDiff / Math.max(refSize, userSize));
    
    // Общая оценка сходства
    const totalSimilarity = (durationSimilarity * durationWeight + sizeSimilarity * sizeWeight) * 100;
    
    return Math.max(0, Math.min(100, totalSimilarity));
  } catch (error) {
    console.error('Local comparison error:', error);
    return 0;
  }
}

// Основная функция сравнения аудио с улучшенной обработкой ошибок
async function compareAudioFiles(ctx, refFileId, userFileId) {
  let refPath = `temp/ref_${Date.now()}.wav`;
  let userPath = `temp/user_${Date.now()}.wav`;
  let result = { status: 'error', similarity: 0 };
  
  try {
    console.log('Starting audio comparison process');
    
    // Скачиваем и конвертируем аудио параллельно
    await Promise.all([
      downloadAndConvert(refFileId, refPath, ctx),
      downloadAndConvert(userFileId, userPath, ctx)
    ]);
    console.log('Both audio files downloaded and converted');

    // Пытаемся использовать сервер
    if (!activeServerUrl) {
      console.log('Looking for available server');
      activeServerUrl = await findAvailableServer();
    }

    if (activeServerUrl) {
      console.log(`Attempting server comparison with ${activeServerUrl}`);
      try {
        // Загружаем референс
        const refFormData = new FormData();
        refFormData.append('audio', createReadStream(refPath));
        refFormData.append('teacher_id', MAIN_USER_ID.toString());

        console.log('Uploading reference audio');
        await axios.post(`${activeServerUrl}/upload_reference`, refFormData, {
          headers: refFormData.getHeaders(),
          timeout: 300000 // 5 минут
        });

        // Сравниваем
        const compareFormData = new FormData();
        compareFormData.append('audio', createReadStream(userPath));
        compareFormData.append('teacher_id', MAIN_USER_ID.toString());

        console.log('Starting comparison on server');
        const response = await axios.post(`${activeServerUrl}/compare_audio`, compareFormData, {
          headers: compareFormData.getHeaders(),
          timeout: 300000 // 5 минут
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
        activeServerUrl = null; // Помечаем сервер как недоступный
      }
      finally {
        // Очистка временных файлов с задержкой
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
        }, 10000); // 10 секунд задержки
      }
    }

    // Если сервер не доступен, используем локальное сравнение
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
    // Очистка временных файлов
    [refPath, userPath].forEach(path => {
      if (existsSync(path)) {
        console.log(`Removing temp file: ${path}`);
        unlinkSync(path);
      }
    });
  }
}

// Команда /start с улучшенным приветствием
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

// Обработка голосовых сообщений с улучшенной логикой
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

// Обработка текстовых сообщений с улучшенной валидацией
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

// Улучшенная обработка callback-кнопок с прогрессом
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

      // Отправляем сообщение о начале обработки
      const progressMessage = await ctx.replyWithHTML(
        '🔍 <b>Анализируем ваше аудио...</b>\n\n' +
        'Это может занять несколько минут...\n' +
        '⏳ 0%'
      );

      try {
        // Обновляем прогресс каждые 15 секунд
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
        
        // Формируем сообщение с результатом
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

        // Удаляем сообщение о прогрессе и отправляем результат
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

// Простой HTTP-сервер для Render
app.get('/', (req, res) => {
  res.send('Telegram bot is running');
});

// Запуск сервера и бота
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  
  // Запуск бота
  bot.launch()
    .then(() => {
      console.log('✅ Бот успешно запущен');
      
      // Пытаемся найти доступный сервер при старте
      findAvailableServer()
        .then(url => {
          activeServerUrl = url;
          if (!activeServerUrl) {
            console.log('ℹ️ Сервер сравнения недоступен, будет использовано локальное сравнение');
          }
        })
        .catch(err => console.error('Server discovery error:', err));
    })
    .catch(err => {
      console.error('❌ Ошибка запуска бота:', err);
      process.exit(1);
    });
});

// Обработка завершения работы
process.once('SIGINT', () => {
  console.log('🛑 Получен SIGINT. Остановка бота...');
  bot.stop('SIGINT')
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Ошибка при остановке бота:', err);
      process.exit(1);
    });
});

process.once('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM. Остановка бота...');
  bot.stop('SIGTERM')
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Ошибка при остановке бота:', err);
      process.exit(1);
    });
});

// Обработка необработанных исключений
process.on('uncaughtException', (err) => {
  console.error('⚠️ Необработанное исключение:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Необработанный промис:', promise, 'причина:', reason);
});