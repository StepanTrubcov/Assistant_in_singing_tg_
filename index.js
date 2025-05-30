import { Telegraf } from "telegraf";
import axios from 'axios';
import FormData from "form-data";

const token = '7523112354:AAF84dgow0u0klV8BFRhvJRwiQHFKtTCsbk'

const bot = new Telegraf(token)
const MAIN_USER_ID = 5102803347
const users = [7779459253];
//7779459253 

let mainAudioFileId = null;
let userAudioFileId = null;

let nameMainAudioFileId = null;

let similarityPercentage = null;

async function getFileUrl(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
}

async function compareAudioFilesOnServer(ctx, mainFileId, userFileId) {
  try {
    const mainFileUrl = await getFileUrl(ctx, mainFileId);
    const userFileUrl = await getFileUrl(ctx, userFileId);

    const [mainRes, userRes] = await Promise.all([
      axios.get(mainFileUrl, { responseType: 'arraybuffer' }),
      axios.get(userFileUrl, { responseType: 'arraybuffer' }),
    ]);

    const formData = new FormData();
    formData.append('main_audio', mainRes.data, {
      filename: 'main.ogg',
      contentType: 'audio/ogg',
    });
    formData.append('user_audio', userRes.data, {
      filename: 'user.ogg',
      contentType: 'audio/ogg',
    });

    const response = await axios.post('http://localhost:8000/compare/', formData, {
      headers: formData.getHeaders(),
    });

    if (response.data.status !== "success") {
      throw new Error(response.data.message || "Неизвестная ошибка сервера");
    }

    return {
      similarity: response.data.similarity_percentage
    };

  } catch (error) {
    console.error('Ошибка сравнения:', error);
    throw new Error(`Не удалось сравнить аудио: ${error.message}`);
  }
}


//......................................................

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
      await ctx.answerCbQuery('Идёт анализ аудио...');

      const comparisonResult = await compareAudioFilesOnServer(ctx, mainAudioFileId, userAudioFileId);


      similarityPercentage = comparisonResult.similarity;

      let message = `Результат сравнения: ${comparisonResult.similarity}%\n`;

      await ctx.reply(message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Отправить Васе?", callback_data: "sendToVasya" }],
            [{ text: "Переписать", callback_data: "rewrite" }]
          ],
        },
      });
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