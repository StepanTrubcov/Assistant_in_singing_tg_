import { Telegraf } from "telegraf";
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import { execSync } from 'child_process';

// const token = '7786183810:AAF5GXNyUBCge7oWvPdTJ_mluhiMs_EI1GE'
const token = process.env.TOKEN;
const bot = new Telegraf(token)
const MAIN_USER_ID = parseInt(process.env.MAIN_USER_ID);
const users = JSON.parse(process.env.USERS || '[]');

let mainAudioFileId = null;
let userAudioFileId = null;

let nameMainAudioFileId = null;

let similarityPercentage = null;

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

async function getPitchAnalysis(wavPath) {
  try {
    // Alternative method using aubio for pitch detection
    const command = `aubiopitch -i ${wavPath} 2>&1`;
    const output = execSync(command, { maxBuffer: 1024 * 1024 * 10 }).toString();
    
    // Parse the output to get pitch values
    const pitchValues = output.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => parseFloat(line.split(/\s+/)[1]))
      .filter(val => !isNaN(val));
    
    if (pitchValues.length === 0) {
      throw new Error('No pitch values detected');
    }
    
    // Calculate average pitch
    const sum = pitchValues.reduce((a, b) => a + b, 0);
    const avgFrequency = sum / pitchValues.length;
    
    return {
      avgFrequency,
      pitchCount: pitchValues.length
    };
  } catch (error) {
    console.error('Pitch analysis error:', error);
    // Fallback to basic FFT analysis if aubio fails
    return getBasicFrequencyAnalysis(wavPath);
  }
}

async function getBasicFrequencyAnalysis(wavPath) {
  try {
    const command = `ffmpeg -i ${wavPath} -af "astats=metadata=1:reset=1" -f null - 2>&1 | grep "Overall.Frequency"`;
    const output = execSync(command).toString();
    const freqMatch = output.match(/Overall\.Frequency:\s*(\d+\.?\d*)/);
    
    if (freqMatch) {
      return {
        avgFrequency: parseFloat(freqMatch[1]),
        pitchCount: 1
      };
    }
    throw new Error('No frequency data found');
  } catch (error) {
    console.error('Basic frequency analysis failed:', error);
    throw new Error('Could not analyze pitch: ' + error.message);
  }
}

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

async function getAudioFeatures(wavPath) {
  try {
    // 1. Получаем длительность аудио
    const durationCommand = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${wavPath}`;
    const duration = parseFloat(execSync(durationCommand).toString());

    // 2. Упрощенный анализ громкости и пикового уровня
    const analysisCommand = `ffmpeg -i ${wavPath} -af "ebur128=peak=true" -f null - 2>&1 | grep -E 'I:|Peak:'`;
    const analysisOutput = execSync(analysisCommand, { maxBuffer: 1024 * 1024 * 5 }).toString();

    // Извлекаем ключевые параметры
    const loudnessMatch = analysisOutput.match(/I:\s*(-?\d+\.\d+)\s*LUFS/);
    const peakMatch = analysisOutput.match(/Peak:\s*(-?\d+\.\d+)\s*dBFS/);

    if (!loudnessMatch || !peakMatch) {
      throw new Error('Не удалось извлечь параметры громкости');
    }

    return {
      duration,
      loudness: parseFloat(loudnessMatch[1]),
      peak: parseFloat(peakMatch[1])
    };
  } catch (error) {
    console.error('Ошибка анализа аудио:', error);
    throw new Error('Не удалось проанализировать аудио файл');
  }
}

async function compareAudioFiles(ctx, mainAudioFileId, userAudioFileId) {
  const mainWavPath = 'main.wav';
  const userWavPath = 'user.wav';

  try {
    // Конвертация
    await Promise.all([
      downloadAndConvertVoice(ctx, mainAudioFileId, mainWavPath),
      downloadAndConvertVoice(ctx, userAudioFileId, userWavPath)
    ]);

    // Анализ базовых характеристик
    const [mainFeatures, userFeatures] = await Promise.all([
      getAudioFeatures(mainWavPath),
      getAudioFeatures(userWavPath)
    ]);

    console.log('Основные характеристики:', { mainFeatures, userFeatures });

    // Анализ высоты тона
    let mainPitch = { avgFrequency: 0, pitchCount: 0 };
    let userPitch = { avgFrequency: 0, pitchCount: 0 };
    let pitchAnalysisFailed = false;
    
    try {
      [mainPitch, userPitch] = await Promise.all([
        getPitchAnalysis(mainWavPath),
        getPitchAnalysis(userWavPath)
      ]);
      console.log('Анализ высоты тона:', { mainPitch, userPitch });
    } catch (pitchError) {
      console.error('Ошибка анализа высоты тона:', pitchError);
      pitchAnalysisFailed = true;
    }

    // Сравнение характеристик с новыми параметрами
    const comparisons = {
      duration: {
        diff: Math.abs(mainFeatures.duration - userFeatures.duration),
        maxDiff: 5, // Максимально допустимая разница в секундах
        weight: 0.2 // Уменьшено с 0.3
      },
      loudness: {
        diff: Math.abs(mainFeatures.loudness - userFeatures.loudness),
        maxDiff: 20, // Максимально допустимая разница в LUFS
        weight: 0.2 // Уменьшено с 0.3
      },
      peak: {
        diff: Math.abs(mainFeatures.peak - userFeatures.peak),
        maxDiff: 10, // Максимально допустимая разница в dBFS
        weight: 0.2 // Оставлено без изменения
      }
    };

    // Если анализ частоты успешен, добавляем его с увеличенным весом
    if (!pitchAnalysisFailed && mainPitch.pitchCount > 0 && userPitch.pitchCount > 0) {
      comparisons.frequency = {
        diff: Math.abs(mainPitch.avgFrequency - userPitch.avgFrequency),
        maxDiff: 100, // Теперь 0% сходства при разнице 100 Гц или более
        weight: 0.4 // Увеличено с 0.2 до 0.4 (40%)
      };
    } else {
      // Если анализ частоты не удался, перераспределяем веса
      const remainingWeight = 0.4;
      const totalOtherWeights = 0.2 + 0.2 + 0.2; // duration + loudness + peak
      const scaleFactor = 1 + remainingWeight / totalOtherWeights;
      
      comparisons.duration.weight *= scaleFactor;
      comparisons.loudness.weight *= scaleFactor;
      comparisons.peak.weight *= scaleFactor;
    }

    // Расчет сходства
    let totalSimilarity = 0;
    let totalWeight = 0;

    for (const [key, { diff, maxDiff, weight }] of Object.entries(comparisons)) {
      const similarity = 100 * (1 - Math.min(diff / maxDiff, 1));
      totalSimilarity += similarity * weight;
      totalWeight += weight;
      console.log(`${key}: разница ${diff.toFixed(2)}, сходство ${similarity.toFixed(2)}%, вес ${weight}`);
    }

    const finalSimilarity = totalSimilarity / totalWeight;
    const adjustedSimilarity = Math.max(0, Math.min(100, finalSimilarity.toFixed(2)));

    // Формируем комментарий о высоте тона
    let pitchComment = 'Не удалось проанализировать высоту тона';
    let pitchDifference = 0;

    if (!pitchAnalysisFailed && mainPitch.pitchCount > 0 && userPitch.pitchCount > 0) {
      pitchDifference = mainPitch.avgFrequency - userPitch.avgFrequency;
      const absDiff = Math.abs(pitchDifference);
      
      if (absDiff >= 100) {
        pitchComment = pitchDifference > 0 
          ? 'Вы поёте значительно ниже оригинала (разница ≥100 Гц)' 
          : 'Вы поёте значительно выше оригинала (разница ≥100 Гц)';
      } else if (absDiff > 50) {
        pitchComment = pitchDifference > 0 
          ? 'Вы поёте ниже оригинала (разница 50-100 Гц)' 
          : 'Вы поёте выше оригинала (разница 50-100 Гц)';
      } else if (absDiff > 20) {
        pitchComment = pitchDifference > 0 
          ? 'Вы поёте немного ниже оригинала (разница 20-50 Гц)' 
          : 'Вы поёте немного выше оригинала (разница 20-50 Гц)';
      } else {
        pitchComment = 'Высота тона отлично совпадает (разница <20 Гц)';
      }
      
      pitchComment += `\nСредняя частота: оригинал ${mainPitch.avgFrequency.toFixed(2)} Гц, ваш вариант ${userPitch.avgFrequency.toFixed(2)} Гц`;
      pitchComment += `\nВклад в общее сходство: ${(100 * (1 - Math.min(absDiff / 100, 1)) * 0.4).toFixed(1)}% (из 40%)`;
    }

    console.log(`Итоговое сходство: ${adjustedSimilarity}%`);
    return {
      similarity: adjustedSimilarity,
      pitchComment,
      pitchAnalysisFailed
    };

  } catch (error) {
    console.error('Ошибка сравнения:', error);
    throw new Error('Не удалось сравнить аудио: ' + error.message);
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