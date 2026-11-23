#!/bin/sh
# Start Cloudflare WARP (free) in the background when it can start; the
# server must start regardless — if WARP is unavailable the site falls
# back to direct yt-dlp calls (server.js checks the proxy port first).
cd /app
if command -v wgcf >/dev/null 2>&1 && command -v wireproxy >/dev/null 2>&1; then
  if [ ! -f /app/wgcf-profile.conf ]; then
    wgcf register --accept-tos >/dev/null 2>&1 || true
    wgcf generate >/dev/null 2>&1 || true
  fi
  if [ -f /app/wgcf-profile.conf ]; then
    if ! grep -q "^\[Socks5\]" /app/wgcf-profile.conf 2>/dev/null; then
      printf '\n[Socks5]\nBindAddress = 127.0.0.1:25344\n' >> /app/wgcf-profile.conf
    fi
    wireproxy -c /app/wgcf-profile.conf >/tmp/wireproxy.log 2>&1 &
    # Wait briefly for the tunnel to come up (max ~6s), then continue
    # regardless — server.js probes the port and falls back to direct.
    i=0
    while [ "$i" -lt 12 ]; do
      if curl -fsS -m 2 --socks5 127.0.0.1:25344 https://www.cloudflare.com/cdn-cgi/trace >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
      i=$((i + 1))
    done
  fi
fi
exec node server.js
