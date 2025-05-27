FROM node:18-alpine

# Устанавливаем зависимости для ffmpeg и aubio
RUN apk add --no-cache \
    ffmpeg \
    build-base \
    python3 \
    python3-dev \
    py3-pip \
    libsndfile-dev \
    fftw-dev \
    libsamplerate-dev \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    libavfilter-dev \
    libavdevice-dev \
    libjpeg-turbo-dev \
    libpng-dev \
    libwebp-dev \
    libtiff-dev \
    gfortran \
    openblas-dev

# Устанавливаем aubio через pip
RUN pip3 install aubio

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "main.js"]