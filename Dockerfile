FROM node:18-alpine

# Устанавливаем только необходимые зависимости
RUN apk add --no-cache \
    ffmpeg \
    build-base \
    python3 \
    py3-pip \
    libsndfile-dev \
    fftw-dev

# Устанавливаем aubio через pip с явным указанием версии
RUN pip3 install numpy aubio==0.4.9

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "main.js"]