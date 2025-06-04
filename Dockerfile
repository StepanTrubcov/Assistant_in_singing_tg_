FROM node:18-bullseye

# Устанавливаем зависимости для аудиоанализа
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    libsndfile1 \
    libfftw3-3 \
    libsamplerate0 \
    libavcodec-extra \
    sox \
    libblas-dev \
    liblapack-dev \
    && pip3 install numpy aubio essentia tensorflowjs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Указываем, что контейнер может принимать входящие соединения на порту 10000
EXPOSE 10000

# Запускаем Node.js сервер на порту 10000
CMD ["node", "index.js"]