// Save Video server — paste a link, preview the clip, pick a quality, save it.
// No visitor data is stored. URLs are never written to logs.
// Info responses are cached in memory (10 min, keyed by a hash of the link).
const express = require('express');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h', etag: true,
  setHeaders: (res, filePath) => {
    // HTML/JS/CSS must never stay cached after a deploy — a stale app.js
    // kept the old (pre-timer, pre-/api/meta) frontend live for an hour.
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---- cross-origin fallback -------------------------------------------------
// The site runs in two regions (Oregon + a backup region). Each region's
// frontend may call the OTHER region's API when its own region is blocked
// by YouTube/TikTok — that only works if the API answers cross-origin
// requests from the sibling site. Allowed origins come from env.
// One backup region was not enough — the site now keeps a LIST of backup
// regions and tries them in order until one answers. Env BACKUP_ORIGINS
// is comma-separated; the old singular BACKUP_ORIGIN is still honoured
// as a single entry.
const BACKUP_ORIGINS = (process.env.BACKUP_ORIGINS || process.env.BACKUP_ORIGIN || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
  }
  next();
});

// ---- helpers ---------------------------------------------------------------

const ALLOWED_HOSTS = [
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com',
  'facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com',
  'fb.watch', 'www.fb.watch',
  'instagram.com', 'www.instagram.com',
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
  'reddit.com', 'www.reddit.com', 'old.reddit.com',
  'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
  'dailymotion.com', 'www.dailymotion.com', 'dai.ly', 'www.dai.ly',
  // New client-side platforms (added 2026-11-24): the server only ever
  // reads these links' INFO — the video file itself is downloaded by the
  // visitor's own browser, from the video CDN, on their own IP.
  'bsky.app', 'www.bsky.app',
  'tumblr.com', 'www.tumblr.com', 'tmblr.co', 'www.tmblr.co', 'at.tumblr.com',
  'twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'www.clips.twitch.tv',
  'm.twitch.tv',
  'pinterest.com', 'www.pinterest.com', 'pin.it', 'www.pin.it',
  'linkedin.com', 'www.linkedin.com',
  'mojapp.in', 'www.mojapp.in',
  'sharechat.com', 'www.sharechat.com',
  'snapchat.com', 'www.snapchat.com', 't.snapchat.com', 'story.snapchat.com',
  'v.qq.com', 'www.v.qq.com', 'm.v.qq.com',
  // Douyin (added 2026-11-24): the server only ever reads the video's
  // INFO through Douyin's own embed-player API — the file itself is
  // downloaded by the visitor's own browser, from Douyin's CDN.
  'douyin.com', 'www.douyin.com', 'v.douyin.com', 'www.iesdouyin.com',
  // Chinese no-login platforms (added 2026-11-24): Kuaishou, Haokan,
  // Pear Video, Zhihu — same rule as Douyin: the server only ever reads
  // a link's INFO; the video file is downloaded by the visitor's own
  // browser, from the video CDN, on their own IP. No login anywhere.
  'kuaishou.com', 'www.kuaishou.com', 'v.kuaishou.com', 'kwai.com', 'www.kwai.com',
  'haokan.baidu.com', 'www.haokan.baidu.com',
  'pearvideo.com', 'www.pearvideo.com',
  'zhihu.com', 'www.zhihu.com',
  // Weibo + Sohu (added 2026-11-24): same rule — the server only reads
  // a link's INFO via yt-dlp's own extractors; the file is downloaded
  // by the visitor's own browser. No login anywhere (see the /api/info
  // note on Weibo's anonymous guest token and Sohu's per-video geo rule).
  'weibo.com', 'www.weibo.com', 'm.weibo.cn',
  'tv.sohu.com', 'www.tv.sohu.com',
];

function hostAllowed(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return ALLOWED_HOSTS.includes(h) || ALLOWED_HOSTS.some((d) => h.endsWith('.' + d));
  } catch { return false; }
}

// Only the ranges that make SSRF dangerous are blocked: loopback
// (127/8, ::1), RFC1918 private networks (10/8, 172.16/12, 192.168/16,
// fc00::/7), link-local (169.254/16 — including the cloud metadata
// address 169.254.169.254 — and fe80::/10), and 0/8. Deliberately NOT
// blocked: CGNAT (100.64/10) and benchmarking space (198.18/15) —
// proxied environments (and this sandbox's own resolver) answer public
// hostnames with those addresses, so blocking them would reject every
// legitimate link. The allowlist above is the primary gate; this check
// only stops a listed hostname ever pointing at an internal address.
function isPrivateIP(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — judge the embedded IPv4 part.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ip4 = mapped ? mapped[1] : v;
  if (net.isIP(ip4) === 4) {
    const [a, b] = ip4.split('.').map(Number);
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
    if (a === 0) return true; // 0/8
    if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
    return false;
  }
  if (net.isIP(v) === 6) {
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // fe80::/10
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 unique-local
    if (v.startsWith('2001:db8')) return true; // documentation
    return false;
  }
  return true; // unparseable: treat as unsafe
}
const dnsVerdict = new Map(); // hostname -> { at, ok }
async function hostResolvesPublic(hostname) {
  const h = String(hostname || '').toLowerCase();
  const cached = dnsVerdict.get(h);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.ok;
  let ok = true; // resolver error: allow — yt-dlp fails on unresolvable names anyway
  try {
    const addrs = await dns.lookup(h, { all: true, verbatim: true });
    if (!addrs.length) ok = false;
    else ok = addrs.every((a) => !isPrivateIP(a.address));
  } catch { ok = true; }
  if (dnsVerdict.size >= 200) {
    const first = dnsVerdict.keys().next().value;
    if (first) dnsVerdict.delete(first);
  }
  dnsVerdict.set(h, { at: Date.now(), ok });
  return ok;
}
// Full check for a user-pasted link: http(s) only, no embedded
// credentials, hostname on the allowlist, and (DNS) publicly resolvable.
async function validateUserUrl(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.username || parsed.password) return false;
  if (!hostAllowed(u)) return false;
  return hostResolvesPublic(parsed.hostname);
}

function isTikTok(u) {
  try { return new URL(u).hostname.toLowerCase().includes('tiktok.com'); } catch { return false; }
}

function isYouTube(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com');
  } catch { return false; }
}

function platformOf(u) {
  if (isYouTube(u)) return 'youtube';
  if (isTikTok(u)) return 'tiktok';
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

// ---- client-side-only platforms (added 2026-11-24) -------------------------
// HARD RULE: downloading NEVER happens on any server. The video bytes come
// from the VISITOR'S OWN BROWSER, on their own IP and internet — the server
// only reads a link's INFO (title, formats, direct CDN links) and never
// touches the file itself. These platforms therefore get NO server-side
// save: /api/save refuses them, and /api/info only offers direct single
// files (see buildDirectFormats) that the browser fetches itself.
// Platforms whose videos have NO direct single file (HLS/DASH playlists
// only, or unplayable segments) are NOT listed at all — see the report.
const CLIENT_SIDE_ONLY = new Set([
  'x', 'twitter', 'bluesky', 'tumblr', 'twitch', 'pinterest',
  'linkedin', 'moj', 'sharechat', 'snapchat', 'tencent', 'douyin',
  'kuaishou', 'haokan', 'pear', 'zhihu', 'weibo', 'sohu',
]);
function clientSideKey(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === 'x.com' || h.endsWith('.x.com') || h === 'twitter.com' || h.endsWith('.twitter.com')) return 'x';
    if (h === 'bsky.app' || h.endsWith('.bsky.app')) return 'bluesky';
    if (h === 'tumblr.com' || h.endsWith('.tumblr.com') || h === 'tmblr.co' || h.endsWith('.tmblr.co')) return 'tumblr';
    if (h === 'twitch.tv' || h.endsWith('.twitch.tv')) return 'twitch';
    if (h === 'pinterest.com' || h.endsWith('.pinterest.com') || h === 'pin.it' || h.endsWith('.pin.it')) return 'pinterest';
    if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return 'linkedin';
    if (h === 'mojapp.in' || h.endsWith('.mojapp.in')) return 'moj';
    if (h === 'sharechat.com' || h.endsWith('.sharechat.com')) return 'sharechat';
    if (h === 'snapchat.com' || h.endsWith('.snapchat.com')) return 'snapchat';
    if (h === 'v.qq.com' || h.endsWith('.v.qq.com')) return 'tencent';
    if (h === 'douyin.com' || h.endsWith('.douyin.com') || h === 'iesdouyin.com' || h.endsWith('.iesdouyin.com')) return 'douyin';
    if (h === 'kuaishou.com' || h.endsWith('.kuaishou.com') || h === 'kwai.com' || h.endsWith('.kwai.com')) return 'kuaishou';
    if (h === 'haokan.baidu.com' || h.endsWith('.haokan.baidu.com')) return 'haokan';
    if (h === 'pearvideo.com' || h.endsWith('.pearvideo.com')) return 'pear';
    if (h === 'zhihu.com' || h.endsWith('.zhihu.com')) return 'zhihu';
    if (h === 'weibo.com' || h.endsWith('.weibo.com') || h === 'm.weibo.cn' || h.endsWith('.m.weibo.cn')) return 'weibo';
    if (h === 'tv.sohu.com' || h.endsWith('.tv.sohu.com')) return 'sohu';
  } catch {}
  return null;
}
function isClientSideOnly(url) { return CLIENT_SIDE_ONLY.has(clientSideKey(url)); }

// Extra yt-dlp args per host. YouTube bot-checks datacenter IPs on its web
// player, so try the Android client first, then iOS, then the default web
// client — the app clients usually answer where the web player refuses.
function ytdlpExtraArgs(url) {
  return isYouTube(url) ? ['--extractor-args', 'youtube:player_client=android'] : [];
}
function ytdlpFallbackArgs(url) {
  return isYouTube(url)
    ? ['--extractor-args', 'youtube:player_client=ios']
    : ['--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'];
}

// Strip any URL out of a string before it is logged.
function scrub(s) { return String(s || '').replace(/https?:\/\/\S+/g, '[link]'); }

function safeTitle(t, fallback) {
  let s = String(t || fallback || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback || 'video';
}

// Build a Content-Disposition value Node.js will never reject: the plain
// filename is ASCII-only (emoji / non-Latin chars dropped), and the real
// title travels percent-encoded in filename* (RFC 5987). A raw emoji in a
// header used to throw ERR_INVALID_CHAR and kill the whole process.
function contentDisposition(title, ext) {
  const raw = String(title || 'video');
  let ascii = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126 && ch !== '"' && ch !== "'") ascii += ch;
  }
  ascii = ascii.trim().slice(0, 100) || 'video';
  const encoded = encodeURIComponent(raw).slice(0, 200);
  return 'attachment; filename="' + ascii + '.' + ext + '"; filename*=UTF-8' + "''" + encoded + '.' + ext;
}

function setDownloadHeaders(res, title, ext, contentType) {
  res.setHeader('Content-Type', contentType);
  try {
    res.setHeader('Content-Disposition', contentDisposition(title, ext));
  } catch {
    res.setHeader('Content-Disposition', 'attachment; filename="video.' + ext + '"');
  }
}

// Stream a direct file URL straight to the client. Returns true when the
// download started, false when the URL did not answer — the caller then
// falls back to the yt-dlp save. Headers are only set after the fetch
// succeeds, so a failed attempt commits nothing.
async function streamThrough(res, streamUrl, title, ext, contentType) {
  const r = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok || !r.body) return false;
  setDownloadHeaders(res, title, ext, contentType);
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch { try { res.end(); } catch {} }
  return true;
}

// Last resort: never let one bad request kill the server for everyone.
process.on('uncaughtException', (e) => {
  console.error('uncaught:', scrub(String((e && e.stack) || e)).slice(0, 1000));
});

// ---- info cache (hash-keyed, 10 min TTL, max 200 entries) -------------------
const INFO_TTL = 10 * 60 * 1000;
const infoCache = new Map();
function cacheKey(url) {
  return crypto.createHash('sha256').update(url.trim()).digest('hex');
}
function cacheGet(url) {
  const e = infoCache.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > INFO_TTL) { infoCache.delete(cacheKey(url)); return null; }
  return e.data;
}
function cacheSet(url, data) {
  if (infoCache.size >= 200) {
    const first = infoCache.keys().next().value;
    if (first) infoCache.delete(first);
  }
  infoCache.set(cacheKey(url), { at: Date.now(), data });
}

// Raw info (with direct stream URLs) for /api/save: the public result
// above drops the URLs, but a save can stream a direct URL instead of
// running yt-dlp a second time — which matters when yt-dlp only answers
// through one specific client on this IP.
const rawCache = new Map();
function rawCacheSet(url, info) {
  if (rawCache.size >= 200) {
    const first = rawCache.keys().next().value;
    if (first) rawCache.delete(first);
  }
  rawCache.set(cacheKey(url), { at: Date.now(), info });
}
function rawCacheGet(url) {
  const e = rawCache.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > INFO_TTL) { rawCache.delete(cacheKey(url)); return null; }
  return e.info;
}

// Winning yt-dlp client args per URL (same TTL) — see ytdlpInfoWithFallbacks.
const rawClient = new Map();
function rawClientSet(url, args) {
  if (rawClient.size >= 200) {
    const first = rawClient.keys().next().value;
    if (first) rawClient.delete(first);
  }
  rawClient.set(cacheKey(url), { at: Date.now(), args: args || null });
}
function rawClientGet(url) {
  const e = rawClient.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > INFO_TTL) { rawClient.delete(cacheKey(url)); return null; }
  return e.args;
}

// Whether the winning info for a URL came through the WARP proxy (same
// TTL) — /api/save must use the same egress that produced the info.
const rawProxy = new Map();
function rawProxySet(url, viaProxy) {
  if (rawProxy.size >= 200) {
    const first = rawProxy.keys().next().value;
    if (first) rawProxy.delete(first);
  }
  rawProxy.set(cacheKey(url), { at: Date.now(), viaProxy: viaProxy === true });
}
function rawProxyGet(url) {
  const e = rawProxy.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > INFO_TTL) { rawProxy.delete(cacheKey(url)); return null; }
  return e.viaProxy;
}

// ---- per-IP rate limit (counts only, no URLs stored) ------------------------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => now - t < 600000);
    if (kept.length) hits.set(ip, kept); else hits.delete(ip);
  }
}, 60000).unref();

// ---- TikTok via the free tikwm API (primary), yt-dlp as fallback -----------

// Short TikTok links (tiktok.com/t/<code> — the form the app shares
// when a user taps "Share" in TikTok) cost yt-dlp an extra redirect hop,
// which pushes its round-1 attempts past the 8s timeout: locally the
// short form took 24.8s (round 1 dead, round 2 saved it) against 12.7s
// for the canonical URL — 0.2s from the 25s outer cap, so one slow day
// turns a working-egress success into a 502. Resolve the 301 once (no
// body downloaded, 5s cap, same-host only) and extract on the canonical
// video URL instead. Any failure returns the original link untouched.
async function resolveTikTokShort(url) {
  try {
    const u = new URL(url);
    if (!/tiktok\.com$/.test(u.hostname.toLowerCase())) return url;
    if (!/^\/t\/[^/]+\/?$/.test(u.pathname)) return url;
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(current, {
          signal: ctrl.signal, redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const loc = r.headers.get('location');
        if (!loc) return url;
        const abs = new URL(loc, current).href;
        if (!/tiktok\.com$/.test(new URL(abs).hostname.toLowerCase())) return url;
        if (abs.includes('/video/')) return abs;
        current = abs;
      } catch { return url; } finally { clearTimeout(timer); }
    }
    return url;
  } catch { return url; }
}

async function tikwmInfo(url, timeoutMs = 12000) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    if (j && j.code === 0 && j.data && j.data.play) {
      const d = j.data;
      const formats = [];
      if (d.hdplay) formats.push({ id: 'tikwm-hd', label: 'HD', ext: 'mp4', hasAudio: true, filesize: 0, note: 'Best quality', url: d.hdplay });
      formats.push({ id: 'tikwm-sd', label: 'SD', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: d.play });
      if (d.music) formats.push({ id: 'tikwm-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only', url: d.music });
      return {
        source: 'tiktok',
        title: d.title || ('TikTok video by ' + (d.author && d.author.nickname ? d.author.nickname : 'unknown')),
        thumbnail: d.cover || '',
        duration: d.duration || 0,
        uploader: (d.author && d.author.nickname) || '',
        previewUrl: d.hdplay || d.play || '',
        formats,
      };
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function tikwmStreamUrl(url, kind) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    if (!j || j.code !== 0 || !j.data) return null;
    if (kind === 'tikwm-hd') return j.data.hdplay || j.data.play || null;
    if (kind === 'tikwm-sd') return j.data.play || null;
    if (kind === 'tikwm-audio') return j.data.music || null;
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- Cloudflare WARP egress -------------------------------------------------
// Render's IPs are blocked by YouTube/TikTok in every region, so yt-dlp
// cannot read those links direct. The fix is a userspace WireGuard tunnel
// to Cloudflare WARP (free, no account) running inside the container:
// wireproxy exposes a local SOCKS5 proxy and yt-dlp routes its
// YouTube/TikTok calls through it. Facebook/Instagram already work
// direct, so they never use the proxy. If the proxy is down, calls fall
// back to direct — a WARP outage never takes the whole site down.
// The verdict is cached for 5 minutes, then re-checked.
const WARP_PORT = 25344;
const WARP_PROXY = 'socks5://127.0.0.1:' + WARP_PORT;
let warpUp = null;
let warpUpAt = 0;
const WARP_CHECK_TTL_MS = 5 * 60 * 1000;
function warpCheck() {
  const now = Date.now();
  if (warpUp !== null && now - warpUpAt < WARP_CHECK_TTL_MS) return Promise.resolve(warpUp);
  return new Promise((resolve) => {
    const s = net.connect(WARP_PORT, '127.0.0.1');
    const done = (v) => { warpUp = v; warpUpAt = Date.now(); try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(2000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
// allowProxy=false forces direct (no --proxy flag at all). Direct is
// always tried first: on a host whose own IP works, direct wins, and the
// proxy is only the fallback when direct fails — otherwise WARP would
// mask a working IP (that is exactly what happened on the first WARP
// deploy: the proxy was up, so every call used it).
// Tumblr is a WARP platform too: its pages and CDN are the ones failing
// from Render's IPs, same as YouTube/TikTok. Every other host stays
// direct-only — the proxy is never spent on a host that works without it.
function isWarpPlatform(url) {
  if (isYouTube(url) || isTikTok(url)) return true;
  const k = clientSideKey(url);
  return k === 'tumblr';
}
async function proxyArgs(url, allowProxy = true) {
  if (!allowProxy) return [];
  if (!isWarpPlatform(url)) return [];
  return (await warpCheck()) ? ['--proxy', WARP_PROXY] : [];
}

// ---- Background sessions (cookies) ----------------------------------------
// The screen stays just the downloader — no login, no cookie UI anywhere.
// Sessions live ONLY on the server, in the background: the owner's own
// logged-in cookies for YouTube / TikTok / Facebook / Instagram, supplied
// as environment variables (COOKIES_YOUTUBE, COOKIES_TIKTOK,
// COOKIES_FACEBOOK, COOKIES_INSTAGRAM — each a full Netscape cookies.txt
// file's contents; COOKIES_TXT is the combined fallback for all four) or
// as local files cookies-<platform>.txt / cookies.txt (local dev only).
// At startup each one is written to the temp dir and passed to yt-dlp as
// --cookies, so downloads go out as the logged-in session instead of
// anonymous. That is the only way a server can use a login: a website can
// never read a visitor's browser cookies (same-origin rule), and a Google
// sign-in only proves who someone is — it hands over no cookies and logs
// nobody into TikTok/Facebook/Instagram. So sessions come from the owner
// exporting his own cookies, never from visitors.
// Safety: cookie contents are NEVER logged and NEVER returned by any API
// — /api/health reports only true/false per platform. Nothing is stored
// in git (see .gitignore) and nothing is written to disk outside tmp.
// Without cookies the site behaves exactly as before.
const COOKIE_PLATFORMS = ['youtube', 'tiktok', 'facebook', 'instagram'];
const cookieFiles = {};
// Parse a Netscape cookies.txt string: returns the cookie lines (non-empty,
// non-comment), or null when the content is not a Netscape file at all.
// Shared by startup loading and the /api/cookies sync endpoint.
function netscapeLines(content) {
  const lines = String(content || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length || !lines.some((l) => l.split('\t').length >= 6)) return null;
  // Strict flag check (MozillaCookieJar rule): the flag field must be TRUE
  // exactly when the domain starts with '.', FALSE otherwise. A mismatch
  // makes yt-dlp reject the whole file ("invalid Netscape format") while
  // health would still flip true — so reject it here with a 400 instead
  // of storing a file that silently does nothing. Added 2026-11-24.
  for (const l of lines) {
    const f = l.split('\t');
    if (f.length >= 7) {
      const wantsTrue = f[0].startsWith('.');
      if ((f[1] === 'TRUE') !== wantsTrue) return null;
    }
  }
  return lines;
}
function loadCookies() {
  for (const p of COOKIE_PLATFORMS) {
    const envName = 'COOKIES_' + p.toUpperCase();
    let content = process.env[envName] || process.env.COOKIES_TXT || '';
    if (!content) {
      for (const f of [`cookies-${p}.txt`, 'cookies.txt']) {
        try {
          const fp = path.join(__dirname, f);
          if (fs.existsSync(fp)) { content = fs.readFileSync(fp, 'utf8'); break; }
        } catch {}
      }
    }
    if (!content || !content.trim()) continue;
    // A real Netscape file is tab-separated lines; a pasted single cookie
    // or an empty file is not usable — skip it loudly instead of passing
    // junk to yt-dlp on every call.
    const lines = netscapeLines(content);
    if (!lines) {
      console.error(`cookies ignored for ${p}: not a Netscape cookies.txt file`);
      continue;
    }
    try {
      const file = path.join(os.tmpdir(), `mediahub-cookies-${p}.txt`);
      fs.writeFileSync(file, content, { mode: 0o600 });
      cookieFiles[p] = file;
      console.log(`cookies loaded for ${p} (${lines.length} cookies)`);
    } catch (e) {
      console.error(`cookies failed for ${p}:`, scrub(e.message));
    }
  }
}
loadCookies();
function platformKey(url) {
  if (isYouTube(url)) return 'youtube';
  if (isTikTok(url)) return 'tiktok';
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('facebook.com') || h.includes('fb.watch')) return 'facebook';
    if (h.includes('instagram.com')) return 'instagram';
  } catch {}
  return null;
}
// --cookies for this link's platform, or [] when no session is loaded.
function cookieArgs(url) {
  const p = platformKey(url);
  return p && cookieFiles[p] ? ['--cookies', cookieFiles[p]] : [];
}
function cookieStatus() {
  const out = {};
  for (const p of COOKIE_PLATFORMS) out[p] = Boolean(cookieFiles[p]);
  return out;
}

// ---- yt-dlp ----------------------------------------------------------------

// Geo-block detection: yt-dlp raises GeoRestrictedError for a video
// the uploader restricted by country, and YoutubeDL renders it to
// stderr as "The uploader has not made this video available in your
// country" + "This video is available in <countries>." + a VPN/proxy
// hint. ytdlpJson only keeps the LAST 2 stderr lines, so the countries
// line and the VPN hint are what survive — match those, plus the
// first-line phrasings other extractors use. A geo-blocked video is
// PUBLIC, just not in this region: it is not private, login-only or
// deleted, so another region may still read it.
function isGeoBlocked(text) {
  const t = String(text || '');
  return /not available in your country/i.test(t)
    || /uploader has not made this video available/i.test(t)
    || /this video is available in [A-Z]/i.test(t)
    || /you might want to use a vpn or a proxy/i.test(t)
    || /geo[- ]?restricted/i.test(t)
    || /blocked in your country/i.test(t);
}

// Geo text in the watch page's own player status — YouTube puts the geo
// reason in playabilityStatus.errorScreen ("The uploader has not made
// this video available in your country"), and the plain page fetch
// answers in ~2s. Only the playabilityStatus slice is checked: the rest
// of the page carries descriptions and comments that could mention
// geo-blocking without THIS video being blocked. A playable video's
// slice says PLAYABLE (no geo text) and a private video's says "This
// video is private" — both return false, so the probe is inconclusive
// and the normal rounds decide. No playabilityStatus at all (consent
// page, /sorry redirect) is also inconclusive.
function geoBlockedInPlayer(html) {
  const i = String(html || '').indexOf('playabilityStatus');
  if (i < 0) return false;
  return isGeoBlocked(String(html).slice(i, i + 3000));
}

function ytdlpJson(url, timeoutMs = 60000, extraArgs = [], allowProxy = true) {
  return (async () => {
    const pargs = await proxyArgs(url, allowProxy);
    return new Promise((resolve, reject) => {
    execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15', ...extraArgs, ...pargs, ...cookieArgs(url), url],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
          // The real reason (e.g. "Sign in to confirm you're not a bot")
          // is kept for the server log only — the user just sees the
          // friendly message above.
          e.detail = String(stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) || String(err.message || '').slice(0, 200);
          return reject(e);
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Could not read this link.')); }
      });
    });
  })();
}

// Richness of an info result: highest video height first, then most
// formats. The Android client answers fastest but only ever offers 360p,
// while tv_embedded (a few seconds slower) has the full 1080p list —
// picking the first success would hide every quality above 360p.
function infoScore(info) {
  const list = Array.isArray(info.formats) ? info.formats : [];
  let maxH = 0, count = 0;
  for (const f of list) {
    if (!f || f.ext === 'mhtml') continue;
    count++;
    if ((f.height || 0) > maxH) maxH = f.height || 0;
  }
  return maxH * 1000 + count;
}

function withTimeout(promise, ms, msg) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); }),
  ]);
}

// Info lookup: everything races in parallel and the richest success wins.
// YouTube/TikTok run in TWO rounds — direct first (8s), then the WARP
// proxy round (12s). Direct first, so a host whose own IP works never
// hides behind the proxy; the proxy only runs when direct fails.
// YouTube: android + web_embedded + tv_embedded clients race the
// Invidious/Piped mirrors, and the result with the most qualities is
// kept. TikTok: the plain client races two other API hostnames (the
// iPhone user-agent breaks TikTok in yt-dlp, so it is NOT used here).
// Everything else: plain + iPhone user-agent, 20s, direct only —
// except Tumblr, which gets a second WARP-proxy round (20s) after
// the direct round (15s), because Render's IPs fail on it.
// Returns { info, clientArgs, viaProxy } — clientArgs are the yt-dlp
// extra args of the client that produced this info (null for mirrors),
// so /api/save can download with the same client AND the same egress:
// a format from tv_embedded does not exist for the android client, and
// a save with the wrong client fails.
async function ytdlpInfoWithFallbacks(url) {
  const wrapErr = (e) => {
    const err = new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
    err.detail = (e && e.errors && e.errors.map((x) => x && x.detail).filter(Boolean).join(' | ')) || (e && e.detail) || '';
    if (isGeoBlocked(err.detail)) {
      err.message = 'This video is blocked in this region.';
      err.geoBlocked = true;
    }
    return err;
  };
  const tag = (p, args) => p.then((info) => ({ info, clientArgs: args }));
  if (isYouTube(url)) {
    const clients = [
      ['--extractor-args', 'youtube:player_client=android'],
      ['--extractor-args', 'youtube:player_client=web_embedded'],
      ['--extractor-args', 'youtube:player_client=tv_embedded'],
    ];
    let lastDetail = '';
    // Fast geo probe — resolves true (geo) or false (inconclusive)
    // within ~4s of starting. A yt-dlp probe CANNOT work: a single
    // android client takes 7.5–9.5s to surface the geo error (its player
    // requests get 429'd and retried), and 4 concurrent clients take
    // 13–19s — measured 2026-11-24. The watch-page fetch in
    // geoBlockedInPlayer answers in ~2s instead. It runs alongside
    // round 1 (a plain fetch, not a process, so a normal video costs
    // nothing) and is checked the moment round 1 ends without a
    // success. It must be checked AFTER round 1, not raced against it:
    // when YouTube 429-kills the clients they fail FAST (~1–2s), so a
    // race would let round 1 settle before the probe's fetch lands and
    // the geo answer would be discarded. The probe's own 4s fetch cap
    // bounds the wait — round 1 settling at 2s + at most ~2s for the
    // probe is still inside the frontend's 10s per-origin budget.
    const probeGeo = (async () => {
      try {
        const html = await fetchPageHtml(url, 4000);
        return Boolean(html && geoBlockedInPlayer(html));
      } catch { return false; }
    })();
    const rounds = [{ allowProxy: false, timeout: 8000 }, { allowProxy: true, timeout: 12000 }];
    for (let ri = 0; ri < rounds.length; ri++) {
      const round = rounds[ri];
      const mirror = withTimeout(mirrorInfo(url).then((info) => {
        if (!info) throw new Error('mirror empty');
        return { info, clientArgs: null };
      }), round.timeout, 'mirror timeout');
      const roundSettled = Promise.allSettled([
        ...clients.map((args) => tag(ytdlpJson(url, round.timeout, args, round.allowProxy), args)),
        mirror,
      ]);
      let settled;
      if (ri === 0) {
        // Race the probe against round 1 as well: when the mirror hangs,
        // round 1 takes the full 8s, and the probe's ~2s answer would
        // otherwise wait until 8s — inside the 10s budget but with only
        // ~1.7s of margin (measured 8.3s without the race). The race
        // returns GEO at ~2s in that case. The post-round check below
        // stays as the backstop for the opposite case (round 1 settles
        // fast, before the probe lands).
        const raced = await Promise.race([
          probeGeo.then((hit) => (hit ? 'GEO' : new Promise(() => {}))),
          roundSettled,
        ]);
        if (raced === 'GEO') {
          const gerr = new Error('This video is blocked in this region.');
          gerr.geoBlocked = true;
          throw gerr;
        }
        settled = raced;
      } else {
        settled = await roundSettled;
      }
      const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (ok.length) {
        let best = ok[0];
        for (const cand of ok) {
          if (infoScore(cand.info) > infoScore(best.info)) best = cand;
        }
        best.viaProxy = round.allowProxy;
        return best;
      }
      lastDetail = settled.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.detail).filter(Boolean).join(' | ');
      // Geo-block: no other client, mirror or proxy round in THIS region
      // can read the video — the restriction is the region itself. Stop
      // here (fast, inside the frontend's 10s per-origin budget) so the
      // frontend can retry another region instead of burning the WARP
      // round and timing out on a generic error. The probe is checked
      // first: it answers in ~2s, while the clients' geo text often
      // never surfaces at all (429-killed with empty stderr).
      if (ri === 0 && await probeGeo) {
        const gerr = new Error('This video is blocked in this region.');
        gerr.detail = lastDetail;
        gerr.geoBlocked = true;
        throw gerr;
      }
      if (isGeoBlocked(lastDetail)) {
        const gerr = new Error('This video is blocked in this region.');
        gerr.detail = lastDetail;
        gerr.geoBlocked = true;
        throw gerr;
      }
    }
    const err = new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
    err.detail = lastDetail;
    if (isGeoBlocked(lastDetail)) err.geoBlocked = true;
    throw err;
  }
  const attempts = isTikTok(url)
    ? [
        [],
        ['--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast1a.tiktokv.com'],
        ['--extractor-args', 'tiktok:api_hostname=api19-normal-c-useast1a.tiktokv.com'],
      ]
    : [
        [],
        ['--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
      ];
  const isTumblr = clientSideKey(url) === 'tumblr';
  const rounds = isTikTok(url)
    ? [{ allowProxy: false, timeout: 8000 }, { allowProxy: true, timeout: 12000 }]
    : isTumblr
      // Direct first (15s — the extractor answers in ~15s locally), then
      // the WARP proxy round (20s). The proxy is never tried when direct
      // works, and a down proxy falls back cleanly via warpCheck, so a
      // WARP outage costs nothing here.
      ? [{ allowProxy: false, timeout: 15000 }, { allowProxy: true, timeout: 20000 }]
      : [{ allowProxy: false, timeout: 20000 }];
  let lastErr = null;
  for (const round of rounds) {
    try {
      const res = await Promise.any(attempts.map((args) => tag(ytdlpJson(url, round.timeout, args, round.allowProxy), args)));
      res.viaProxy = round.allowProxy;
      return res;
    } catch (e) {
      lastErr = e;
      // Geo-block: the WARP round cannot help — the restriction is the
      // region, not the IP. Fail fast so the frontend can try another
      // region inside its per-origin budget.
      const d = (e && e.errors && e.errors.map((x) => x && x.detail).filter(Boolean).join(' | ')) || (e && e.detail) || '';
      if (isGeoBlocked(d)) throw wrapErr(e);
    }
  }
  throw wrapErr(lastErr);
}

// ---- fast preview metadata (~1s when warm) ----------------------------------
// Title / thumbnail / author without waiting for the full format extraction.
// Every source runs IN PARALLEL and the first answer wins, so the worst
// case is the overall budget (~4s), not the sum of every attempt. The old
// version ran YouTube oEmbed, then tikwm, then the og scrape one after
// another (up to ~9s) and still 404'd on Facebook/Instagram, whose pages
// carry no og: tags behind their login walls.
// oEmbed (public, no login): YouTube, Vimeo, Reddit. TikTok's oEmbed was
// tested 2026-11-24 on two videos — it returns NO title and NO
// thumbnail_url, so TikTok still uses tikwm + the og scrape. Facebook's
// oEmbed endpoint is deprecated (400) and Instagram has no public oEmbed,
// so their previews come from /api/info (yt-dlp, ~1s warm) and the
// frontend shows that result the moment it arrives.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function ogTag(html, prop) {
  // The whole <meta> tag carrying property="prop" — content="..." may
  // sit BEFORE property="..." (React Helmet pages, e.g. Tumblr) or after
  // it, so the content is read from inside that one tag only. The old
  // version sliced 600 chars after the property and took the first
  // content="..." in the window — on Tumblr that returned the NEXT tag's
  // value (og:title gave og:description, og:image gave og:image:width's
  // "576", og:site_name gave og:type's "video"). The property name is
  // matched with its closing quote, so og:image never matches
  // og:image:width.
  const esc = String(prop).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = String(html || '').match(new RegExp('<meta[^>]*property="' + esc + '"[^>]*>', 'i'));
  if (!tag) return '';
  const m = tag[0].match(/content="([^"]*)"/i) || tag[0].match(/content='([^']*)'/i);
  return m ? m[1] : '';
}

async function oembedMeta(endpoint, timeoutMs) {
  try {
    const j = await fetchJsonTimeout(endpoint, timeoutMs);
    if (!j || !j.title) return null;
    return {
      title: decodeEntities(j.title),
      thumbnail: j.thumbnail_url || '',
      uploader: j.author_name || '',
      duration: Number(j.duration) || 0,
    };
  } catch { return null; }
}

async function ogScrapeMeta(url, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Tumblr: a blog's own subdomain answers with a JS challenge page
    // that has no og: tags at all — fetch the canonical www.tumblr.com
    // page instead (same rewrite the scrape uses), so the fast preview
    // works for pasted subdomain links too.
    const metaUrl = clientSideKey(url) === 'tumblr' ? (await tumblrPageUrl(url)) || url : url;
    // Haokan: a desktop UA gets a JS shell whose <title> is the generic
    // site name — the iPhone UA gets the server-rendered page with the
    // real title and poster (same UA the info scrape uses).
    // Kuaishou: the page only embeds its data (and its real <title>)
    // with the anonymous cookie set — mint one, as the info scrape does
    // — and with the same headers the info scrape sends (Chrome UA,
    // Referer, zh-CN): en-US / no-Referer gets the shell page whose
    // <title> is the generic site name.
    const metaKey = clientSideKey(url);
    const metaUa = metaKey === 'haokan' ? HAOKAN_UA : metaKey === 'kuaishou' ? KUAISHOU_UA : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const metaCookies = metaKey === 'kuaishou' ? await kuaishouCookies() : '';
    const r = await fetch(metaUrl, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': metaUa,
        'Accept-Language': metaKey === 'kuaishou' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
        ...(metaKey === 'kuaishou' ? { Referer: 'https://www.kuaishou.com/' } : {}),
        ...(metaCookies ? { Cookie: metaCookies } : {}),
      },
    });
    clearTimeout(timer);
    const html = await r.text();
    // Tumblr's og:title is only "Post by @blog · 1 video" — the real
    // post text is parsely-title, and the poster frame is
    // parsely-image-url; prefer those when the page carries them.
    // Last resort: the page's own <title> (Kuaishou pages carry no og:
    // tags at all, only <title> — without this the preview 404s and the
    // user waits for Stage 2 to see anything).
    const title = decodeEntities(
      metaContent(html, 'name', 'parsely-title').replace(/ – @\S+ on Tumblr$/, '') ||
      ogTag(html, 'og:title') ||
      ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || ''));
    const img = metaContent(html, 'name', 'parsely-image-url') || ogTag(html, 'og:image');
    // Kuaishou's shell page (served when the cookie set is missing or
    // the fetch is slow) carries the generic site <title> "短视频-快手"
    // — that is not the video's title, so treat it as no preview
    // rather than flash the wrong name; Stage 2 renders the real one.
    if (clientSideKey(url) === 'kuaishou' && title === '短视频-快手') return null;
    if (title || img) return { title: title || 'Video', thumbnail: img, uploader: ogTag(html, 'og:site_name') || '', duration: 0 };
    return null;
  } catch { return null; }
}

async function tikwmMeta(url) {
  try {
    const t = await tikwmInfo(url, 2500);
    if (t) return { title: t.title, thumbnail: t.thumbnail, uploader: t.uploader, duration: t.duration || 0 };
    return null;
  } catch { return null; }
}

async function fastMeta(url) {
  const cached = cacheGet('meta:' + url);
  if (cached) return cached;
  const jobs = [];
  if (isYouTube(url)) {
    jobs.push(oembedMeta('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json', 3000));
  }
  if (isTikTok(url)) jobs.push(tikwmMeta(url));
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    jobs.push(oembedMeta('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url), 2500));
  }
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
    jobs.push(oembedMeta('https://www.reddit.com/oembed?url=' + encodeURIComponent(url), 2500));
  }
  jobs.push(ogScrapeMeta(url, 3500));
  // First non-null answer wins; give up after 4s so /api/meta never
  // keeps the preview waiting. Every job swallows its own errors.
  const out = await Promise.race([
    Promise.any(jobs.map((j) => j.then((v) => { if (!v) throw new Error('no meta'); return v; }))).catch(() => null),
    new Promise((ok) => setTimeout(() => ok(null), 4000)),
  ]);
  if (out) cacheSet('meta:' + url, out);
  return out;
}
// ---- YouTube via public Invidious / Piped mirrors (fallback) ---------------
// Render's IP is bot-checked by YouTube, so when yt-dlp fails we ask public
// mirrors that keep their own YouTube access. Each attempt is short (5s) and
// fail-safe: a dead mirror just means "try the next one". Hosts are
// configurable via INVIDIOUS_HOSTS / PIPED_HOSTS (comma-separated) for tests.
const INVIDIOUS_HOSTS = (process.env.INVIDIOUS_HOSTS || 'https://invidious.privacyredirect.com,https://yewtu.be,https://inv.nadeko.net').split(',').map((s) => s.trim()).filter(Boolean);
const PIPED_HOSTS = (process.env.PIPED_HOSTS || 'https://pipedapi.kavin.rocks,https://pipedapi-libre.kavin.rocks,https://pipedapi.leptons.xyz').split(',').map((s) => s.trim()).filter(Boolean);

async function fetchJsonTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
    return u.searchParams.get('v') || '';
  } catch { return ''; }
}

function heightOf(q) {
  const n = parseInt(String(q || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function invidiousInfo(vid) {
  return (async () => {
    for (const h of INVIDIOUS_HOSTS) {
      const j = await fetchJsonTimeout(h + '/api/v1/videos/' + vid, 5000);
      if (j && Array.isArray(j.formatStreams) && j.formatStreams.length) return j;
    }
    return null;
  })();
}

function pipedInfo(vid) {
  return (async () => {
    for (const h of PIPED_HOSTS) {
      const j = await fetchJsonTimeout(h + '/streams/' + vid, 5000);
      if (j && ((Array.isArray(j.videoStreams) && j.videoStreams.length) || (Array.isArray(j.audioStreams) && j.audioStreams.length))) return j;
    }
    return null;
  })();
}

function invidiousToInfo(j) {
  const formats = [];
  for (const s of (j.formatStreams || [])) {
    if (!s || !s.url) continue;
    formats.push({
      format_id: 'inv-' + (s.itag || heightOf(s.quality)),
      ext: String(s.container || 'mp4').toLowerCase(),
      height: heightOf(s.quality),
      width: 0,
      fps: s.fps || 0,
      vcodec: s.encoding || 'avc1',
      acodec: 'mp4a',
      url: s.url,
      filesize: s.size || 0,
      filesize_approx: s.size || 0,
      tbr: s.bitrate ? s.bitrate / 1000 : 0,
    });
  }
  let bestAudio = null;
  for (const s of (j.adaptiveFormats || [])) {
    if (!s || !s.url || s.type !== 'audio') continue;
    if (!bestAudio || (s.bitrate || 0) > (bestAudio.bitrate || 0)) bestAudio = s;
  }
  if (bestAudio) {
    formats.push({
      format_id: 'inv-audio',
      ext: String(bestAudio.container || 'm4a').toLowerCase(),
      height: 0,
      width: 0,
      fps: 0,
      vcodec: 'none',
      acodec: bestAudio.encoding || 'mp4a',
      url: bestAudio.url,
      filesize: 0,
      filesize_approx: 0,
      abr: bestAudio.bitrate ? bestAudio.bitrate / 1000 : 0,
    });
  }
  const thumbs = Array.isArray(j.videoThumbnails) ? j.videoThumbnails : [];
  const thumb = (thumbs.find((t) => t && t.width >= 480) || thumbs[thumbs.length - 1] || {}).url || '';
  return {
    title: j.title || 'Video',
    thumbnail: thumb,
    duration: j.lengthSeconds || 0,
    uploader: j.author || '',
    formats,
  };
}

function pipedToInfo(j) {
  const formats = [];
  for (const s of (j.videoStreams || [])) {
    if (!s || !s.url || s.videoOnly) continue;
    const fmt = String(s.format || '').toUpperCase();
    formats.push({
      format_id: 'pip-' + (s.itag || heightOf(s.quality)),
      ext: fmt.includes('WEBM') ? 'webm' : 'mp4',
      height: heightOf(s.quality),
      width: 0,
      fps: s.fps || 0,
      vcodec: s.codec || 'avc1',
      acodec: 'mp4a',
      url: s.url,
      filesize: 0,
      filesize_approx: 0,
      tbr: s.bitrate ? s.bitrate / 1000 : 0,
    });
  }
  let bestAudio = null;
  for (const s of (j.audioStreams || [])) {
    if (!s || !s.url) continue;
    if (!bestAudio || (s.bitrate || 0) > (bestAudio.bitrate || 0)) bestAudio = s;
  }
  if (bestAudio) {
    formats.push({
      format_id: 'pip-audio',
      ext: 'm4a',
      height: 0,
      width: 0,
      fps: 0,
      vcodec: 'none',
      acodec: bestAudio.codec || 'mp4a',
      url: bestAudio.url,
      filesize: 0,
      filesize_approx: 0,
      abr: bestAudio.bitrate ? bestAudio.bitrate / 1000 : 0,
    });
  }
  return {
    title: j.title || 'Video',
    thumbnail: j.thumbnailUrl || '',
    duration: j.duration || 0,
    uploader: j.uploader || '',
    formats,
  };
}

async function mirrorInfo(url) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const [inv, pip] = await Promise.all([invidiousInfo(vid), pipedInfo(vid)]);
  if (inv) return invidiousToInfo(inv);
  if (pip) return pipedToInfo(pip);
  return null;
}

async function mirrorStreamUrl(url, formatId) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const isInv = formatId.startsWith('inv-');
  const wantAudio = formatId.endsWith('-audio');
  const itag = wantAudio ? '' : formatId.slice(4);
  if (isInv) {
    const j = await invidiousInfo(vid);
    if (!j) return null;
    if (wantAudio) {
      let best = null;
      for (const s of (j.adaptiveFormats || [])) {
        if (s && s.type === 'audio' && s.url && (!best || (s.bitrate || 0) > (best.bitrate || 0))) best = s;
      }
      return best ? best.url : null;
    }
    for (const s of (j.formatStreams || [])) {
      if (s && String(s.itag) === itag && s.url) return s.url;
    }
    return null;
  }
  const j = await pipedInfo(vid);
  if (!j) return null;
  if (wantAudio) {
    let best = null;
    for (const s of (j.audioStreams || [])) {
      if (s && s.url && (!best || (s.bitrate || 0) > (best.bitrate || 0))) best = s;
    }
    return best ? best.url : null;
  }
  for (const s of (j.videoStreams || [])) {
    if (s && String(s.itag) === itag && s.url) return s.url;
  }
  return null;
}

// Prefer widely playable codecs: h264 first, then vp9, then av1.
function codecRank(vcodec) {
  const v = String(vcodec || '').toLowerCase();
  if (v.includes('avc1') || v.includes('h264')) return 0;
  if (v.includes('vp09') || v.includes('vp9')) return 1;
  if (v.includes('av01') || v.includes('av1')) return 2;
  return 3;
}

// Is this format URL a direct single file the browser can fetch itself?
// HLS/DASH playlists (.m3u8/.mpd) are NOT files — a browser cannot save
// one as a video — so they are excluded. IP-literal and localhost media
// hosts are rejected too (string check; the pasted-host DNS check above
// is the main SSRF layer).
function isDirectFileUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
    if (p.username || p.password) return false;
    const path = p.pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.mpd')) return false;
    const h = p.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost')) return false;
    if (net.isIP(h)) return false;
    return true;
  } catch { return false; }
}
function isManifestFormat(f) {
  const proto = String((f && f.protocol) || '').toLowerCase();
  if (proto.includes('m3u8') || proto.includes('dash')) return true;
  const u = String((f && f.url) || '').split('?')[0].toLowerCase();
  return u.endsWith('.m3u8') || u.endsWith('.mpd');
}
// Height from the file URL itself (LinkedIn reports no height, but its
// URLs carry mp4-720p-30fp-crf28). Used only when the format has none.
function heightFromUrl(u) {
  const m = String(u || '').match(/[-_](\d{3,4})p[-_.]/);
  return m ? parseInt(m[1], 10) : 0;
}

// Best playable stream for the in-page preview player. Direct single
// files come FIRST: an HLS playlist URL cannot play in a normal <video>
// tag, while a direct mp4 can — so X / LinkedIn previews play their
// direct file instead of failing on a playlist. The old order (any
// progressive, then any video) is kept as the fallback for platforms
// whose only streams are playlists (YouTube etc.).
function previewUrl(info) {
  const list = Array.isArray(info.formats) ? info.formats : [];
  // Effective height: some extractors report none but the file URL
  // carries it (LinkedIn mp4-720p-30fp) — without this the sort is a
  // coin toss and the preview can pick the smaller file.
  const effH = (f) => (f.height || heightFromUrl(f.url) || 0);
  // Twitch clips ship a portrait crop and the landscape original at
  // the same height — the original (landscape) is the preview.
  const isPortrait = (f) => String(f.format_id || '').toLowerCase().startsWith('portrait') ? 1 : 0;
  const byH = (a, b) => isPortrait(a) - isPortrait(b) || effH(b) - effH(a);
  const directProg = list
    .filter((f) => f && f.url && isDirectFileUrl(f.url) && !isManifestFormat(f) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort(byH)[0];
  if (directProg) return directProg.url;
  const directVid = list
    .filter((f) => f && f.url && isDirectFileUrl(f.url) && !isManifestFormat(f) && f.vcodec && f.vcodec !== 'none')
    .sort(byH)[0];
  if (directVid) return directVid.url;
  // Direct files with no codec info at all (Twitch clips, Tumblr,
  // LinkedIn, Bluesky blob): the source's own ready file — it plays.
  const directUnknown = list
    .filter((f) => f && f.url && isDirectFileUrl(f.url) && !isManifestFormat(f) &&
      (!f.vcodec || f.vcodec === 'none') && (!f.acodec || f.acodec === 'none') &&
      (String(f.ext || '').toLowerCase() === 'mp4' || String(f.ext || '').toLowerCase() === 'webm'))
    .sort(byH)[0];
  if (directUnknown) return directUnknown.url;
  const prog = list
    .filter((f) => f && f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort(byH)[0];
  if (prog) return prog.url;
  const any = list.filter((f) => f && f.url && f.vcodec && f.vcodec !== 'none')
    .sort(byH)[0];
  return any ? any.url : '';
}

// Direct-file formats ONLY, for client-side-only platforms: every offered
// quality is a single file the visitor's browser downloads straight from
// the video CDN (fetch+blob when the CDN allows cross-origin reads, else
// the browser opens the file itself). Merged video+audio pairs are never
// built here — a merged download would need the server to join them, which
// the no-server-download rule forbids. So a platform offers:
//   - progressive (video+audio) files when they exist,
//   - video-only files and audio-only files as separate downloads when
//     they are the only direct files (e.g. X: video-only mp4s, no audio
//     file exists at all — the note says so plainly).
// Returns [] when the video has no direct file at all (HLS-only etc.) —
// the caller then answers 404 instead of listing a platform that cannot
// actually save anything.
function buildDirectFormats(info) {
  const list = Array.isArray(info.formats) ? info.formats : [];
  const prog = new Map(); // height -> best progressive direct file
  const vidOnly = new Map(); // height -> best video-only direct file
  const audioOnly = new Map(); // ext -> best audio-only direct file
  for (const f of list) {
    if (!f || f.ext === 'mhtml' || !f.url) continue;
    if (isManifestFormat(f) || !isDirectFileUrl(f.url)) continue;
    const ext = String(f.ext || 'mp4').toLowerCase();
    if (!['mp4', 'm4a', 'webm', 'mp3'].includes(ext)) continue;
    const h = f.height || heightFromUrl(f.url) || 0;
    const v = f.vcodec && f.vcodec !== 'none';
    const a = f.acodec && f.acodec !== 'none';
    const size = f.filesize || f.filesize_approx || 0;
    if (v && a) {
      const portrait = String(f.format_id || '').toLowerCase().startsWith('portrait');
      const rank = codecRank(f.vcodec);
      // Prefer the landscape (original) variant over a portrait crop at
      // the same height (Twitch clips ship both), then better codec,
      // then larger file.
      const key = (portrait ? 0 : 1) * 1e15 + (3 - rank) * 1e12 + size;
      const cur = prog.get(h);
      if (!cur || key > cur._key) {
        prog.set(h, { ...f, height: h, filesize: size, _key: key });
      }
    } else if (v && !a) {
      const portrait = String(f.format_id || '').toLowerCase().startsWith('portrait');
      const rank = codecRank(f.vcodec);
      const key = (portrait ? 0 : 1) * 1e15 + (3 - rank) * 1e12 + size;
      const cur = vidOnly.get(h);
      if (!cur || key > cur._key) vidOnly.set(h, { ...f, height: h, filesize: size, _key: key });
    } else if (!v && a) {
      // One audio row only: the best sound file — m4a first (it plays
      // everywhere), then mp3, then webm; within one container the
      // highest bitrate, then the largest file. Never a row per container.
      const extRank = ext === 'm4a' ? 0 : ext === 'mp3' ? 1 : 2;
      const cur = audioOnly.get('best');
      const better = !cur ||
        extRank < cur._extRank ||
        (extRank === cur._extRank && ((f.abr || 0) > (cur.abr || 0) ||
          ((f.abr || 0) === (cur.abr || 0) && size > (cur.filesize || 0))));
      if (better) audioOnly.set('best', { ...f, filesize: size, _extRank: extRank });
    } else if (!v && !a && (ext === 'mp4' || ext === 'webm')) {
      // No codec info at all (Twitch clips, LinkedIn, Bluesky blob):
      // the source's own ready file — treat it as progressive, like the
      // unknown-codec branch of buildFormats. Only when no real
      // progressive file exists at this height (its _key is -1, so any
      // real format replaces it). First one wins at a height: several
      // mirrors can share one height (Tencent Video ships 4 mirrors at
      // 352p, the last one a dispatch URL that answers 418), so a later
      // mirror must not displace an earlier, working one.
      const cur = prog.get(h);
      if (!cur) {
        prog.set(h, { ...f, height: h, filesize: size, _key: -1 });
      }
    }
  }
  const out = [];
  const heights = [...prog.keys()].sort((a, b) => b - a);
  for (const h of heights) {
    const f = prog.get(h);
    out.push({
      id: String(f.format_id),
      label: h ? h + 'p' : 'Best quality',
      ext: f.ext || 'mp4',
      hasAudio: true,
      url: f.url || '',
      filesize: f.filesize || 0,
      note: 'With sound',
      kind: 'progressive',
    });
  }
  const vHeights = [...vidOnly.keys()].sort((a, b) => b - a);
  for (const h of vHeights) {
    if (prog.has(h)) continue; // a with-sound file at this height beats a silent one
    const f = vidOnly.get(h);
    out.push({
      id: String(f.format_id),
      label: (h ? h + 'p' : 'Best quality') + ' · Video only',
      ext: f.ext || 'mp4',
      hasAudio: false,
      url: f.url || '',
      filesize: f.filesize || 0,
      note: 'No sound — picture only',
      kind: 'video-only',
    });
  }
  for (const f of [...audioOnly.values()].sort((a, b) => (b.abr || 0) - (a.abr || 0))) {
    out.push({
      id: String(f.format_id),
      label: 'Audio only',
      ext: f.ext || 'm4a',
      hasAudio: true,
      url: f.url || '',
      filesize: f.filesize || 0,
      note: 'Sound only',
      kind: 'audio-only',
    });
  }
  return out;
}

function buildFormats(info, opts) {
  // opts.noSeparateAudio (TikTok): TikTok's standalone "audio" format is
  // the background MUSIC file, not the video's soundtrack — on a 139s
  // video it is only ~60s long. Pairing it with a video-only stream (or
  // offering it as "Audio only") would give a download whose sound stops
  // part-way through, so for TikTok only progressive (video+audio) formats
  // are offered — they carry the video's real, full-length sound.
  const noSeparateAudio = !!(opts && opts.noSeparateAudio);
  const list = Array.isArray(info.formats) ? info.formats : [];
  const byHeight = new Map(); // height -> best progressive (video+audio)
  const videoOnly = new Map(); // height -> best video-only
  const unknownProg = []; // formats with no codec info (e.g. Facebook "hd"/"sd") — usually progressive
  let bestAudio = null;

  for (const f of list) {
    if (!f || f.ext === 'mhtml') continue;
    const h = f.height || 0;
    const v = f.vcodec && f.vcodec !== 'none';
    const a = f.acodec && f.acodec !== 'none';
    const size = f.filesize || f.filesize_approx || 0;
    const score = (f.tbr || 0) * 1000 + size;
    if (!v && !a && (f.ext === 'mp4' || f.ext === 'webm')) {
      // Skip stream manifests (HLS/DASH playlists) — they are not files.
      const proto = String(f.protocol || '').toLowerCase();
      if (!proto.includes('m3u8') && !proto.includes('dash')) unknownProg.push(f);
    } else if (v && a && h > 0) {
      const cur = byHeight.get(h);
      if (!cur || score > cur._score) byHeight.set(h, { ...f, _score: score });
    } else if (v && !a && h > 0) {
      const cur = videoOnly.get(h);
      const rank = codecRank(f.vcodec);
      const key = rank * 1e12 + score;
      if (!cur || key > cur._key) videoOnly.set(h, { ...f, _key: key });
    } else if (!v && a) {
      if (!bestAudio || (f.abr || 0) > (bestAudio.abr || 0)) bestAudio = f;
    }
  }

  const out = [];
  const heights = [...new Set([...byHeight.keys(), ...videoOnly.keys()])].sort((a, b) => b - a);
  for (const h of heights) {
    const prog = byHeight.get(h);
    const vo = videoOnly.get(h);
    if (prog) {
      out.push({
        id: String(prog.format_id),
        label: h + 'p' + (prog.fps && prog.fps > 30 ? ' ' + Math.round(prog.fps) + 'fps' : ''),
        ext: prog.ext || 'mp4',
        hasAudio: true,
        // Direct file URL: the browser downloads it straight from the
        // video CDN, so the server never touches the bytes. Only
        // progressive (single-file) formats carry one; merged
        // video+audio pairs have none and keep the server save path.
        url: prog.url || '',
        filesize: prog.filesize || prog.filesize_approx || 0,
        note: 'With sound',
      });
    } else if (vo && bestAudio && !noSeparateAudio) {
      out.push({
        id: String(vo.format_id) + '+' + String(bestAudio.format_id),
        label: h + 'p' + (vo.fps && vo.fps > 30 ? ' ' + Math.round(vo.fps) + 'fps' : ''),
        ext: 'mp4',
        hasAudio: true,
        filesize: (vo.filesize || vo.filesize_approx || 0) + (bestAudio.filesize || bestAudio.filesize_approx || 0),
        note: 'With sound',
      });
    }
  }
  // Unknown-codec progressive formats (Facebook "hd"/"sd"): offer them first —
  // they are the source's own ready files and play everywhere.
  const seenLabels = new Set(out.map((o) => o.label));
  for (const f of unknownProg) {
    const fid = String(f.format_id).toLowerCase();
    const label = fid === 'hd' ? 'HD' : fid === 'sd' ? 'SD' : (f.height ? f.height + 'p' : 'Best quality');
    if (seenLabels.has(label)) continue; // never show the same label twice
    seenLabels.add(label);
    out.unshift({
      id: String(f.format_id),
      label,
      ext: f.ext || 'mp4',
      hasAudio: true,
      url: f.url || '',
      filesize: f.filesize || f.filesize_approx || 0,
      note: 'With sound',
    });
  }
  if (bestAudio && !noSeparateAudio) {
    out.push({
      id: String(bestAudio.format_id),
      label: 'Audio only',
      ext: bestAudio.ext || 'm4a',
      hasAudio: true,
      url: bestAudio.url || '',
      filesize: bestAudio.filesize || bestAudio.filesize_approx || 0,
      note: 'Sound only',
    });
  }
  if (out.length === 0) {
    if (noSeparateAudio) {
      const prog = list.filter((f) => f && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (prog) {
        out.push({
          id: String(prog.format_id),
          label: (prog.height ? prog.height + 'p' : 'Best quality'),
          ext: prog.ext || 'mp4', hasAudio: true, url: prog.url || '',
          filesize: prog.filesize || prog.filesize_approx || 0, note: 'With sound',
        });
      }
    } else {
      const best = list.filter((f) => f.vcodec && f.vcodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (best) {
        out.push({
          id: 'bestvideo+bestaudio',
          label: (best.height ? best.height + 'p' : 'Best quality'),
          ext: 'mp4', hasAudio: true, filesize: 0, note: 'With sound',
        });
      }
    }
  }
  return out;
}

// ---- Direct-file pages: Pinterest / Moj / ShareChat / Snapchat / Tumblr ----
// These have no usable yt-dlp path to a direct file (Pinterest and
// Snapchat: HLS playlists only through yt-dlp; Moj/ShareChat: no extractor
// at all; Tumblr: yt-dlp works locally but times out from Render's IPs),
// but their own pages embed the direct mp4 — so the server fetches the
// PAGE HTML only (never the video file) and returns the file's URL for
// the visitor's browser to download. Pages are capped (~3 MB) and the
// fetch times out in 8s; a page that embeds no usable file returns null
// and the caller falls through to yt-dlp.
async function fetchPageHtml(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 3 * 1024 * 1024) return null;
    const text = await r.text();
    return text.length > 3 * 1024 * 1024 ? null : text;
  } catch { return null; } finally { clearTimeout(timer); }
}
function decodeHtmlEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function pageMp4s(html) {
  const found = new Set();
  const re = /https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi;
  let m;
  while ((m = re.exec(html)) !== null) found.add(decodeHtmlEntities(m[0]));
  return [...found];
}
function directFormat(url, label) {
  return {
    id: 'direct', label: label || 'Best quality', ext: 'mp4', hasAudio: true,
    url, filesize: 0, note: 'With sound', kind: 'progressive',
  };
}

// content="..." of a <meta> tag found by any other attribute, whatever
// order the attributes come in (ogTag above only handles property="..."
// followed by content="..."; Tumblr puts content="..." first and uses
// name="parsely-title" / name="parsely-image-url").
function metaContent(html, attr, value) {
  const esc = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = String(html || '').match(new RegExp('<meta[^>]*' + attr + '="' + esc + '"[^>]*>', 'i'));
  if (!tag) return '';
  const m = tag[0].match(/content="([^"]*)"/i) || tag[0].match(/content='([^']*)'/i);
  return m ? m[1] : '';
}

// Canonical www.tumblr.com page URL for a post link. A blog's own
// subdomain (<blog>.tumblr.com) answers datacenter IPs with a JS
// hashcash challenge page ("Checking your browser...") that contains no
// video at all — the same post on www.tumblr.com serves the real HTML,
// including the direct va.media.tumblr.com mp4. Short tmblr.co links are
// resolved by hand so the next hop can be rewritten the same way instead
// of followed into the challenge page.
async function tumblrPageUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'www.tumblr.com') return url;
    if (host === 'tumblr.com') return 'https://www.tumblr.com' + u.pathname + u.search;
    const sub = host.match(/^([a-z0-9-]+)\.tumblr\.com$/);
    if (sub) {
      const p = u.pathname.replace(/^\/post\//, '/');
      return 'https://www.tumblr.com/' + sub[1] + p + u.search;
    }
    if (host === 'tmblr.co' || host === 'www.tmblr.co') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal, redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        });
        const loc = r.headers.get('location');
        if (!loc) return null;
        return tumblrPageUrl(new URL(loc, url).href);
      } catch { return null; } finally { clearTimeout(timer); }
    }
    return null;
  } catch { return null; }
}

async function scrapeTumblr(url) {
  const pageUrl = await tumblrPageUrl(url);
  if (!pageUrl) return null;
  const html = await fetchPageHtml(pageUrl);
  if (!html) return null;
  const mp4s = pageMp4s(html).filter((u) => u.includes('va.media.tumblr.com/'));
  if (!mp4s.length) return null;
  const titleRaw = metaContent(html, 'name', 'parsely-title') ||
    ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '');
  const title = decodeEntities(titleRaw).replace(/ – @\S+ on Tumblr$/, '').trim() || 'Tumblr video';
  const thumb = metaContent(html, 'name', 'parsely-image-url') || ogTag(html, 'og:image');
  // The poster frame shares its stem with the video file
  // (tumblr_<id>_smart1.jpg <-> tumblr_<id>.mp4) — prefer that file
  // when a post carries more than one video.
  const stem = (thumb.match(/(tumblr_[A-Za-z0-9]+)_smart1\./) || [])[1] || '';
  const video = (stem && mp4s.find((u) => u.includes(stem))) || mp4s[0];
  const blog = (pageUrl.match(/tumblr\.com\/([^/?#]+)/) || [])[1] ||
    metaContent(html, 'name', 'parsely-author') || '';
  return { source: 'tumblr', title, thumbnail: thumb, duration: 0, uploader: blog, previewUrl: video, formats: [directFormat(video)] };
}

async function scrapeDirectInfo(url) {
  const key = clientSideKey(url);
  if (key === 'tumblr') return scrapeTumblr(url);
  const html = await fetchPageHtml(url);
  if (!html) return null;
  const title = decodeEntities(ogTag(html, 'og:title'));
  const thumb = ogTag(html, 'og:image');
  if (key === 'pinterest') {
    // The pin page embeds exactly one direct mp4 (v1.pinimg.com) — the
    // same video yt-dlp only offers as an HLS playlist.
    const mp4s = pageMp4s(html).filter((u) => u.includes('v1.pinimg.com/videos/'));
    if (!mp4s.length) return null;
    mp4s.sort((a, b) => {
      const wa = parseInt((a.match(/_(\d+)w\.mp4/) || [0, 0])[1], 10) || 0;
      const wb = parseInt((b.match(/_(\d+)w\.mp4/) || [0, 0])[1], 10) || 0;
      return wb - wa;
    });
    return { source: 'pinterest', title: title || 'Pinterest video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: mp4s[0], formats: [directFormat(mp4s[0])] };
  }
  if (key === 'moj') {
    // og:video IS the requested video's direct mp4.
    const video = decodeHtmlEntities(ogTag(html, 'og:video'));
    if (!video || !video.includes('.mp4')) return null;
    return { source: 'moj', title: title || 'Moj video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: video, formats: [directFormat(video)] };
  }
  if (key === 'sharechat') {
    // og:video is just the page URL — useless. But og:image carries the
    // video's internal id (sc_<digits>); the page embeds several mp4s
    // for it — pick the h264 'compressed' one (plays everywhere), then
    // 'attributed', then anything but an h265 variant.
    const img = ogTag(html, 'og:image');
    const cid = (img.match(/(sc_\d+)/) || [])[1] || '';
    if (!cid) return null;
    const mine = pageMp4s(html).filter((u) => u.includes(cid));
    if (!mine.length) return null;
    const pick = (re) => mine.find((u) => re.test(u));
    const video = pick(/\/compressed\//) || pick(/\/attributed\//) ||
      mine.find((u) => !/h265/i.test(u)) || mine[0];
    return { source: 'sharechat', title: title || 'ShareChat video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: video, formats: [directFormat(video)] };
  }
  if (key === 'snapchat') {
    // og:video is the direct file on Snapchat's CDN (yt-dlp's extractor
    // cannot read the page's Next.js data, so the scrape is the route).
    // og:title is engagement text ("47.5K likes…"), so the title comes
    // from <title> and the uploader from the @handle in og:title.
    const video = decodeHtmlEntities(ogTag(html, 'og:video'));
    if (!video || !video.includes('sc-cdn.net')) return null;
    const titleTag = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
    const cleanTitle = decodeEntities(titleTag).split(' | ')[0].trim() || 'Snapchat video';
    const handle = (title.match(/@([A-Za-z0-9_.]+)/) || [])[1] || '';
    return { source: 'snapchat', title: cleanTitle, thumbnail: thumb, duration: 0, uploader: handle, previewUrl: video, formats: [directFormat(video)] };
  }
  if (key === 'x') {
    // The tweet page embeds the video's direct mp4s (video.twimg.com)
    // in its video_info JSON — one file per resolution, with sound.
    // yt-dlp's X extractor needs the GraphQL API, which blocks /
    // rate-limits datacenter IPs (the live "Finding qualities…" hang),
    // so the scrape is the route. Prefer the tweet's own files
    // (ext_tw_video) over the amplify copy; best resolution first.
    const mine = pageMp4s(html).filter((u) => u.includes('video.twimg.com/') && u.includes('/vid/'));
    if (!mine.length) return null;
    const own = mine.filter((u) => u.includes('/ext_tw_video/'));
    const pool = own.length ? own : mine;
    const byRes = new Map();
    for (const u of pool) {
      const m = u.match(/\/vid\/(\d+)x(\d+)\//);
      const h = m ? Number(m[2]) : 0;
      if (!byRes.has(h) || u.length < byRes.get(h).length) byRes.set(h, u);
    }
    const durMs = Number((html.match(/duration_millis\\?":(\d+)/) || [])[1] || 0);
    const handle = (title.match(/@([A-Za-z0-9_]+)/) || [])[1] || '';
    const formats = [...byRes.entries()].sort((a, b) => b[0] - a[0]).map(([h, u], i) => ({
      id: 'direct-' + (h || i), label: h ? h + 'p' : 'Best quality', ext: 'mp4', hasAudio: true,
      url: u, filesize: 0, note: i === 0 ? 'Best quality' : 'With sound', kind: 'progressive',
    }));
    if (!formats.length) return null;
    return { source: 'x', title: title || 'X video', thumbnail: thumb, duration: Math.round(durMs / 1000) || 0, uploader: handle, previewUrl: formats[0].url, formats };
  }
  return null;
}

// yt-dlp fallback for ShareChat / Snapchat when the page scrape finds no
// direct file. Two 12s attempts, native extractor first, then the generic
// extractor (og:video): Snapchat's native extractor fails on Spotlight
// pages ("Unable to extract next.js data") while the generic extractor
// reads og:video; ShareChat's native extractor works but returns a
// playlist, so its first entry with formats is unwrapped below. The
// /api/info outer cap (25s) bounds the pair. Formats go through
// buildDirectFormats like the other client-side platforms, so only direct
// single files are ever offered and video bytes still never pass through
// this server. Returns null on any failure (caller keeps its clear error).
async function ytdlpDirectFallback(url) {
  for (const extra of [[], ['--force-generic-extractor']]) {
    let info = null;
    try {
      info = await ytdlpJson(url, 12000, extra);
    } catch { continue; }
    // ShareChat answers as a playlist: use its first entry that has formats.
    if (info && info._type === 'playlist' && Array.isArray(info.entries)) {
      const entry = info.entries.find((e) => e && Array.isArray(e.formats) && e.formats.length);
      if (entry) {
        info = {
          ...entry,
          title: entry.title || info.title,
          thumbnail: entry.thumbnail || info.thumbnail,
          duration: entry.duration ?? info.duration,
          uploader: entry.uploader || info.uploader || info.channel || '',
        };
      }
    }
    if (!info || !Array.isArray(info.formats) || !info.formats.length) continue;
    const formats = buildDirectFormats(info);
    if (!formats.length) continue;
    return {
      source: 'generic',
      title: info.title || 'Video',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      uploader: info.uploader || info.channel || '',
      previewUrl: previewUrl(info),
      formats,
      clientSide: true,
      note: clientSideNote(url, info),
    };
  }
  return null;
}

// ---- Douyin via its own embed-player lane (no login) ----------------------
// Douyin's web API has two anti-bot lanes. The browser-app lane needs a
// device token, but the EMBEDDABLE PLAYER lane (open.douyin.com/player —
// the iframe third-party sites are given) is admitted on its Origin
// alone, because the player calls the API cross-site and cannot carry
// first-party cookies. No cookies, no signature, no login.
// The API answers ACAO: https://open.douyin.com ONLY, so the browser
// cannot call it — the server makes this call and returns the CDN URL
// for the visitor's browser to download. The video bytes never pass
// through the server. Verified 2026-11-24 (5/5 API calls from this VM).
// play_addr is the WATERMARK-FREE stream — download_addr is the
// watermarked one and is never used. yt-dlp is NOT used here: its
// Douyin extractor needs cookies (dead route, tested).
// Signed CDN URLs live ~5 min, so results from here are NEVER cached
// (see the /api/info hook) — a cached URL would be expired on arrival.
const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function douyinId(u) {
  try {
    const m = new URL(u).pathname.match(/\/video\/(\d+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function resolveDouyinShort(url, timeoutMs = 8000) {
  // v.douyin.com/<code> 302s to an iesdouyin.com share URL — the video
  // id sits in the Location path. Follow the redirect, do not fetch it.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': DOUYIN_UA } });
    return douyinId(r.headers.get('location') || '');
  } catch { return ''; } finally { clearTimeout(timer); }
}
function pickDouyinPlayUrl(urls) {
  // Prefer a real file host: *.zjcdn.com first, then *.douyinvod.com.
  // api-play.amemv.com / api.amemv.com entries are API hosts, not file
  // hosts — skip them.
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const usable = list.filter((u) => {
    const h = hostOf(u);
    return h && !h.includes('amemv.com');
  });
  return usable.find((u) => hostOf(u).endsWith('.zjcdn.com')) ||
    usable.find((u) => hostOf(u).endsWith('.douyinvod.com')) ||
    usable[0] || '';
}
async function douyinInfo(url, timeoutMs = 10000) {
  let id = douyinId(url);
  if (!id) {
    id = await resolveDouyinShort(url);
    if (!id) return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const api = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(id) + '&aid=1128';
    const r = await fetch(api, {
      signal: ctrl.signal,
      headers: { 'User-Agent': DOUYIN_UA, 'Origin': 'https://open.douyin.com' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j && j.aweme_detail;
    if (!d || !d.video || !d.video.play_addr || !Array.isArray(d.video.play_addr.url_list)) return null;
    const playUrl = pickDouyinPlayUrl(d.video.play_addr.url_list);
    if (!playUrl) return null;
    const h = d.video.height || 0;
    const cover = (d.video.cover && Array.isArray(d.video.cover.url_list)) ? (d.video.cover.url_list[0] || '') : '';
    return {
      source: 'douyin',
      title: d.desc || 'Douyin video',
      thumbnail: cover,
      duration: Math.round((d.video.duration || 0) / 1000),
      uploader: (d.author && d.author.nickname) || '',
      previewUrl: playUrl,
      formats: [directFormat(playUrl, h ? h + 'p' : 'Best quality')],
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- TikTok Series lane (added 2026-11-24) ------------------------------
// TikTok Series videos (drama episodes like @sy_shortdrama24) cannot be
// read by tikwm (code -1 "Url parsing is failed") or yt-dlp ("No video
// formats found") — TikTok's own web page for them carries an EMPTY
// playAddr/downloadAddr, so no public TikTok API returns a stream URL.
// Verified 2026-11-24: video 7708982980349267208 ("Episode 1 The Seventh
// Time or the Eighth", 124 s) has playAddr "" on TikTok's own page, while
// a normal TikTok video resolves fine through tikwm the same hour.
//
// OWN direct routes tried first and PROVABLY dead from server egress:
// TikTok's app aweme/detail API (api16-normal-c-*.tiktokv.com) and web
// item/detail API both answer HTTP 200 with an EMPTY body — even with a
// valid signature (tiktok-forge app signing x-argus/x-gorgon/x-ladon and
// web signing from TikTok's own webmssdk.js bundle, X-Bogus produced) —
// for the Series video AND for a normal control video. The empty body is
// an IP-level refusal of TikTok's API endpoints from datacenter IPs, not
// a bad signature, so no own-route signing can fix it from this server.
//
// What works: SSSTik's public no-login resolver (ssstik.io). The server
// POSTs the TikTok URL to its /abc?url=dl endpoint (the same call its own
// web page makes; the tt token is read off its homepage) and gets back an
// HTML result with the video's title/author/poster and a download link on
// SSSTik's own CDN (tikcdn.io). The visitor's browser then downloads the
// file straight from tikcdn.io — bytes never pass through our server.
// HONEST LIMIT: this lane depends on SSSTik's backend staying up and
// reachable. If SSSTik goes down or changes its API, Series videos fail
// again — there is no own-route fallback. The download opens in a new
// tab because tikcdn.io only allows cross-origin reads from ssstik.io
// (ACAO: https://ssstik.io), so the browser cannot fetch+blob it; a
// plain navigation downloads it fine (verified: browser UA, our site's
// Referer, 206; non-browser UAs get 204).
const SSSTIK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let ssstikTt = { value: '', at: 0 };
const SSSTIK_TT_TTL_MS = 10 * 60 * 1000;
async function ssstikToken() {
  const now = Date.now();
  if (ssstikTt.value && now - ssstikTt.at < SSSTIK_TT_TTL_MS) return ssstikTt.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('https://ssstik.io/', { signal: ctrl.signal, headers: { 'User-Agent': SSSTIK_UA } });
    if (!r.ok) return ssstikTt.value || '';
    const html = await r.text();
    const m = html.match(/s_tt\s*=\s*'([^']+)'/);
    if (m) { ssstikTt = { value: m[1], at: now }; return m[1]; }
    return ssstikTt.value || '';
  } catch { return ssstikTt.value || ''; } finally { clearTimeout(timer); }
}
function ssstikDuration(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}
async function ssstikInfo(url, timeoutMs = 15000) {
  // SSSTik resolves any public TikTok URL — Series or normal — so this
  // lane only runs after tikwm has already failed for the URL (see
  // /api/info), keeping normal videos on the faster tikwm path.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let tt = await ssstikToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!tt) return null;
      const body = new URLSearchParams({ id: url, locale: 'en', tt });
      const r = await fetch('https://ssstik.io/abc?url=dl', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'User-Agent': SSSTIK_UA, 'Referer': 'https://ssstik.io/', 'HX-Request': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!r.ok) return null;
      const html = await r.text();
      const link = html.match(/href="(https:\/\/tikcdn\.io\/ssstik\/\d+\?st=[^"&]+&e=\d+)"/);
      if (link) {
        const titleM = html.match(/<p class="ssr-caption">([\s\S]*?)<\/p>/);
        const authorM = html.match(/<div class="ssr-author">\s*<h2>([^<]+)<\/h2>/);
        const durM = html.match(/<span class="ssr-dur">([^<]+)<\/span>/);
        const posterM = html.match(/url\('(https:\/\/tikcdn\.io\/ssstik\/p\/[^']+)'\)/);
        const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : '';
        const videoId = (url.match(/\/video\/(\d+)/) || [])[1] || '';
        return {
          source: 'tiktok-series',
          title: title || ('TikTok video' + (videoId ? ' ' + videoId : '')),
          thumbnail: posterM ? posterM[1] : '',
          duration: ssstikDuration(durM && durM[1]),
          uploader: authorM ? authorM[1].trim() : '',
          previewUrl: link[1],
          formats: [{ id: 'ssstik-best', label: 'Best quality', ext: 'mp4', hasAudio: true, filesize: 0, note: 'Opens in a new tab', url: link[1] }],
          clientSide: true,
          note: 'This video opens in a new tab to save — TikTok Series episodes are only served inside TikTok’s own app.',
        };
      }
      // No download link: the tt token may have rotated — refresh it
      // once and retry; otherwise give up (fail fast, no fake button).
      ssstikTt = { value: '', at: 0 };
      tt = await ssstikToken();
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- Chinese no-login lanes (added 2026-11-24) ---------------------------
// Kuaishou, Haokan, Pear Video and Zhihu, each through its own public
// no-login route, verified from this VM on 2026-11-24 with real videos
// (real files downloaded + ffprobe-checked). No login, no login cookies,
// no API keys anywhere — the server only reads the video's INFO and hands
// the direct mp4 URL to the visitor's browser; bytes never pass through
// the server. Signed CDN URLs are short-lived, so results are resolved
// fresh per request (Kuaishou is never cached at all; the other three
// sit in the 10-min cache, well inside their 1–4 h URL expiry).

// Parse the first JSON object after a marker in a page (Kuaishou's
// __APOLLO_STATE__ and Haokan's __PRELOADED_STATE__ both carry trailing
// junk after the object — a script-closing IIFE on Kuaishou — so a
// naive slice-to-</script> + JSON.parse fails). Brace-matching that
// respects JSON strings and escapes.
function extractJsonObject(text, marker) {
  const s = String(text || '');
  const i = s.indexOf(marker);
  if (i < 0) return null;
  const start = s.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < s.length; p++) {
    const c = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, p + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const KUAISHOU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// ---- Kuaishou -------------------------------------------------------------
// The video page embeds its data in window.__APOLLO_STATE__ — but ONLY
// when the request carries the anonymous cookie set the homepage sets on
// a first visit (kpf/kpn/clientid/did — any fresh browser gets them; a
// single did= alone gets the shell page, see kuaishouCookies). Plain
// fetch works — no TLS impersonation needed — the cookie set is the
// whole trick.
// The photo's manifest lists direct mp4s (v1.kwaicdn.com, watermark-free,
// H264 best; H265 second); some videos return HLS (.m3u8) instead and
// are skipped — a video with no mp4 at all returns null, never a fake
// button. Verified 2026-11-24: short-video/3x7edaa985qmhqy, 720x1280
// h264 + AAC, 5,130,563 B, 12.1 s; v1.kwaicdn.com answers ACAO: *.
function kuaishouPhotoId(u) {
  try {
    const m = new URL(u).pathname.match(/\/short-video\/([0-9A-Za-z]+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function resolveKuaishouShort(url, timeoutMs = 8000) {
  // v.kuaishou.com/<code> and kuaishou.com/f/<code> 302 to the canonical
  // short-video URL — follow the redirect, do not fetch the target.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': KUAISHOU_UA } });
    const loc = r.headers.get('location') || '';
    return loc ? kuaishouPhotoId(new URL(loc, url).href) : '';
  } catch { return ''; } finally { clearTimeout(timer); }
}
async function kuaishouCookies(timeoutMs = 8000) {
  // Mint one fresh anonymous cookie set per request: GET the homepage
  // (it 302s; the cookies ride on the 302's own Set-Cookie) and keep
  // ALL of them — not just the did. A single did= cookie alone gets
  // the shell page (no VisionVideoDetailPhoto); the full set
  // (kpf/kpn/clientid/did) gets the page with the video data. Never a
  // login cookie — any fresh browser gets these on its first visit.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://www.kuaishou.com/', {
      signal: ctrl.signal, redirect: 'manual',
      headers: { 'User-Agent': KUAISHOU_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const pairs = [];
    const list = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []) || [];
    for (const c of list) {
      const m = String(c).match(/^\s*([^=;,]+)=([^;,]*)/);
      if (m) pairs.push(m[1].trim() + '=' + m[2].trim());
    }
    if (!pairs.length) {
      const sc = r.headers.get('set-cookie') || '';
      const m = sc.match(/(?:^|,)\s*did=([^;,]+)/);
      if (m) pairs.push('did=' + m[1]);
    }
    return pairs.join('; ');
  } catch { return ''; } finally { clearTimeout(timer); }
}
function resolveApolloRef(v, dc) {
  let hops = 0;
  while (v && typeof v === 'object' && v.type === 'id' && typeof v.id === 'string' && hops < 10) {
    const next = dc[v.id];
    if (!next || typeof next !== 'object') break;
    v = next;
    hops++;
  }
  return v;
}
async function kuaishouInfo(url, timeoutMs = 12000) {
  let id = kuaishouPhotoId(url);
  if (!id) {
    id = await resolveKuaishouShort(url);
    if (!id) return null;
  }
  // Kuaishou's edge closes connections from datacenter IPs now and then
  // (SocketError: other side closed) — one retry with a fresh device id
  // after a short pause covers the transient case. A second failure is
  // treated as a block, not retried in a loop (retrying only resets the
  // throttle window).
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 3000));
    const out = await kuaishouInfoOnce(id, timeoutMs);
    if (out) return out;
  }
  return null;
}
async function kuaishouInfoOnce(id, timeoutMs = 12000) {
  const cookies = await kuaishouCookies();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html = '';
  try {
    const r = await fetch('https://www.kuaishou.com/short-video/' + id, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': KUAISHOU_UA, 'Referer': 'https://www.kuaishou.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    });
    if (!r.ok) return null;
    html = await r.text();
    if (html.length > 3 * 1024 * 1024) return null;
  } catch { return null; } finally { clearTimeout(timer); }
  const state = extractJsonObject(html, 'window.__APOLLO_STATE__');
  const dc = (state && state.defaultClient) || {};
  const photo = dc['VisionVideoDetailPhoto:' + id] || {};
  if (!photo || (!photo.manifest && !photo.photoUrl)) return null;
  const cands = [];
  const addManifest = (man) => {
    man = resolveApolloRef(man, dc);
    if (!man || typeof man !== 'object') return;
    for (const aset of (man.adaptationSet || [])) {
      const set = resolveApolloRef(aset, dc);
      if (!set || typeof set !== 'object') continue;
      for (const rep of (set.representation || [])) {
        const r = resolveApolloRef(rep, dc);
        if (!r || typeof r !== 'object') continue;
        const urls = [];
        for (const k of ['url', 'backupUrl']) {
          const v = r[k];
          if (v && typeof v === 'object' && Array.isArray(v.json)) urls.push(...v.json.filter((x) => typeof x === 'string'));
          else if (typeof v === 'string') urls.push(v);
          if (urls.length && k === 'url') break;
        }
        for (const u of urls) {
          if (!u || /\.m3u8/i.test(u)) continue; // HLS is not a single file
          const w = Number(r.width) || 0, h = Number(r.height) || 0;
          cands.push({ q: Math.min(w, h) || h || 0, br: Number(r.avgBitrate) || 0, url: u });
        }
      }
    }
  };
  addManifest(photo.manifest);
  let mh = photo.manifestH265;
  if (mh && typeof mh === 'object') mh = mh.json || mh;
  addManifest(mh);
  for (const k of ['photoUrl', 'photoH265Url']) {
    if (photo[k] && /\.mp4/i.test(photo[k])) cands.push({ q: 0, br: 0, url: photo[k] });
  }
  cands.sort((a, b) => (b.q - a.q) || (b.br - a.br));
  const best = cands[0];
  if (!best) return null; // mp4-less video (HLS only, or removed): no fake button
  let author = '';
  for (const k of Object.keys(dc)) {
    if (k.startsWith('VisionVideoDetailAuthor:')) { author = (dc[k] && dc[k].name) || ''; break; }
  }
  return {
    source: 'kuaishou',
    title: photo.caption || 'Kuaishou video',
    thumbnail: photo.coverUrl || '',
    duration: Math.round((Number(photo.duration) || 0) / 1000),
    uploader: author,
    previewUrl: best.url,
    formats: [directFormat(best.url, best.q ? best.q + 'p' : 'Best quality')],
  };
}

// ---- Haokan ---------------------------------------------------------------
// The video page embeds window.__PRELOADED_STATE__.curVideoMeta with the
// title, duration, poster, playurl and clarityUrl — one direct mp4 per
// quality (sd/hd/sc/1080p/2k) on *.bdstatic.com, signed with auth_key.
// The catch is the User-Agent: a desktop UA gets a 17 KB JS shell whose
// state has NO curVideoMeta; an iPhone UA gets the ~46 KB server-rendered
// page with it. Videos whose meta is encrypted (encrptedVideoMeta) have
// no plain curVideoMeta and return null. Verified 2026-11-24:
// v?vid=12828130032776245970, sd 640x360 h264 + AAC, 6,661,871 B, 136.1 s;
// bdstatic.com answers ACAO: *.
const HAOKAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
function haokanVid(u) {
  try { return new URL(u).searchParams.get('vid') || ''; } catch { return ''; }
}
async function haokanInfo(url, timeoutMs = 10000) {
  const vid = haokanVid(url);
  if (!vid) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html = '';
  try {
    const r = await fetch('https://haokan.baidu.com/v?vid=' + encodeURIComponent(vid), {
      signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': HAOKAN_UA },
    });
    if (!r.ok) return null;
    html = await r.text();
    if (html.length > 3 * 1024 * 1024) return null;
  } catch { return null; } finally { clearTimeout(timer); }
  const state = extractJsonObject(html, 'window.__PRELOADED_STATE__');
  const meta = (state && state.curVideoMeta) || null;
  if (!meta || !meta.playurl) return null;
  const rank = { '2k': 4, '1080p': 3, 'sc': 2, 'hd': 1, 'sd': 0 };
  const label = { '2k': '2K', '1080p': '1080p', 'sc': 'Super clear', 'hd': 'HD', 'sd': 'SD' };
  const formats = (Array.isArray(meta.clarityUrl) ? meta.clarityUrl : [])
    .filter((c) => c && c.url && /\.mp4/i.test(c.url))
    .sort((a, b) => (rank[b.key] ?? -1) - (rank[a.key] ?? -1))
    .map((c) => ({
      id: 'direct-' + (c.key || 'sd'), label: label[c.key] || c.key || 'Best quality',
      ext: 'mp4', hasAudio: true, url: c.url,
      filesize: Math.round((Number(c.videoSize) || 0) * 1024 * 1024),
      note: 'With sound', kind: 'progressive',
    }));
  if (!formats.length) {
    if (/\.mp4/i.test(meta.playurl)) formats.push(directFormat(meta.playurl, 'Best quality'));
    else return null;
  }
  return {
    source: 'haokan',
    title: meta.title || 'Haokan video',
    thumbnail: meta.poster || '',
    duration: Number(meta.duration) || 0,
    uploader: '',
    previewUrl: formats[0].url,
    formats,
  };
}

// ---- Pear Video -----------------------------------------------------------
// The video page itself carries no mp4; the player loads it from
// videoStatus.jsp — GET .../videoStatus.jsp?contId=<id>&mrd=<random>
// WITH Referer: the video page. Without the Referer it falsely answers
// "article offline". The JSON's videoInfo.videos.srcUrl is the single
// direct mp4 on video.pearvideo.com. That CDN sends NO ACAO header at
// all, so the browser cannot fetch+blob it — the frontend's open-in-tab
// fallback (already built for client-side platforms) is how the file
// arrives; the note under the qualities says so. Verified 2026-11-24:
// video_1808207, 406x720 h264 + AAC, 929,777 B, 9.5 s.
function pearContId(u) {
  try {
    const m = new URL(u).pathname.match(/\/video_(\d+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function pearInfo(url, timeoutMs = 10000) {
  const id = pearContId(url);
  if (!id) return null;
  const pageUrl = 'https://www.pearvideo.com/video_' + id;
  const html = await fetchPageHtml(pageUrl);
  // Pear pages carry no og:title — the <title> is
  // "<video title>_一手Video-梨视频官网-Pear Video-梨网站", so the part
  // before the first underscore is the video's title.
  const titleTag = html ? ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '') : '';
  const title = (html ? decodeEntities(ogTag(html, 'og:title')) : '') || titleTag.split('_')[0].trim();
  const thumb = html ? ogTag(html, 'og:image') : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const api = 'https://www.pearvideo.com/videoStatus.jsp?contId=' + encodeURIComponent(id) + '&mrd=' + Math.random();
    const r = await fetch(api, {
      signal: ctrl.signal, headers: { 'User-Agent': DOUYIN_UA, 'Referer': pageUrl },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const src = j && j.videoInfo && j.videoInfo.videos && j.videoInfo.videos.srcUrl;
    if (!src || !/\.mp4/i.test(src)) return null;
    // Pear's minted srcUrl is a timestamp-prefixed path that 404s —
    // the real file lives at cont-<contId>-<num>-hd.mp4 (same <num>).
    // Verified 2026-11-24 on videos 1808207 + 1808211: minted 404,
    // cont-form 200 with valid mp4. HEAD-check, fail soft (no dead button).
    const real = src.replace(/\/(\d+)-(\d+-hd\.mp4)$/, '/cont-' + id + '-$2');
    const cands = real === src ? [real] : [real, src];
    let okUrl = '';
    for (const cand of cands) {
      try {
        const h = await fetch(cand, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': DOUYIN_UA, 'Referer': pageUrl } });
        if (h.ok) { okUrl = cand; break; }
        // 404/4xx: try the next candidate.
      } catch { okUrl = cand; break; } // HEAD itself failed (network) — trust the URL.
    }
    if (!okUrl) return null;
    return {
      source: 'pear',
      title: title || 'Pear Video',
      thumbnail: thumb || (j.videoInfo && j.videoInfo.video_image) || '',
      duration: 0,
      uploader: '',
      previewUrl: okUrl,
      formats: [directFormat(okUrl, 'Best quality')],
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- Zhihu (zvideo) -------------------------------------------------------
// GET https://www.zhihu.com/api/v4/zvideos/<id> — plain GET, no login —
// returns the video JSON; video.playlist is keyed by quality (ld/sd/hd/
// fhd), each a direct mp4 on vdn3.vzuu.com with width/height/size.
// ld and sd share one file, so formats are de-duplicated by URL. The
// CDN echoes the request Origin (ACAO), so fetch+blob works. Verified
// 2026-11-24: zvideo/1342930761977176064, HD 1280x720 h264 + AAC,
// 10,656,588 B (exactly the declared size), 146.3 s.
function zhihuZid(u) {
  try {
    const m = new URL(u).pathname.match(/\/zvideo\/(\d+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}
async function zhihuInfo(url, timeoutMs = 10000) {
  const id = zhihuZid(url);
  if (!id) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://www.zhihu.com/api/v4/zvideos/' + encodeURIComponent(id), {
      signal: ctrl.signal, headers: { 'User-Agent': DOUYIN_UA },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j && j.video;
    if (!v || !v.playlist || typeof v.playlist !== 'object') return null;
    const seen = new Set();
    const rows = [];
    for (const [key, p] of Object.entries(v.playlist)) {
      if (!p || !p.url || !/\.mp4/i.test(p.url) || seen.has(p.url)) continue;
      seen.add(p.url);
      rows.push({ key, url: p.url, h: Number(p.height) || 0, size: Number(p.size) || 0 });
    }
    rows.sort((a, b) => b.h - a.h);
    const formats = rows.map((f) => ({
      id: 'direct-' + f.key, label: f.h ? f.h + 'p' : 'Best quality',
      ext: 'mp4', hasAudio: true, url: f.url, filesize: f.size,
      note: 'With sound', kind: 'progressive',
    }));
    if (!formats.length) return null;
    return {
      source: 'zhihu',
      title: j.title || 'Zhihu video',
      thumbnail: (v.cover_url || '') ,
      duration: Math.round(Number(v.duration) || 0),
      uploader: (j.author && j.author.name) || '',
      previewUrl: formats[0].url,
      formats,
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- SEO: per-platform landing pages --------------------------------------
// Visible brand stays neutral ("Save Video"). Keywords live in the <title>,
// meta description, URL slug, intro text and FAQ — never in the logo or
// the hero heading.
const PLATFORMS = {
  youtube: {
    name: 'YouTube',
    keyword: 'YouTube video downloader',
    title: 'YouTube Video Downloader — Save YouTube Videos in HD | Save Video',
    description: 'YouTube video downloader: paste a YouTube link, preview the video and save it in 1080p, 720p, 480p or 360p with sound, or as audio only. Free, no account, works on phone and PC.',
    h1: 'YouTube videos in every quality',
    intro: 'A free YouTube video downloader that keeps it simple: paste a YouTube link, see the video preview with every available quality, and save the one you want. No account, no software to install, and it works on your phone, tablet and PC.',
    example: 'https://www.youtube.com/watch?v=2ptQ0Z1deuA',
    faq: [
      ['Is the YouTube video downloader free?', 'Yes. You can use the YouTube video downloader here for free, with no account and no software to install.'],
      ['What qualities can I save a YouTube video in?', 'It depends on the video itself. Most YouTube videos offer 1080p, 720p, 480p and 360p with sound, plus an audio-only option. You only ever get the qualities the original video actually has.'],
      ['Do I need a YouTube account?', 'No. Just paste the public video link — no login is needed on either side.'],
      ['Does it work on my phone?', 'Yes. The YouTube video downloader works in any modern mobile browser on Android and iPhone, as well as on desktop.'],
      ['Can I save private YouTube videos?', 'No. Only public videos can be read. Private, deleted or age-restricted videos will not work.'],
    ],
  },
  tiktok: {
    name: 'TikTok',
    keyword: 'TikTok video downloader',
    title: 'TikTok Video Downloader — Save TikTok Videos Without Watermark | Save Video',
    description: 'TikTok video downloader: paste a TikTok link and save the video without watermark in HD, plus the audio as MP3. Free, no account, works on phone and PC.',
    h1: 'TikTok videos in every quality',
    intro: 'A free TikTok video downloader: paste a TikTok link, preview the clip, and save it without watermark in HD — or save just the sound. No account, no app to install.',
    example: 'https://www.tiktok.com/@adorablemonkey168/video/7371259606376467754',
    faq: [
      ['Is the TikTok video downloader free?', 'Yes, completely free — no account and no app install.'],
      ['Are TikTok videos saved without watermark?', 'When TikTok provides a clean version of the video, you get it without watermark. If only the watermarked version exists, that is what is offered.'],
      ['What qualities are available?', 'TikTok videos are usually offered in HD and SD, plus an audio-only option. The quality always matches the original upload.'],
      ['Do I need a TikTok account?', 'No. Paste any public TikTok link and go.'],
      ['Does it work on iPhone and Android?', 'Yes — it works in any modern mobile browser.'],
    ],
  },
  douyin: {
    name: 'Douyin',
    keyword: 'Douyin video downloader',
    title: 'Douyin Video Downloader — Save Douyin Videos Without Watermark | Save Video',
    description: 'Douyin video downloader: paste a Douyin video link, preview it and save it without watermark as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Douyin videos in every quality',
    intro: 'A free Douyin video downloader: paste the video link, preview the clip, and save it without watermark as MP4 with sound. Works with douyin.com video links, iesdouyin.com share links and short v.douyin.com links. No account, no app to install.',
    example: 'https://www.douyin.com/video/7334514828465147176',
    faq: [
      ['Is the Douyin video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Are Douyin videos saved without watermark?', 'Yes. The video file comes without the Douyin watermark on it — what you save is the clean video as uploaded.'],
      ['What qualities are available?', 'Douyin serves the video as an MP4 with sound, in the quality it was uploaded — usually 720p or 1080p.'],
      ['Do I need a Douyin account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  facebook: {
    name: 'Facebook',
    keyword: 'Facebook video downloader',
    title: 'Facebook Video Downloader — Save Facebook Videos & Reels in HD | Save Video',
    description: 'Facebook video downloader: paste a Facebook video or reel link, preview it and save it in HD or SD with sound. Free, no account, works on phone and PC.',
    h1: 'Facebook videos & reels in every quality',
    intro: 'A free Facebook video downloader for videos and reels: paste the link, preview the clip, and save it in HD or SD with sound. No account needed.',
    example: 'https://web.facebook.com/reel/1126999509654190',
    faq: [
      ['Is the Facebook video downloader free?', 'Yes — free, with no account and no software to install.'],
      ['Can I save Facebook reels?', 'Yes. Paste the reel link and you will see the same quality options as for any Facebook video.'],
      ['What qualities are available?', 'Public Facebook videos usually offer HD and SD with sound, plus an audio-only option.'],
      ['Do I need a Facebook account?', 'No. Only the public video link is needed.'],
      ['Can I save private Facebook videos?', 'No. Only public videos can be read.'],
    ],
  },
  instagram: {
    name: 'Instagram',
    keyword: 'Instagram video downloader',
    title: 'Instagram Video Downloader — Save Instagram Reels & Videos in HD | Save Video',
    description: 'Instagram video downloader: paste an Instagram reel or video link, preview it and save it in HD with sound. Free, no account, works on phone and PC.',
    h1: 'Instagram reels & videos in every quality',
    intro: 'A free Instagram video downloader for reels and videos: paste the link, preview the clip, and save it in HD with sound. No account, no app to install.',
    example: 'https://www.instagram.com/reel/',
    faq: [
      ['Is the Instagram video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Can I save Instagram reels?', 'Yes. Paste the reel link and pick a quality to save it.'],
      ['What qualities are available?', 'Instagram reels and videos are usually offered in HD with sound, plus an audio-only option.'],
      ['Do I need an Instagram account?', 'No. Only the public post link is needed.'],
      ['Can I save private Instagram posts?', 'No. Only public posts can be read.'],
    ],
  },
  twitter: {
    name: 'X (Twitter)',
    keyword: 'Twitter video downloader',
    title: 'Twitter Video Downloader — Save X Videos in HD | Save Video',
    description: 'Twitter video downloader: paste an X (Twitter) video link, preview it and save it in HD with sound. Free, no account, works on phone and PC.',
    h1: 'X videos in every quality',
    intro: 'A free Twitter video downloader for X videos: paste the post link, preview the clip, and save it in HD with sound. No account needed.',
    example: 'https://x.com/Eminem/status/943590594491772928',
    faq: [
      ['Is the Twitter video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'X videos are offered as direct files, usually 720p, 360p and 180p, with sound.'],
      ['Do I need an X account?', 'No. Only the public post link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private X videos?', 'No. Only public posts can be read.'],
    ],
  },
  bluesky: {
    name: 'Bluesky',
    keyword: 'Bluesky video downloader',
    title: 'Bluesky Video Downloader — Save Bluesky Videos in HD | Save Video',
    description: 'Bluesky video downloader: paste a Bluesky post link, preview the video and save the original file with sound. Free, no account, works on phone and PC.',
    h1: 'Bluesky videos in every quality',
    intro: 'A free Bluesky video downloader: paste the post link, preview the clip, and save the original video file with sound. No account, no app to install.',
    example: 'https://bsky.app/profile/livvywivvyy.bsky.social/post/3myw2cqwb2k22',
    faq: [
      ['Is the Bluesky video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'Bluesky serves the original video file as posted, with sound. You get the file exactly as the author uploaded it.'],
      ['Do I need a Bluesky account?', 'No. Only the public post link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private Bluesky posts?', 'No. Only public posts can be read.'],
    ],
  },
  tumblr: {
    name: 'Tumblr',
    keyword: 'Tumblr video downloader',
    title: 'Tumblr Video Downloader — Save Tumblr Videos as MP4 | Save Video',
    description: 'Tumblr video downloader: paste a Tumblr video post link, preview it and save the original MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Tumblr videos in every quality',
    intro: 'A free Tumblr video downloader: paste the post link, preview the clip, and save the original MP4 with sound. Works with native video posts uploaded to Tumblr.',
    example: 'https://high-quality-tiktoks.tumblr.com/post/698923599747235841/she-accidentally-turned-off-her-game-and-politely',
    faq: [
      ['Is the Tumblr video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Tumblr posts work?', 'Only posts with a video uploaded to Tumblr itself. GIF posts are images, not videos, and YouTube or Vimeo players embedded in a post belong to those sites, not Tumblr.'],
      ['What qualities are available?', 'Tumblr serves the original MP4 as uploaded, with sound — usually 720p or 1080p.'],
      ['Do I need a Tumblr account?', 'No. Only the public post link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  twitch: {
    name: 'Twitch',
    keyword: 'Twitch clip downloader',
    title: 'Twitch Clip Downloader — Save Twitch Clips as MP4 | Save Video',
    description: 'Twitch clip downloader: paste a Twitch clip link, preview it and save the clip as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Twitch clips in every quality',
    intro: 'A free Twitch clip downloader: paste the clip link, preview it, and save the clip as MP4 with sound. Works with public clips from clips.twitch.tv or twitch.tv.',
    example: 'https://clips.twitch.tv/CharmingRudeStorkPhilosoraptor-LfhoaF0fD2wwl-hr',
    faq: [
      ['Is the Twitch clip downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Can I save full Twitch broadcasts (VODs)?', 'No. Full broadcasts stream only and have no single file to save — only short clips can be saved as MP4. Very long videos cannot be downloaded as one file.'],
      ['What qualities are available?', 'Clips are offered up to 1080p with sound, exactly as Twitch serves them.'],
      ['Do I need a Twitch account?', 'No. Only the public clip link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  pinterest: {
    name: 'Pinterest',
    keyword: 'Pinterest video downloader',
    title: 'Pinterest Video Downloader — Save Pinterest Videos as MP4 | Save Video',
    description: 'Pinterest video downloader: paste a Pinterest pin link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Pinterest videos in every quality',
    intro: 'A free Pinterest video downloader: paste the pin link, preview the video, and save it as MP4 with sound. Works with public video pins.',
    example: 'https://www.pinterest.com/pin/aao-milo-chalein--874683558918923586/',
    faq: [
      ['Is the Pinterest video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'Pinterest serves the pin video as an MP4 with sound, in the quality the pin was uploaded.'],
      ['Do I need a Pinterest account?', 'No. Only the public pin link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private Pinterest pins?', 'No. Only public pins can be read.'],
    ],
  },
  moj: {
    name: 'Moj',
    keyword: 'Moj video downloader',
    title: 'Moj Video Downloader — Save Moj Videos as MP4 | Save Video',
    description: 'Moj video downloader: paste a Moj video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Moj videos in every quality',
    intro: 'A free Moj video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public Moj videos.',
    example: 'https://mojapp.in/@kamyabi/video/4002006172',
    faq: [
      ['Is the Moj video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'Moj serves the video as an MP4 with sound, in the quality it was uploaded.'],
      ['Do I need a Moj account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private Moj videos?', 'No. Only public videos can be read.'],
    ],
  },
  sharechat: {
    name: 'ShareChat',
    keyword: 'ShareChat video downloader',
    title: 'ShareChat Video Downloader — Save ShareChat Videos as MP4 | Save Video',
    description: 'ShareChat video downloader: paste a ShareChat video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'ShareChat videos in every quality',
    intro: 'A free ShareChat video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public ShareChat videos.',
    example: 'https://sharechat.com/video/8r89QKxa',
    faq: [
      ['Is the ShareChat video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'ShareChat serves the video as an MP4 with sound, in the quality it was uploaded.'],
      ['Do I need a ShareChat account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private ShareChat videos?', 'No. Only public videos can be read.'],
    ],
  },
  linkedin: {
    name: 'LinkedIn',
    keyword: 'LinkedIn video downloader',
    title: 'LinkedIn Video Downloader — Save LinkedIn Videos as MP4 | Save Video',
    description: 'LinkedIn video downloader: paste a LinkedIn post link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'LinkedIn videos in every quality',
    intro: 'A free LinkedIn video downloader: paste the post link, preview the video, and save it as MP4 with sound. Works with public LinkedIn posts that carry a video.',
    example: 'https://www.linkedin.com/posts/andreban_webmcp-agenticweb-ai-activity-7500591659466960897-sKKi',
    faq: [
      ['Is the LinkedIn video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'LinkedIn serves its videos as MP4 files, usually 720p and 640p with sound.'],
      ['Do I need a LinkedIn account?', 'No. Only the public post link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private LinkedIn posts?', 'No. Only public posts can be read.'],
    ],
  },
  snapchat: {
    name: 'Snapchat',
    keyword: 'Snapchat video downloader',
    title: 'Snapchat Video Downloader — Save Snapchat Spotlight Videos | Save Video',
    description: 'Snapchat video downloader: paste a Snapchat Spotlight link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Snapchat Spotlight videos in every quality',
    intro: 'A free Snapchat video downloader for Spotlight videos: paste the Spotlight link, preview it, and save it as MP4 with sound. Works with public Spotlight videos.',
    example: 'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZ2xobHJkZ3FqAZSt3AdfAZSt3AdOAAAAAQ',
    faq: [
      ['Is the Snapchat video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Snapchat links work?', 'Spotlight video links (snapchat.com/spotlight/…) work. Stories only last 24 hours, so an expired story is gone.'],
      ['What qualities are available?', 'Spotlight videos are served as MP4 files with sound, in the quality they were uploaded.'],
      ['Do I need a Snapchat account?', 'No. Only the public Spotlight link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  tencent: {
    name: 'Tencent Video',
    keyword: 'Tencent Video downloader',
    title: 'Tencent Video Downloader — Save Tencent Videos as MP4 | Save Video',
    description: 'Tencent Video downloader: paste a Tencent Video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Tencent Video videos in every quality',
    intro: 'A free Tencent Video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public Tencent Video videos.',
    example: 'https://v.qq.com/x/page/t0338rg171l.html',
    faq: [
      ['Is the Tencent Video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Tencent Video links work?', 'Video page links (v.qq.com/x/page/…) work. Cover pages (v.qq.com/x/cover/…) do not always offer a file to save.'],
      ['What qualities are available?', 'Tencent Video serves its videos as MP4 files with sound, in the quality the video was uploaded — usually 480p or lower. VIP-only videos cannot be saved.'],
      ['Do I need a Tencent Video account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  kuaishou: {
    name: 'Kuaishou',
    keyword: 'Kuaishou video downloader',
    title: 'Kuaishou Video Downloader — Save Kuaishou Videos as MP4 | Save Video',
    description: 'Kuaishou video downloader: paste a Kuaishou video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Kuaishou videos in every quality',
    intro: 'A free Kuaishou video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with kuaishou.com short-video links, kwai.com links and v.kuaishou.com short links. No account, no app to install.',
    example: 'https://www.kuaishou.com/short-video/3x7edaa985qmhqy',
    faq: [
      ['Is the Kuaishou video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Kuaishou links work?', 'Short-video links (kuaishou.com/short-video/…), kwai.com links and v.kuaishou.com short links work.'],
      ['What qualities are available?', 'Kuaishou serves its videos as MP4 files with sound, in the quality they were uploaded — usually 720p.'],
      ['Do I need a Kuaishou account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  haokan: {
    name: 'Haokan',
    keyword: 'Haokan video downloader',
    title: 'Haokan Video Downloader — Save Haokan Videos as MP4 | Save Video',
    description: 'Haokan video downloader: paste a Haokan video link, preview the video and save it in SD, HD, Super clear, 1080p or 2K as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Haokan videos in every quality',
    intro: 'A free Haokan video downloader: paste the video link, preview the clip, and save it as MP4 with sound in SD, HD, Super clear, 1080p or 2K. No account, no app to install.',
    example: 'https://haokan.baidu.com/v?vid=12828130032776245970',
    faq: [
      ['Is the Haokan video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Haokan links work?', 'Video page links (haokan.baidu.com/v?vid=…) work.'],
      ['What qualities are available?', 'Haokan offers SD, HD, Super clear, 1080p and 2K as MP4 files with sound, depending on the video.'],
      ['Do I need a Haokan account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  pear: {
    name: 'Pear Video',
    keyword: 'Pear Video downloader',
    title: 'Pear Video Downloader — Save Pear Videos as MP4 | Save Video',
    description: 'Pear Video downloader: paste a Pear Video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Pear Video videos in every quality',
    intro: 'A free Pear Video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with pearvideo.com video links. No account, no app to install.',
    example: 'https://www.pearvideo.com/video_1808207',
    faq: [
      ['Is the Pear Video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Pear Video links work?', 'Video links (pearvideo.com/video_…) work.'],
      ['What qualities are available?', 'Pear Video serves its videos as MP4 files with sound, in the quality they were uploaded.'],
      ['Do I need a Pear Video account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  zhihu: {
    name: 'Zhihu',
    keyword: 'Zhihu video downloader',
    title: 'Zhihu Video Downloader — Save Zhihu Videos as MP4 | Save Video',
    description: 'Zhihu video downloader: paste a Zhihu video link, preview the video and save it in 480p, 720p or 1080p as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Zhihu videos in every quality',
    intro: 'A free Zhihu video downloader: paste the video link, preview the clip, and save it as MP4 with sound in 480p, 720p or 1080p. Works with zhihu.com/zvideo/… links. No account, no app to install.',
    example: 'https://www.zhihu.com/zvideo/1342930761977176064',
    faq: [
      ['Is the Zhihu video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Zhihu links work?', 'Video links (zhihu.com/zvideo/…) work.'],
      ['What qualities are available?', 'Zhihu offers 480p, 720p and 1080p as MP4 files with sound, depending on the video.'],
      ['Do I need a Zhihu account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  weibo: {
    name: 'Weibo',
    keyword: 'Weibo video downloader',
    title: 'Weibo Video Downloader — Save Weibo Videos as MP4 | Save Video',
    description: 'Weibo video downloader: paste a Weibo video link, preview the video and save it in 720p or 1080p as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Weibo videos in every quality',
    intro: 'A free Weibo video downloader: paste the video link, preview the clip, and save it as MP4 with sound in 720p or 1080p. Works with weibo.com video links and m.weibo.cn status links. No account, no app to install.',
    example: 'https://weibo.com/7827771738/N4xlMvjhI',
    faq: [
      ['Is the Weibo video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Weibo links work?', 'Video links (weibo.com/…/…) and mobile status links (m.weibo.cn/status/…) work.'],
      ['What qualities are available?', 'Weibo offers 720p and 1080p as MP4 files with sound, depending on the video.'],
      ['Do I need a Weibo account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
  sohu: {
    name: 'Sohu',
    keyword: 'Sohu video downloader',
    title: 'Sohu Video Downloader — Save Sohu Videos as MP4 | Save Video',
    description: 'Sohu video downloader: paste a Sohu video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Sohu videos in every quality',
    intro: 'A free Sohu video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with tv.sohu.com video links. No account, no app to install.',
    example: 'https://tv.sohu.com/v/dXMvNDQxNzU2MjE5LzY5NjY5MzkxNC5zaHRtbA==.html',
    faq: [
      ['Is the Sohu video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['Which Sohu links work?', 'Video page links (tv.sohu.com/v/…) work.'],
      ['What qualities are available?', 'Sohu offers its videos as MP4 files with sound, in the quality the video was uploaded.'],
      ['Do I need a Sohu account?', 'No. Only the public video link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
    ],
  },
};

function faqJsonLd(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

const landingTemplate = fs.readFileSync(path.join(__dirname, 'public', 'landing.html'), 'utf8');

function renderLanding(platform, req) {
  const p = PLATFORMS[platform];
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  const url = base + '/' + platform;
  const faqHtml = p.faq.map(([q, a]) =>
    '<details><summary>' + q + '</summary><p>' + a + '</p></details>').join('\n');
  const chips = Object.keys(PLATFORMS).map((k) =>
    '<a class="chip' + (k === platform ? ' active' : '') + '" href="/' + k + '">' + PLATFORMS[k].name + '</a>').join('\n');
  return landingTemplate
    .replaceAll('{{TITLE}}', p.title)
    .replaceAll('{{DESCRIPTION}}', p.description)
    .replaceAll('{{CANONICAL}}', url)
    .replaceAll('{{H1}}', p.h1)
    .replaceAll('{{INTRO}}', p.intro)
    .replaceAll('{{PLATFORM}}', p.name)
    .replaceAll('{{EXAMPLE}}', p.example)
    .replaceAll('{{FAQ_HTML}}', faqHtml)
    .replaceAll('{{FAQ_JSON}}', JSON.stringify(faqJsonLd(p.faq)))
    .replaceAll('{{CHIPS}}', chips);
}

// ---- routes ----------------------------------------------------------------

app.get('/api/config', rateLimit(30, 60000), (req, res) => res.json({ backupOrigins: BACKUP_ORIGINS, backupOrigin: BACKUP_ORIGINS[0] || null }));

app.get('/api/health', (req, res) => res.json({ ok: true, cookies: cookieStatus() }));

// ---- cookie sync (private, owner-only) -------------------------------------
// POST /api/cookies lets the owner's private browser extension push fresh
// cookies to this server, so downloads keep working without a restart.
// Auth is a shared secret (COOKIE_SYNC_SECRET, set in the Render env vars
// on every region). Without the secret the endpoint is disabled; the
// secret and all cookie contents are never logged and never returned.
// The extension runs only in the owner's browser and only ever talks to
// the Save Video origins — visitors' cookies are never involved.
// Second lock: the extension encrypts the cookies text with AES-256-GCM
// before POSTing (key = SHA-256 of the same shared secret, fresh random
// 12-byte IV per request; WebCrypto's output is ciphertext with the 16-byte
// auth tag appended). The extension posts to the hidden path below; the old
// /api/cookies path stays as an alias so extension versions already sent
// to the owner keep working. The old plaintext {platform, cookies} shape
// is still accepted for those versions; a failed decrypt is a 400 and
// nothing about the payload is ever logged.
function syncKey(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}
function decryptSyncPayload(secret, body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.cookies === 'string') return body.cookies; // legacy plaintext
  if (typeof body.data !== 'string' || typeof body.iv !== 'string') return null;
  try {
    const iv = Buffer.from(body.iv, 'base64');
    const raw = Buffer.from(body.data, 'base64');
    if (iv.length !== 12 || raw.length <= 16) return null;
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(0, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', syncKey(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}
function handleCookieSync(req, res) {
  const secret = process.env.COOKIE_SYNC_SECRET;
  if (!secret) return res.status(503).json({ error: 'Cookie sync is not configured on this server.' });
  const provided = String(req.headers['x-mediahub-secret'] || '');
  let ok = false;
  if (provided.length === secret.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret)); } catch { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: 'Unauthorized.' });
  const platform = req.body && req.body.platform;
  if (!COOKIE_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Expected {platform, cookies} or {platform, iv, data}.' });
  }
  const hadEncrypted = req.body && (typeof req.body.data === 'string' || typeof req.body.iv === 'string');
  const cookies = decryptSyncPayload(secret, req.body);
  if (cookies === null) {
    return res.status(400).json({ error: hadEncrypted ? 'Could not decrypt cookies.' : 'Expected {platform, cookies} or {platform, iv, data}.' });
  }
  const lines = netscapeLines(cookies);
  if (!lines) return res.status(400).json({ error: 'Cookies must be a Netscape cookies.txt file.' });
  try {
    const file = path.join(os.tmpdir(), `mediahub-cookies-${platform}.txt`);
    fs.writeFileSync(file, cookies, { mode: 0o600 });
    cookieFiles[platform] = file;
    console.log(`cookies synced for ${platform} (${lines.length} cookies)`);
    return res.json({ ok: true, platform, count: lines.length });
  } catch (e) {
    console.error(`cookies sync failed for ${platform}:`, scrub(e.message));
    return res.status(500).json({ error: 'Could not save cookies.' });
  }
}
const COOKIE_SYNC_PATH = '/api/sync-7db99ff0fb3baef0756fa410';
app.post('/api/cookies', rateLimit(10, 60000), handleCookieSync);
app.post(COOKIE_SYNC_PATH, rateLimit(10, 60000), handleCookieSync);

app.get('/robots.txt', (req, res) => {
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: ' + base + '/sitemap.xml\n');
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  const legal = ['privacy.html', 'terms.html', 'about.html', 'contact.html', 'disclaimer.html', 'cookie-policy.html'];
  const urls = ['', ...Object.keys(PLATFORMS), ...legal].map((p) =>
    '  <url><loc>' + base + '/' + p + '</loc><changefreq>weekly</changefreq><priority>' + (p === '' ? '1.0' : (legal.indexOf(p) >= 0 ? '0.5' : '0.8')) + '</priority></url>');
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>');
});

app.get('/:platform(youtube|tiktok|douyin|facebook|instagram|twitter|bluesky|tumblr|twitch|pinterest|moj|sharechat|linkedin|snapchat|tencent|kuaishou|haokan|pear|zhihu|weibo|sohu)', (req, res) => {
  res.type('text/html').send(renderLanding(req.params.platform, req));
});

app.post('/api/meta', rateLimit(30, 60000), async (req, res) => {
  const url = String(req.body && req.body.url || '').trim();
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Please paste a valid video link.' });
  }
  // X: the tweet page already carries the direct mp4s, and the preview
  // scrape (og tags) fetches that same page — so run the X scrape in
  // parallel and attach the qualities to the preview when it lands.
  // This is what makes X robust when Stage 2 (/api/info) stalls in a
  // real browser: the qualities arrive WITH the preview (~1s) instead
  // of depending on Stage 2's timers at all. The scrape is capped at
  // 2.5s and never delays the preview past that; when it misses, the
  // meta returns as before and Stage 2 handles the link as today.
  // Formats are attached to a COPY — fastMeta's cache must stay
  // format-free (the cached meta is shared; the twimg URLs are fresh
  // per paste from the scrape).
  const scrapeP = clientSideKey(url) === 'x' ? scrapeDirectInfo(url).catch(() => null) : null;
  const meta = await fastMeta(url);
  if (!meta) return res.status(404).json({ error: 'No preview available yet.' });
  if (scrapeP) {
    const scraped = await Promise.race([scrapeP, new Promise((ok) => setTimeout(() => ok(null), 2500))]);
    if (scraped && Array.isArray(scraped.formats) && scraped.formats.length) {
      const out = Object.assign({}, meta);
      out.formats = scraped.formats;
      out.previewUrl = scraped.previewUrl || meta.previewUrl;
      out.clientSide = true;
      out.duration = out.duration || scraped.duration || 0;
      out.uploader = out.uploader || scraped.uploader || '';
      return res.json(out);
    }
  }
  return res.json(meta);
});

app.post('/api/info', rateLimit(30, 60000), async (req, res) => {
  let url = String(req.body && req.body.url || '').trim();
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Please paste a valid video link from TikTok, Douyin, Facebook, Instagram, YouTube, X, Bluesky, Tumblr, Twitch, Pinterest, Moj, ShareChat, LinkedIn, Snapchat, Tencent Video, Kuaishou, Haokan, Pear Video, Zhihu, Weibo or Sohu.' });
  }
  // TikTok short links: resolve the 301 to the canonical video URL
  // first (see resolveTikTokShort) so every stage below — cache,
  // tikwm, yt-dlp — works on the fast form.
  if (isTikTok(url)) url = await resolveTikTokShort(url);
  // Douyin: signed CDN URLs live ~5 min, shorter than the 10-min info
  // cache — never serve a cached Douyin result, and never store one.
  // Kuaishou: same treatment — its signed CDN URLs have no visible
  // expiry, so they are resolved fresh on every request.
  // Weibo: its CDN URLs live ~1 h, and Sohu's sig token is minted per
  // request — both are likewise resolved fresh on every request.
  const isDouyin = clientSideKey(url) === 'douyin';
  const noCacheKey = clientSideKey(url);
  const cached = (isDouyin || noCacheKey === 'kuaishou' || noCacheKey === 'weibo' || noCacheKey === 'sohu') ? null : cacheGet(url);
  if (cached) return res.json(cached);
  // Hard 25s overall cap: whatever the extraction path does (tikwm,
  // page scrape, yt-dlp fallback rounds), /api/info ALWAYS answers
  // within 25s — success, a clear 404/502 from the lookup, or the
  // timeout 502 below. The lookup itself returns {status, body} and
  // never touches res, so a late background finish cannot double-send.
  // (Per-attempt timeouts inside are unchanged; this is only the outer cap.)
  async function computeInfo() {
  try {
    let result = null;
    if (isTikTok(url)) {
      result = await tikwmInfo(url, 6000);
      // TikTok Series videos: tikwm returns -1 and yt-dlp finds no
      // formats (TikTok's own page serves an empty playAddr for them).
      // Try the SSSTik resolver before the yt-dlp rounds — yt-dlp can
      // never read a Series video, and the resolver answers in ~2s.
      // Normal videos reach here only when tikwm is down, and SSSTik
      // resolves those too. 8s cap here so the yt-dlp rounds still get
      // time inside the 25s outer cap.
      if (!result) {
        result = await ssstikInfo(url, 8000);
        if (result) return { status: 200, body: result }; // no cache: signed token URL
      }
      // fall through to yt-dlp when tikwm AND the resolver have nothing
    }
    if (!result && isDouyin) {
      // Douyin embed-player lane (no login): the server calls Douyin's
      // own aweme detail API and returns the watermark-free CDN file
      // for the visitor's browser to fetch. yt-dlp is NOT used here —
      // its Douyin extractor needs cookies.
      result = await douyinInfo(url);
      if (!result) throw new Error('Could not read this Douyin link. The video may be private, removed, or Douyin is blocking us right now.');
      result.clientSide = true;
      return { status: 200, body: result }; // no cacheSet: signed URLs live ~5 min
    }
    if (!result) {
      // Kuaishou / Haokan / Pear Video / Zhihu: each has its own
      // no-login lane (see the functions above). No yt-dlp fall-through:
      // yt-dlp has no extractor for Kuaishou or Haokan, and the direct
      // calls are faster than its Zhihu/Pear extractors — falling
      // through could only burn time against the 25s cap. Fail fast
      // with a clear error instead; the frontend retries the next region.
      const cnKey = clientSideKey(url);
      if (cnKey === 'kuaishou' || cnKey === 'haokan' || cnKey === 'pear' || cnKey === 'zhihu') {
        const cnName = { kuaishou: 'Kuaishou', haokan: 'Haokan', pear: 'Pear Video', zhihu: 'Zhihu' }[cnKey];
        const cnFn = { kuaishou: kuaishouInfo, haokan: haokanInfo, pear: pearInfo, zhihu: zhihuInfo }[cnKey];
        result = await cnFn(url);
        if (!result) throw new Error('Could not read this ' + cnName + ' link. The video may be private, removed, or ' + cnName + ' is blocking us right now.');
        result.clientSide = true;
        if (cnKey !== 'kuaishou') cacheSet(url, result); // Kuaishou: no cache (see above)
        return { status: 200, body: result };
      }
    }
    if (!result) {
      // Pinterest / Moj / ShareChat / Snapchat / Tumblr: the direct file
      // is read off the page itself (see scrapeDirectInfo) — scrape first
      // (fast, no yt-dlp). When the page embeds no usable file — an image
      // post, or a Tumblr post the scrape cannot read — Tumblr falls
      // through to yt-dlp below; the others fail with a clear error.
      const scrapeKey = clientSideKey(url);
      if (scrapeKey === 'pinterest' || scrapeKey === 'moj' || scrapeKey === 'sharechat' || scrapeKey === 'snapchat' || scrapeKey === 'tumblr' || scrapeKey === 'x') {
        result = await scrapeDirectInfo(url);
        // ShareChat / Snapchat only: when the page embeds no usable file,
        // try yt-dlp once (12s) before giving up — it reads og:video /
        // the snapchat extractor where the scrape cannot.
        if (!result && (scrapeKey === 'sharechat' || scrapeKey === 'snapchat')) {
          result = await ytdlpDirectFallback(url);
        }
        if (result) {
          result.clientSide = true;
          cacheSet(url, result);
          return { status: 200, body: result };
        }
        // Tumblr falls through to yt-dlp when the scrape finds nothing
        // (image post or unreadable post). X does NOT: its yt-dlp
        // extractor needs the GraphQL API, which blocks datacenter IPs,
        // so the fall-through can never succeed on Render — it only
        // burns 20s and trips the 25s outer cap, which is exactly the
        // live "Finding qualities…" hang. Fail fast with a clear error
        // instead; the frontend retries the next region.
        if (scrapeKey !== 'tumblr') throw new Error('Could not find a video file on this page. The video may be private, removed, or an image post.');
      }
      let info = null;
      try {
        const res = await ytdlpInfoWithFallbacks(url);
        info = res.info;
        rawClientSet(url, res.clientArgs);
        rawProxySet(url, res.viaProxy);
      } catch (e) {
        info = null;
        // Geo-block: keep the signal — the outer catch turns it into a
        // geoBlocked 502 the frontend can retry on another region.
        if (e.geoBlocked || isGeoBlocked(e.detail)) {
          e.geoBlocked = true;
          throw e;
        }
        console.error('info failed:', platformOf(url), scrub(e.detail || e.message));
      }
      if (!info) throw new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
      // Twitch VOD guard: full broadcasts are hours long and stream-only
      // (HLS playlists, no single file) — only short clips can be saved.
      // Refuse them plainly instead of offering a download that cannot
      // ever complete as one file.
      if (scrapeKey === 'twitch' && (info.duration || 0) > 7200) {
        return { status: 404, body: { error: 'This is a full Twitch broadcast (' + Math.round(info.duration / 3600) + 'h long). Broadcasts stream only and cannot be saved as one file — only short Twitch clips can be saved.' } };
      }
      // Weibo + Sohu reach here through yt-dlp's own extractors (no
      // dedicated lane above). Weibo: the extractor mints Weibo's
      // anonymous first-visit guest token itself (fingerprint POST +
      // callback, no account, no stored credentials — a plain no-cookie
      // fetch is 302'd to the Sina Visitor System); its CDNs send no
      // ACAO, so the browser opens the file in a new tab instead of
      // fetch+blob (see the note below). Sohu: the extractor reads the
      // page's vid, then hot.vrs.sohu.com (429s after ~6–8 rapid calls
      // from one IP — one info call per paste keeps us under it) and the
      // allot endpoint for a direct mp4; some Sohu videos are licensed
      // to Mainland China only and fail per-video as geo-blocked.
      rawCacheSet(url, info);
      if (isClientSideOnly(url)) {
        // Direct files only — the visitor's browser downloads them itself.
        // No merged pairs, no server save: a video with no direct file
        // is reported as such instead of being listed.
        const formats = buildDirectFormats(info);
        if (!formats.length) return { status: 404, body: { error: 'This video has no direct file to save. It only streams, so the browser cannot download it as one file.' } };
        result = {
          source: 'generic',
          title: info.title || 'Video',
          thumbnail: info.thumbnail || '',
          duration: info.duration || 0,
          uploader: info.uploader || info.channel || '',
          previewUrl: previewUrl(info),
          formats,
          clientSide: true,
          note: clientSideNote(url, info),
        };
        if (scrapeKey === 'sohu') {
          // Sohu: yt-dlp reports a bogus 2160p height (the 'high' file
          // is really 960x540) — label by Sohu's own quality name
          // instead. Its CDN URLs also come back http://, which an
          // https page cannot preview or fetch (mixed content) — the
          // same files serve over https with ACAO: *, so rewrite the
          // scheme.
          const sohuLabel = { nor: 'Normal', high: 'High', super: 'Super', ori: 'Original' };
          const toHttps = (u) => String(u || '').replace(/^http:\/\/(video\d+\.vod\.tv\.itc\.cn\/)/, 'https://$1');
          for (const f of result.formats) {
            if (sohuLabel[f.id]) f.label = sohuLabel[f.id];
            f.url = toHttps(f.url);
          }
          result.previewUrl = toHttps(result.previewUrl);
        }
      } else {
        const formats = buildFormats(info, { noSeparateAudio: isTikTok(url) });
        if (!formats.length) return { status: 404, body: { error: 'No playable versions were found for this link.' } };
        result = {
          source: 'generic',
          title: info.title || 'Video',
          thumbnail: info.thumbnail || '',
          duration: info.duration || 0,
          uploader: info.uploader || info.channel || '',
          previewUrl: previewUrl(info),
          formats,
        };
      }
    }
    // Weibo / Sohu: signed URLs (see above) — never store the result.
    if (noCacheKey !== 'weibo' && noCacheKey !== 'sohu') cacheSet(url, result);
    return { status: 200, body: result };
  } catch (e) {
    if (e.geoBlocked) {
      console.error('info geo-blocked:', platformOf(url), scrub(e.detail || ''));
      return { status: 502, body: { error: 'This video is blocked in this region.', geoBlocked: true } };
    }
    console.error('info failed:', scrub(e.message));
    return { status: 502, body: { error: e.message || 'Could not read this link. Please try another one.' } };
  }
  }
  try {
    const out = await withTimeout(computeInfo(), 25000, 'Info lookup timed out. Please try again.');
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error('info timed out:', platformOf(url));
    return res.status(502).json({ error: 'This link is taking too long to read. Please try again.' });
  }
});

// Short honest note shown under a client-side-only platform's qualities:
// Twitch only saves clips.
function clientSideNote(url, info) {
  const key = clientSideKey(url);
  if (key === 'twitch') return 'Twitch clips only — full broadcasts stream only and cannot be saved as one file.';
  if (key === 'tumblr') return 'Only posts with a video uploaded to Tumblr work — GIFs and embedded YouTube/Vimeo players have no Tumblr file.';
  if (key === 'pear') return 'Pear Video files open in a new tab to save — their server does not let the browser download the file directly.';
  if (key === 'weibo') return 'Weibo files open in a new tab to save — their server does not let the browser download the file directly.';
  return '';
}

app.get('/api/save', rateLimit(10, 60000), async (req, res) => {
  const url = String(req.query.url || '').trim();
  const formatId = String(req.query.formatId || '').trim();
  const title = safeTitle(req.query.t || req.query.title || 'video');
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Invalid link.' });
  }
  // Client-side-only platforms never download through the server: their
  // files are fetched by the visitor's own browser. A save request for
  // one is refused here so no code path can silently stream it.
  if (isClientSideOnly(url)) {
    return res.status(400).json({ error: 'This video saves straight from your browser — use the Save button on the page.' });
  }
  // TikTok Series files (ssstik-*) never download through the server
  // either: the visitor's browser opens the file in a new tab instead.
  if (formatId.startsWith('ssstik-')) {
    return res.status(400).json({ error: 'This video saves straight from your browser — use the Save button on the page.' });
  }
  if (!formatId || !/^[A-Za-z0-9+._-]{1,64}$/.test(formatId)) {
    return res.status(400).json({ error: 'Invalid quality choice.' });
  }

  // TikTok direct streams from tikwm (streamed through, never redirected).
  if (formatId.startsWith('tikwm-')) {
    const streamUrl = await tikwmStreamUrl(url, formatId);
    if (!streamUrl) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const ext = formatId === 'tikwm-audio' ? 'mp3' : 'mp4';
    try {
      const r = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } });
      if (!r.ok || !r.body) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      setDownloadHeaders(res, title, ext, ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok));
        }
        res.end();
      } catch { try { res.end(); } catch {} }
    } catch (e) {
      console.error('stream failed:', scrub(e.message));
      if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      else try { res.end(); } catch {}
    }
    return;
  }

  // Mirror streams (Invidious / Piped): resolve the direct stream URL and stream it through.
  if (formatId.startsWith('inv-') || formatId.startsWith('pip-')) {
    const streamUrl = await mirrorStreamUrl(url, formatId);
    if (!streamUrl) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const ext = formatId.endsWith('-audio') ? 'm4a' : 'mp4';
    try {
      const r = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok || !r.body) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      setDownloadHeaders(res, title, ext, ext === 'm4a' ? 'audio/mp4' : 'video/mp4');
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok));
        }
        res.end();
      } catch { try { res.end(); } catch {} }
    } catch (e) {
      console.error('stream failed:', scrub(e.message));
      if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      else try { res.end(); } catch {}
    }
    return;
  }

  // Direct stream: when /api/info already resolved this link, its raw
  // formats carry direct file URLs — stream one instead of running yt-dlp
  // a second time (which may fail on this IP through a different client).
  // Merged video+audio (id contains '+') still needs the yt-dlp path below.
  // Audio-only streams are NOT streamed directly: YouTube throttles a
  // plain fetch of an audio-only URL to ~30KB/s, while yt-dlp pulls the
  // same URL at full speed — so audio goes to the yt-dlp save below.
  // YouTube/TikTok through WARP: the direct googlevideo fetch runs on
  // Render's own IP (blocked), so skip it and go straight to the yt-dlp
  // save below, which uses the proxy.
  // Same egress as the info call that produced this link (cached); when
  // there is no cached verdict (direct save link, expired cache), fall
  // back to proxy-if-up.
  const cachedProxy = rawProxyGet(url);
  const saveProxyArgs = await proxyArgs(url, cachedProxy === null ? true : cachedProxy);
  if (!formatId.includes('+') && !saveProxyArgs.length) {
    const raw = rawCacheGet(url);
    const fmt = raw && Array.isArray(raw.formats) ? raw.formats.find((f) => f && String(f.format_id) === formatId && f.url) : null;
    if (fmt && fmt.vcodec && fmt.vcodec !== 'none') {
      const ext2 = String(fmt.ext || 'mp4').toLowerCase();
      const ctype = ext2 === 'mp3' ? 'audio/mpeg' : ext2 === 'm4a' ? 'audio/mp4' : ext2 === 'webm' ? 'video/webm' : 'video/mp4';
      try {
        if (await streamThrough(res, fmt.url, title, ext2, ctype)) return;
      } catch (e) {
        console.error('direct stream failed:', scrub(e.message));
      }
      // fall through to the yt-dlp save below
    }
  }

  const merged = formatId.includes('+');
  const ext = 'mp4';

  if (merged) {
    // Merged video+audio cannot be streamed to stdout as MP4 (ffmpeg falls
    // back to an MPEG-TS stream on a pipe), so merge to a temp file, stream
    // the file, and delete it immediately — no buildup on disk.
    const tmp = path.join(os.tmpdir(), 'mediahub-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    const args = ['-f', formatId, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
      '--socket-timeout', '15', ...(rawClientGet(url) || ytdlpExtraArgs(url)), ...saveProxyArgs, ...cookieArgs(url), '-o', tmp, url];
    const child = spawn(YTDLP, args, { timeout: 900000 });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', () => {
      fs.unlink(tmp, () => {});
      if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    });
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tmp)) {
        console.error('save failed:', scrub(stderr.slice(-500)));
        fs.unlink(tmp, () => {});
        if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
        return;
      }
      setDownloadHeaders(res, title, ext, 'video/mp4');
      const stream = fs.createReadStream(tmp);
      stream.on('error', () => { fs.unlink(tmp, () => {}); try { res.end(); } catch {} });
      stream.on('end', () => fs.unlink(tmp, () => {}));
      stream.pipe(res);
    });
    return;
  }

  // Single format: stream stdout straight to the client, nothing on disk.
  // Name it by the format's own extension (an audio-only save is .m4a/.mp3,
  // not .mp4).
  const rawFmt = (() => {
    const r = rawCacheGet(url);
    return r && Array.isArray(r.formats) ? r.formats.find((f) => f && String(f.format_id) === formatId) : null;
  })();
  const singleExt = rawFmt && rawFmt.ext ? String(rawFmt.ext).toLowerCase() : 'mp4';
  const singleType = singleExt === 'mp3' ? 'audio/mpeg' : singleExt === 'm4a' ? 'audio/mp4' : singleExt === 'webm' ? 'video/webm' : 'video/mp4';
  const args = ['-f', formatId, '--no-playlist', '--no-warnings',
    '--socket-timeout', '15', ...(rawClientGet(url) || ytdlpExtraArgs(url)), ...saveProxyArgs, ...cookieArgs(url), '-o', '-', url];
  const child = spawn(YTDLP, args, { timeout: 900000 });
  let sent = false;
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
  child.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
  });
  // Headers go out only with the first real byte of output. Sending them
  // on spawn meant a bad/stale quality choice came back as an empty file
  // with a 200 status instead of an error. Termination lives in 'close'
  // only: ending the response on stdout 'end' would commit a 200 before
  // the exit code is known.
  child.stdout.on('data', (chunk) => {
    if (!sent) {
      setDownloadHeaders(res, title, singleExt, singleType);
      sent = true;
    }
    if (!res.write(chunk)) child.stdout.pause();
  });
  res.on('drain', () => child.stdout.resume());
  child.on('close', (code) => {
    if (code === 0) {
      if (sent) { try { res.end(); } catch {} }
      else if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      return;
    }
    console.error('save exited non-zero:', code, scrub(stderr.slice(-500)));
    if (!sent && !res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    else if (sent) { try { res.end(); } catch {} }
  });
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Save Video listening on port ' + PORT));
