import { Telegraf } from "telegraf";
import FormData from 'form-data';
import axios from 'axios';
import { createWriteStream, createReadStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

// Конфигурация
ffmpeg.setFfmpegPath(ffmpegPath.path);
const token = '7523112354:AAF84dgow0u0klV8BFRhvJRwiQHFKtTCsbk';
const bot = new Telegraf(token);

// Настройки сервера
const SERVER_URLS = [
  'https://bek-bot.onrender.com'
];
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

// Улучшенная функция конвертации в WAV
async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(new Error('Ошибка конвертации аудио'));
      })
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

// Загрузка и конвертация аудио
async function downloadAndConvert(fileId, filePath, ctx) {
  let tempPath = `temp/temp_${Date.now()}.ogg`;
  
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios({
      method: 'GET',
      url: fileLink,
      responseType: 'stream',
      timeout: 30000
    });

    await pipelineAsync(response.data, createWriteStream(tempPath));
    await convertToWav(tempPath, filePath);
    
    return filePath;
  } catch (error) {
    console.error('Download/convert error:', error);
    throw new Error('Не удалось обработать аудиофайл');
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

// Проверка доступности серверов
async function findAvailableServer() {
  for (const url of SERVER_URLS) {
    try {
      const response = await axios.get(`${url}/health`, { 
        timeout: 60000 
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

// Локальное сравнение аудио (резервный вариант)
async function localAudioComparison(refPath, userPath) {
  // Простая реализация сравнения длительности как временное решение
  const getDuration = (filePath) => {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        resolve(err ? 0 : metadata.format.duration);
      });
    });
  };

  const refDuration = await getDuration(refPath);
  const userDuration = await getDuration(userPath);
  
  if (!refDuration || !userDuration) return 0;
  
  const durationDiff = Math.abs(refDuration - userDuration);
  const maxDiff = Math.max(refDuration, userDuration) * 0.2; // 20% допустимая разница
  
  return Math.max(0, 100 - (durationDiff / maxDiff * 100));
}

// Основная функция сравнения аудио
async function compareAudioFiles(ctx, refFileId, userFileId) {
  let refPath = `temp/ref_${Date.now()}.wav`;
  let userPath = `temp/user_${Date.now()}.wav`;
  let result = { status: 'error', similarity: 0 };
  
  try {
    // Скачиваем и конвертируем аудио
    await downloadAndConvert(refFileId, refPath, ctx);
    await downloadAndConvert(userFileId, userPath, ctx);

    // Пытаемся использовать сервер
    if (!activeServerUrl) {
      activeServerUrl = await findAvailableServer();
    }

    if (activeServerUrl) {
      try {
        // Загружаем референс
        const refFormData = new FormData();
        refFormData.append('audio', createReadStream(refPath));
        refFormData.append('teacher_id', MAIN_USER_ID.toString());

        await axios.post(`${activeServerUrl}/upload_reference`, refFormData, {
          headers: refFormData.getHeaders(),
          timeout: 60000
        });

        // Сравниваем
        const compareFormData = new FormData();
        compareFormData.append('audio', createReadStream(userPath));
        compareFormData.append('teacher_id', MAIN_USER_ID.toString());

        const response = await axios.post(`${activeServerUrl}/compare_audio`, compareFormData, {
          headers: compareFormData.getHeaders(),
          timeout: 120000
        });

        if (response.data?.status === 'success') {
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
    }

    // Если сервер не доступен, используем локальное сравнение
    if (result.status !== 'success') {
      const localSimilarity = await localAudioComparison(refPath, userPath);
      result = {
        status: 'success',
        similarity: localSimilarity,
        method: 'local'
      };
      console.log(`Used local comparison: ${localSimilarity.toFixed(2)}%`);
    }

    return result;
  } catch (error) {
    console.error('Comparison error:', error);
    throw new Error('Ошибка при сравнении аудио');
  } finally {
    [refPath, userPath].forEach(path => {
      if (existsSync(path)) unlinkSync(path);
    });
  }
}

// Команда /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;

  try {
    if (userId === MAIN_USER_ID) {
      await ctx.reply('Привет! Ты главный пользователь этого бота. Запиши голосовое сообщение, и оно будет отправлено другим участникам.');
    } else {
      await ctx.reply('Привет! Этот бот создан для Ржевского хора. Главный пользователь (Василий) будет отправлять голосовые сообщения с песнопениями, а твоя задача - повторять их и отправлять свои версии для сравнения.');
      await ctx.reply('Когда Василий отправит аудио, ты получишь уведомление!');
    }
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте ещё раз.');
  }
});

// Обработка голосовых сообщений
bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const voice = ctx.message.voice.file_id;

  try {
    if (userId === MAIN_USER_ID) {
      mainAudioFileId = voice;
      await ctx.reply('Хотите назвать голосовое сообщение?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Отправить без названия", callback_data: "sending" }],
            [{ text: "Добавить название", callback_data: "setName" }]
          ],
        },
      });
    } else if (!mainAudioFileId) {
      await ctx.reply('Пожалуйста, дождитесь аудио от Василия');
    } else {
      userAudioFileId = voice;
      await ctx.reply('Сравнить ваше аудио с эталоном?', {
        reply_markup: {
          inline_keyboard: [[{ text: "Сравнить", callback_data: "sendingUsers" }]],
        },
      });
    }
  } catch (error) {
    console.error('Voice message error:', error);
    await ctx.reply('Произошла ошибка при обработке голосового сообщения');
  }
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;

  try {
    if (userId === MAIN_USER_ID) {
      nameMainAudioFileId = userMessage;
      await ctx.reply(`Название сохранено: "${userMessage}". Отправить аудио участникам?`, {
        reply_markup: {
          inline_keyboard: [[{ text: "Отправить", callback_data: "sending" }]],
        },
      });
    }
  } catch (error) {
    console.error('Text message error:', error);
    await ctx.reply('Произошла ошибка при обработке сообщения');
  }
});

// Обработка callback-кнопок
bot.on("callback_query", async (ctx) => {
  const buttonData = ctx.callbackQuery.data;
  const firstName = ctx.from.first_name;

  try {
    await ctx.answerCbQuery();

    if (buttonData === 'sendingUsers') {
      await ctx.reply('Анализируем ваше аудио. Это займет пару минут...');

      if (!mainAudioFileId || !userAudioFileId) {
        await ctx.reply('Необходимы оба аудиофайла для сравнения');
        return;
      }

      try {
        const comparisonResult = await compareAudioFiles(ctx, mainAudioFileId, userAudioFileId);
        similarityPercentage = comparisonResult.similarity;
        
        let message = `Результат сравнения: ${comparisonResult.similarity.toFixed(2)}%\n`;
        if (comparisonResult.method === 'local') {
          message += "(использовано упрощенное сравнение)\n";
        }

        if (comparisonResult.similarity > 80) {
          message += "Отличное совпадение! 🎉";
        } else if (comparisonResult.similarity > 60) {
          message += "Хорошее совпадение! 👍";
        } else {
          message += "Попробуйте ещё раз, можно лучше 💪";
        }

        await ctx.reply(message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Отправить результат Васе", callback_data: "sendToVasya" }],
              [{ text: "Записать заново", callback_data: "rewrite" }]
            ],
          },
        });
      } catch (error) {
        console.error('Comparison failed:', error);
        await ctx.reply('Не удалось сравнить аудио. Пожалуйста, попробуйте позже.');
      }

    } else if (buttonData === 'sending') {
      await ctx.reply('Отправляем аудио участникам...');

      for (const uid of users) {
        if (uid !== MAIN_USER_ID) {
          try {
            await ctx.telegram.sendMessage(uid, 'Василий отправил новое голосовое сообщение! Пожалуйста, отправьте свой вариант.');
            if (nameMainAudioFileId) {
              await ctx.telegram.sendMessage(uid, `Название: ${nameMainAudioFileId}`);
            }
            await ctx.telegram.sendVoice(uid, mainAudioFileId);
          } catch (e) {
            console.error(`Ошибка отправки пользователю ${uid}:`, e.message);
          }
        }
      }

      nameMainAudioFileId = null;
      await ctx.reply('Аудио отправлено всем участникам!');
    } else if (buttonData === 'sendToVasya') {
      await ctx.telegram.sendMessage(
        MAIN_USER_ID,
        `${firstName} отправил свой вариант!\nСходство: ${similarityPercentage.toFixed(2)}%`
      );
      await ctx.telegram.sendVoice(MAIN_USER_ID, userAudioFileId);
      await ctx.reply('Результат отправлен Василию!');
    } else if (buttonData === 'rewrite') {
      await ctx.reply('Запишите голосовое сообщение ещё раз и отправьте его мне.');
    } else if (buttonData === 'setName') {
      await ctx.reply('Напишите название для этого голосового сообщения:');
    }
  } catch (error) {
    console.error('Callback error:', error);
    await ctx.answerCbQuery('⚠️ Произошла ошибка');
    await ctx.reply('Произошла ошибка. Пожалуйста, попробуйте ещё раз.');
  }
});

// Запуск бота
bot.launch()
  .then(() => {
    console.log('Бот успешно запущен');
    // Пытаемся найти доступный сервер при старте
    findAvailableServer().then(url => {
      activeServerUrl = url;
      if (!activeServerUrl) {
        console.log('Сервер сравнения недоступен, будет использовано локальное сравнение');
      }
    });
  })
  .catch(err => console.error('Ошибка запуска бота:', err));

// Обработка завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));