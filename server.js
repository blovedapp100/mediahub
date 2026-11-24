// MediaHub server — paste a link, preview the clip, pick a quality, save it.
// No visitor data is stored. URLs are never written to logs.
// Info responses are cached in memory (10 min, keyed by a hash of the link).
const express = require('express');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
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
];

function hostAllowed(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return ALLOWED_HOSTS.includes(h) || ALLOWED_HOSTS.some((d) => h.endsWith('.' + d));
  } catch { return false; }
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
async function proxyArgs(url, allowProxy = true) {
  if (!allowProxy) return [];
  if (!isYouTube(url) && !isTikTok(url)) return [];
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
// Everything else: plain + iPhone user-agent, 20s, direct only.
// Returns { info, clientArgs, viaProxy } — clientArgs are the yt-dlp
// extra args of the client that produced this info (null for mirrors),
// so /api/save can download with the same client AND the same egress:
// a format from tv_embedded does not exist for the android client, and
// a save with the wrong client fails.
async function ytdlpInfoWithFallbacks(url) {
  const wrapErr = (e) => {
    const err = new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
    err.detail = (e && e.errors && e.errors.map((x) => x && x.detail).filter(Boolean).join(' | ')) || '';
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
    for (const round of [{ allowProxy: false, timeout: 8000 }, { allowProxy: true, timeout: 12000 }]) {
      const mirror = withTimeout(mirrorInfo(url).then((info) => {
        if (!info) throw new Error('mirror empty');
        return { info, clientArgs: null };
      }), round.timeout, 'mirror timeout');
      const settled = await Promise.allSettled([
        ...clients.map((args) => tag(ytdlpJson(url, round.timeout, args, round.allowProxy), args)),
        mirror,
      ]);
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
    }
    const err = new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
    err.detail = lastDetail;
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
  const rounds = isTikTok(url)
    ? [{ allowProxy: false, timeout: 8000 }, { allowProxy: true, timeout: 12000 }]
    : [{ allowProxy: false, timeout: 20000 }];
  let lastErr = null;
  for (const round of rounds) {
    try {
      const res = await Promise.any(attempts.map((args) => tag(ytdlpJson(url, round.timeout, args, round.allowProxy), args)));
      res.viaProxy = round.allowProxy;
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw wrapErr(lastErr);
}

// ---- fast preview metadata (~1-2s) -----------------------------------------
// Title / thumbnail / author without waiting for the full format extraction.
// YouTube: public oEmbed endpoint. TikTok: tikwm API. Anything else: the
// page's og: tags. Returns null fast when nothing answers — the caller then
// just waits for /api/info.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function ogTag(html, prop) {
  const i = html.indexOf('property="' + prop + '"');
  if (i < 0) return '';
  const seg = html.slice(i, i + 600);
  const m = seg.match(/content="([^"]+)"/) || seg.match(/content='([^']+)'/);
  return m ? m[1] : '';
}

async function fastMeta(url) {
  const cached = cacheGet('meta:' + url);
  if (cached) return cached;
  let out = null;
  if (isYouTube(url)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json',
        { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timer);
      const j = await r.json();
      if (j && j.title) out = { title: decodeEntities(j.title), thumbnail: j.thumbnail_url || '', uploader: j.author_name || '', duration: 0 };
    } catch {}
  }
  if (!out && isTikTok(url)) {
    try {
      const t = await tikwmInfo(url, 2500);
      if (t) out = { title: t.title, thumbnail: t.thumbnail, uploader: t.uploader, duration: t.duration || 0 };
    } catch {}
  }
  if (!out) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(url, {
        signal: ctrl.signal, redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timer);
      const html = await r.text();
      const title = decodeEntities(ogTag(html, 'og:title'));
      const img = ogTag(html, 'og:image');
      if (title || img) out = { title: title || 'Video', thumbnail: img, uploader: ogTag(html, 'og:site_name') || '', duration: 0 };
    } catch {}
  }
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

// Best playable stream for the in-page preview player: prefer a
// progressive (video+audio) format, highest first; else any video stream.
function previewUrl(info) {
  const list = Array.isArray(info.formats) ? info.formats : [];
  const prog = list
    .filter((f) => f && f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (prog) return prog.url;
  const any = list.filter((f) => f && f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  return any ? any.url : '';
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

// ---- SEO: per-platform landing pages --------------------------------------
// Visible brand stays neutral ("MediaHub"). Keywords live in the <title>,
// meta description, URL slug, intro text and FAQ — never in the logo or
// the hero heading.
const PLATFORMS = {
  youtube: {
    name: 'YouTube',
    keyword: 'YouTube video downloader',
    title: 'YouTube Video Downloader — Save YouTube Videos in HD | MediaHub',
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
    title: 'TikTok Video Downloader — Save TikTok Videos Without Watermark | MediaHub',
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
  facebook: {
    name: 'Facebook',
    keyword: 'Facebook video downloader',
    title: 'Facebook Video Downloader — Save Facebook Videos & Reels in HD | MediaHub',
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
    title: 'Instagram Video Downloader — Save Instagram Reels & Videos in HD | MediaHub',
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
    title: 'Twitter Video Downloader — Save X Videos in HD | MediaHub',
    description: 'Twitter video downloader: paste an X (Twitter) video link, preview it and save it in HD with sound. Free, no account, works on phone and PC.',
    h1: 'X videos in every quality',
    intro: 'A free Twitter video downloader for X videos: paste the post link, preview the clip, and save it in HD with sound. No account needed.',
    example: 'https://x.com/',
    faq: [
      ['Is the Twitter video downloader free?', 'Yes — free, with no account and nothing to install.'],
      ['What qualities are available?', 'X videos are usually offered in HD and lower qualities with sound, plus an audio-only option.'],
      ['Do I need an X account?', 'No. Only the public post link is needed.'],
      ['Does it work on my phone?', 'Yes — it works in any modern mobile browser on Android and iPhone.'],
      ['Can I save private X videos?', 'No. Only public posts can be read.'],
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
  const base = req.protocol + '://' + req.get('host');
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
// the MediaHub origins — visitors' cookies are never involved.
app.post('/api/cookies', rateLimit(10, 60000), (req, res) => {
  const secret = process.env.COOKIE_SYNC_SECRET;
  if (!secret) return res.status(503).json({ error: 'Cookie sync is not configured on this server.' });
  const provided = String(req.headers['x-mediahub-secret'] || '');
  let ok = false;
  if (provided.length === secret.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret)); } catch { ok = false; }
  }
  if (!ok) return res.status(401).json({ error: 'Unauthorized.' });
  const platform = req.body && req.body.platform;
  const cookies = req.body && req.body.cookies;
  if (!COOKIE_PLATFORMS.includes(platform) || typeof cookies !== 'string') {
    return res.status(400).json({ error: 'Expected {platform, cookies}.' });
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
});

app.get('/robots.txt', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: ' + base + '/sitemap.xml\n');
});

app.get('/sitemap.xml', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  const urls = ['', ...Object.keys(PLATFORMS)].map((p) =>
    '  <url><loc>' + base + '/' + p + '</loc><changefreq>weekly</changefreq><priority>' + (p === '' ? '1.0' : '0.8') + '</priority></url>');
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>');
});

app.get('/:platform(youtube|tiktok|facebook|instagram|twitter)', (req, res) => {
  res.type('text/html').send(renderLanding(req.params.platform, req));
});

app.post('/api/meta', rateLimit(30, 60000), async (req, res) => {
  const url = String(req.body && req.body.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url) || !hostAllowed(url)) {
    return res.status(400).json({ error: 'Please paste a valid video link.' });
  }
  const meta = await fastMeta(url);
  if (!meta) return res.status(404).json({ error: 'No preview available yet.' });
  return res.json(meta);
});

app.post('/api/info', rateLimit(30, 60000), async (req, res) => {
  const url = String(req.body && req.body.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url) || !hostAllowed(url)) {
    return res.status(400).json({ error: 'Please paste a valid video link from TikTok, Facebook, Instagram, YouTube, X, Reddit, Vimeo or Dailymotion.' });
  }
  const cached = cacheGet(url);
  if (cached) return res.json(cached);
  try {
    let result = null;
    if (isTikTok(url)) {
      result = await tikwmInfo(url, 6000);
      // fall through to yt-dlp when tikwm has nothing
    }
    if (!result) {
      let info = null;
      try {
        const res = await ytdlpInfoWithFallbacks(url);
        info = res.info;
        rawClientSet(url, res.clientArgs);
        rawProxySet(url, res.viaProxy);
      } catch (e) {
        info = null;
        console.error('info failed:', platformOf(url), scrub(e.detail || e.message));
      }
      if (!info) throw new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
      rawCacheSet(url, info);
      const formats = buildFormats(info, { noSeparateAudio: isTikTok(url) });
      if (!formats.length) return res.status(404).json({ error: 'No playable versions were found for this link.' });
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
    cacheSet(url, result);
    return res.json(result);
  } catch (e) {
    console.error('info failed:', scrub(e.message));
    return res.status(502).json({ error: e.message || 'Could not read this link. Please try another one.' });
  }
});

app.get('/api/save', rateLimit(10, 60000), async (req, res) => {
  const url = String(req.query.url || '').trim();
  const formatId = String(req.query.formatId || '').trim();
  const title = safeTitle(req.query.t || req.query.title || 'video');
  if (!url || !/^https?:\/\//i.test(url) || !hostAllowed(url)) {
    return res.status(400).json({ error: 'Invalid link.' });
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

app.listen(PORT, () => console.log('MediaHub listening on port ' + PORT));
