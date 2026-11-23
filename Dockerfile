FROM node:20-slim

# yt-dlp (python) + ffmpeg for reading links and joining separate video/audio streams
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
