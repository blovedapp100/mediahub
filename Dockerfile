FROM node:20-slim

# yt-dlp (python) + ffmpeg for reading links and joining separate video/audio streams
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

# Cloudflare WARP (free, no account) — Render's IPs are blocked by
# YouTube/TikTok, so yt-dlp routes those calls through a userspace
# WireGuard tunnel (wireproxy) instead. SHA256 pins verified 2026-11-23.
ARG WGCF_SHA256=69147e1a517c66129edd8ac8cb60484d6c9515178d7b4a2f95e3c925f225572a
ARG WIREPROXY_SHA256=b7dcff8f6e9d3410364e432aff24154eaa8db8206e0c6faac35d6c6ab06dac51
RUN curl -fsSL -o /tmp/wgcf https://github.com/ViRb3/wgcf/releases/download/v2.2.31/wgcf_2.2.31_linux_amd64 \
 && echo "$WGCF_SHA256  /tmp/wgcf" | sha256sum -c - \
 && install -m 0755 /tmp/wgcf /usr/local/bin/wgcf && rm /tmp/wgcf \
 && curl -fsSL -o /tmp/wireproxy.tar.gz https://github.com/windtf/wireproxy/releases/download/v1.1.2/wireproxy_linux_amd64.tar.gz \
 && echo "$WIREPROXY_SHA256  /tmp/wireproxy.tar.gz" | sha256sum -c - \
 && tar --no-same-owner -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin wireproxy && rm /tmp/wireproxy.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
