import { Telegraf } from "telegraf";
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import { execSync } from 'child_process';

// const token = '7523112354:AAF84dgow0u0klV8BFRhvJRwiQHFKtTCsbk'

const token = process.env.TOKEN;

const bot = new Telegraf(token)
// const MAIN_USER_ID = 5102803347
// //779619123
// const users = [7779459253];

const MAIN_USER_ID = parseInt(process.env.MAIN_USER_ID);
const users = JSON.parse(process.env.USERS || '[]');

let mainAudioFileId = null;
let userAudioFileId = null;

let nameMainAudioFileId = null;

let similarityPercentage = null;

ffmpeg.setFfmpegPath('ffmpeg');

async function downloadAndConvertVoice(ctx, fileId, outputPath) {
  const tempPath = `temp_${Date.now()}.ogg`;

  try {
    // Скачивание файла
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);
    console.log(`Временный файл создан: ${tempPath} (${buffer.length} байт)`);

    // Конвертация в WAV
    await new Promise((resolve, reject) => {
      const command = ffmpeg(tempPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(44100)
        .audioChannels(1)
        .format('wav')
        .on('start', (cmd) => console.log('Запущена команда:', cmd))
        .on('progress', (progress) => {
          let progressInfo = '';
          if (progress.percent !== undefined) {
            progressInfo += `${progress.percent.toFixed(2)}% `;
          }
          if (progress.timemark) {
            progressInfo += `[${progress.timemark}] `;
          }
          if (progress.frames) {
            progressInfo += `${progress.frames} frames`;
          }
          console.log('Прогресс:', progressInfo || 'Данные о прогрессе недоступны');
        })
        .on('error', (err) => {
          console.error('Ошибка конвертации:', err);
          deleteTempFile(tempPath);
          reject(err);
        })
        .on('end', () => {
          console.log('Конвертация успешно завершена');
          deleteTempFile(tempPath);
          resolve();
        });

      // Добавим обработчик для получения метаданных
      command.on('codecData', (data) => {
        console.log(`Длительность входного файла: ${data.duration || 'неизвестна'}`);
      });

      command.save(outputPath);
    });

    // Проверяем размер выходного файла
    const stats = fs.statSync(outputPath);
    console.log(`Размер WAV файла: ${stats.size} байт`);
  } catch (err) {
    deleteTempFile(tempPath);
    throw err;
  }
}

// async function getPitchAnalysis(wavPath) {
//   try {
//     // Используем более продвинутый анализ через sox и ffmpeg
//     const freqCommand = `sox ${wavPath} -n stat -freq 2>&1 | grep -oP '\\d+\\.\\d+' | head -1`;
//     const freq = parseFloat(execSync(freqCommand).toString()) || 0;
    
//     // Дополнительный анализ через ffmpeg
//     const statsCommand = `ffmpeg -i ${wavPath} -af astats=metadata=1:reset=1 -f null - 2>&1 | grep -E 'Overall.Frequency|Peak.level'`;
//     const statsOutput = execSync(statsCommand).toString();
    
//     const freqMatch = statsOutput.match(/Overall\.Frequency:\s*(\d+\.?\d*)/);
//     const peakMatch = statsOutput.match(/Peak\.level:\s*(-?\d+\.?\d*)/);
    
//     return {
//       avgFrequency: freqMatch ? parseFloat(freqMatch[1]) : freq,
//       peakLevel: peakMatch ? parseFloat(peakMatch[1]) : 0,
//       pitchCount: 1
//     };
//   } catch (error) {
//     console.error('Advanced pitch analysis failed:', error);
//     return { avgFrequency: 0, peakLevel: 0, pitchCount: 0 };
//   }
// }

// async function getBasicFrequencyAnalysis(wavPath) {
//   try {
//     const command = `ffmpeg -i ${wavPath} -af "astats=metadata=1:reset=1" -f null - 2>&1 | grep "Overall.Frequency"`;
//     const output = execSync(command).toString();
//     const freqMatch = output.match(/Overall\.Frequency:\s*(\d+\.?\d*)/);
    
//     if (freqMatch) {
//       return {
//         avgFrequency: parseFloat(freqMatch[1]),
//         pitchCount: 1
//       };
//     }
//     throw new Error('No frequency data found');
//   } catch (error) {
//     console.error('Basic frequency analysis failed:', error);
//     throw new Error('Could not analyze pitch: ' + error.message);
//   }
// }

function deleteTempFile(path) {
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      console.log(`Временный файл удалён: ${path}`);
    }
  } catch (err) {
    console.error(`Ошибка при удалении ${path}:`, err);
  }
}

// async function getAudioFeatures(wavPath) {
//   try {
//     // 1. Получаем длительность аудио
//     const durationCommand = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${wavPath}`;
//     const duration = parseFloat(execSync(durationCommand).toString());

//     // 2. Упрощенный анализ громкости и пикового уровня
//     const analysisCommand = `ffmpeg -i ${wavPath} -af "ebur128=peak=true" -f null - 2>&1 | grep -E 'I:|Peak:'`;
//     const analysisOutput = execSync(analysisCommand, { maxBuffer: 1024 * 1024 * 5 }).toString();

//     // Извлекаем ключевые параметры
//     const loudnessMatch = analysisOutput.match(/I:\s*(-?\d+\.\d+)\s*LUFS/);
//     const peakMatch = analysisOutput.match(/Peak:\s*(-?\d+\.\d+)\s*dBFS/);

//     if (!loudnessMatch || !peakMatch) {
//       throw new Error('Не удалось извлечь параметры громкости');
//     }

//     return {
//       duration,
//       loudness: parseFloat(loudnessMatch[1]),
//       peak: parseFloat(peakMatch[1])
//     };
//   } catch (error) {
//     console.error('Ошибка анализа аудио:', error);
//     throw new Error('Не удалось проанализировать аудио файл');
//   }
// }
async function getEnhancedAudioAnalysis(wavPath) {
  const pitch = await getPitchAnalysis(wavPath);
  const features = await getAudioFeatures(wavPath);
  
  // Дополнительный спектральный анализ
  const spectralCommand = `sox ${wavPath} -n stat -spectral 2>&1 | grep -E 'Flatness|Crest'`;
  const spectralOutput = execSync(spectralCommand).toString();
  
  return {
    ...pitch,
    ...features,
    spectral: spectralOutput.includes('Flatness') ? 
      parseFloat(spectralOutput.match(/Flatness:\s*(\d+\.?\d*)/)[1]) : 0
  };
}

function calculateEnhancedSimilarity(main, user) {
  // Взвешенное сравнение по 10 параметрам
  const params = [
    { name: 'frequency', diff: Math.abs(main.avgFrequency - user.avgFrequency), weight: 0.3 },
    { name: 'loudness', diff: Math.abs(main.loudness - user.loudness), weight: 0.2 },
    { name: 'duration', diff: Math.abs(main.duration - user.duration), weight: 0.15 },
    { name: 'spectral', diff: Math.abs(main.spectral - user.spectral), weight: 0.15 },
    { name: 'peak', diff: Math.abs(main.peak - user.peak), weight: 0.2 }
  ];

  return params.reduce((total, {diff, weight}) => {
    const similarity = 100 * (1 - Math.min(diff / 100, 1));
    return total + similarity * weight;
  }, 0);
}

function getDetailedPitchComment(main, user) {
  const diff = main.avgFrequency - user.avgFrequency;
  const absDiff = Math.abs(diff);
  
  let comment = '';
  if (absDiff < 20) comment = 'Идеальное совпадение высоты тона 🎵';
  else if (absDiff < 50) comment = 'Небольшое отклонение высоты тона';
  else comment = 'Заметное отличие в высоте тона';
  
  return `${comment}\nОригинал: ${main.avgFrequency.toFixed(2)} Гц | Ваш вариант: ${user.avgFrequency.toFixed(2)} Гц`;
}

async function compareAudioFiles(ctx, mainAudioFileId, userAudioFileId) {
  const mainWavPath = 'main.wav';
  const userWavPath = 'user.wav';

  try {
    await Promise.all([
      downloadAndConvertVoice(ctx, mainAudioFileId, mainWavPath),
      downloadAndConvertVoice(ctx, userAudioFileId, userWavPath)
    ]);

    // Анализ с новыми параметрами
    const [mainAnalysis, userAnalysis] = await Promise.all([
      getEnhancedAudioAnalysis(mainWavPath),
      getEnhancedAudioAnalysis(userWavPath)
    ]);

    // Улучшенный алгоритм сравнения
    const similarity = calculateEnhancedSimilarity(mainAnalysis, userAnalysis);
    
    return {
      similarity: Math.min(99, similarity), // Максимум 99% для реалистичности
      pitchComment: getDetailedPitchComment(mainAnalysis, userAnalysis)
    };
  } catch (error) {
    console.error('Comparison error:', error);
    throw error;
  } finally {
    [mainWavPath, userWavPath].forEach(path => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
  }
}

//.............................................

bot.command('start', async (ctx) => {
  const userId = ctx.from.id;

  if (userId === MAIN_USER_ID) {
    ctx.reply('Привет ты главный пользователь этого бота. Запиши голосовое и оно отправиться другим пользователем бота!');
  } else {
    ctx.reply('Привет! Этот бот создан для Ржевского хора. В боте есть главный пользователь — Василий. Василий будет отправлять в бота голосовое сообщение с песнопением! Бот будет отправлять это голосовое всем остальным пользователям. Твоя задача — прослушать голосовое и тоже отправить голосовое с этим песнопением, которое поёшь ты!');
    setTimeout(() => {
      ctx.reply('Когда Василий отправит аудио вам придёт сообщение!');
    }, 200);
  }
});

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const voice = ctx.message.voice.file_id;

  if (userId === MAIN_USER_ID) {
    mainAudioFileId = voice;
    ctx.reply('Хотите назвать голосовое? Если не хотите то можете отправить без названия!', {
      reply_markup: {
        inline_keyboard: [[{ text: "Отправить", callback_data: "sending" }, { text: "Назвать", callback_data: "setName" }]],
      },
    });
  } else {
    userAudioFileId = voice;
    ctx.reply('Сравнить аудио записи? Если что-то не получилось просто запиши и отправь голосовое заново!', {
      reply_markup: {
        inline_keyboard: [[{ text: "Сравнить", callback_data: "sendingUsers" }]],
      },
    });
  }
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;
  if (userId === MAIN_USER_ID) {
    nameMainAudioFileId = userMessage;
    ctx.reply(`Вы хотите оставить такое название - ${userMessage}? Если нет можете снова отправить мне новое название для голосового или отправить голосовое с таким названием!`, {
      reply_markup: {
        inline_keyboard: [[{ text: "Отправить", callback_data: "sending" }]],
      },
    });
  }
});

bot.on("callback_query", async (ctx) => {
  const buttonData = ctx.callbackQuery.data;
  const firstName = ctx.from.first_name;

  try {
    if (buttonData === 'sendingUsers') {
      if (!mainAudioFileId || !userAudioFileId) {
        throw new Error('Не найдены оба аудиофайла для сравнения');
      }

      await ctx.answerCbQuery('Идёт анализ аудио...');
      try {
        const comparisonResult = await compareAudioFiles(ctx, mainAudioFileId, userAudioFileId);

        similarityPercentage = comparisonResult.similarity
        
        let message = `Результат сравнения: ${comparisonResult.similarity}%\n`;
        message += `Комментарий по высоте тона: ${comparisonResult.pitchComment}`;
        
        await ctx.reply(message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Отправить Васе?", callback_data: "sendToVasya" }],
              [{ text: "Переписать", callback_data: "rewrite" }]
            ],
          },
        });
      } catch (error) {
        console.error('Ошибка сравнения:', error);
        throw new Error('Не удалось проанализировать аудио. Убедитесь, что оба сообщения содержат запись голоса.');
      }
    } else if (buttonData === 'sending') {
      await ctx.answerCbQuery('Отправка аудио пользователям...');

      for (const uid of users) {
        if (uid !== MAIN_USER_ID) {
          try {
            await ctx.telegram.sendMessage(uid, 'Василий отправил новое голосовое сообщение! Пожалуйста, отправьте свой ответный голос.');
            if (nameMainAudioFileId) {
              await ctx.telegram.sendMessage(uid, `Название аудио - ${nameMainAudioFileId}`)
            }
            await ctx.telegram.sendVoice(uid, mainAudioFileId);
            nameMainAudioFileId = null;
          } catch (e) {
            console.log(`Не удалось отправить пользователю ${uid}:`, e.message);
          }
        }
      }
      await ctx.reply('Аудио сохранено и отправлено пользователям!');
    } else if (buttonData === 'sendToVasya') {
      await ctx.telegram.sendMessage(
        MAIN_USER_ID,
        `${firstName} отправил ответ!\nРезультат сравнения: ${similarityPercentage}%`
      );
      await ctx.telegram.sendVoice(MAIN_USER_ID, userAudioFileId);
      ctx.reply('Результат отправлен!')
    } else if (buttonData === 'rewrite') {
      ctx.reply('Перезапишите голосовое и отправте его мне!')
    } else if (buttonData === 'setName') {
      ctx.reply('Напишите и пришлите мне название для голосового!')
    }
  } catch (error) {
    console.error('Ошибка:', error);
    await ctx.answerCbQuery('⚠️ Ошибка');
    await ctx.reply(error.message || 'Произошла ошибка. Пожалуйста, попробуйте ещё раз.');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch();