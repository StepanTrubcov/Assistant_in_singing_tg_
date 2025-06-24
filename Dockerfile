
FROM node:18-bullseye

# Install Python and audio dependencies first
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
    && pip3 install --upgrade pip \
    && pip3 install numpy scipy librosa pyworld \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Expose both bot and server ports
EXPOSE 3000 10000

CMD ["node", "index.js"]