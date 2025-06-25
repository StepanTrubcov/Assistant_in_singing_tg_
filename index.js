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

// Конфигурация
ffmpeg.setFfmpegPath(ffmpegStatic);
const token = '7523112354:AAF84dgow0u0klV8BFRhvJRwiQHFKtTCsbk';
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

// Остальные функции (findAvailableServer, localAudioComparison, compareAudioFiles)
// ... (оставьте без изменений, как в вашем оригинальном коде)

// Обработчики команд и сообщений
// ... (оставьте без изменений, как в вашем оригинальном коде)

// Настройка Webhook/Polling
const PORT = process.env.PORT || 3000;
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