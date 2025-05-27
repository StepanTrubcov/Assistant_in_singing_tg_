FROM node:18-alpine

# Установка зависимостей для ffmpeg и aubio
RUN apk add --no-cache ffmpeg aubio-tools build-base python3

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

CMD ["npm", "start"]