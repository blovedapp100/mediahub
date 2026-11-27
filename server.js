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
// ---- visit counter (real views only) --------------------------------------
// Lightweight, in-memory page-view counter for the 6-hourly views report.
// Counts ONLY real, authentic browser visits to the homepage (GET /) and
// landing pages (GET /<platform-slug>). DROPPED (never counted):
//  - bot/crawler/headless/keep-alive user-agents, API routes, /api/stats
//    itself, /sitemap.xml, /robots.txt, static assets, non-GET requests;
//  - REPEAT views: the same visitor (IP + browser) counts at most ONCE per
//    30 minutes, so bar-bar refresh, an idle tab auto-reloading, or a
//    reload loop can never inflate the number;
//  - INACTIVITY reloads are covered by the same 30-minute window.
// Privacy: the visitor is identified only by a SHA-256 hash of (IP + UA);
// the raw IP is never stored or logged. No cookies, no personal data, no
// I/O per request. LIMIT: counts live only in memory - a Render restart
// resets them. The 6-hourly views cron keeps the persistent total in its
// own log, so a reset loses at most the views since the last cron read.
// Honest limit: a determined person can still fake a view (new IP / new
// browser), but casual refresh spam and bots are dropped.
const VISIT_DEDUP_MS = 30 * 60 * 1000; // 30 minutes per visitor
const VISIT_SEEN = new Map(); // visitor hash -> last counted timestamp (ms)
function clientIp(req) {
  // Render sits behind a proxy and there is no `trust proxy` setting, so
  // req.ip is the proxy's IP (same for everyone). Render sets
  // x-forwarded-for with the real client IP first.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}
function visitorKey(req) {
  return crypto.createHash('sha256')
    .update(clientIp(req) + '|' + (req.headers['user-agent'] || ''))
    .digest('hex').slice(0, 16);
}
function pktDate() {
  // Asia/Karachi is UTC+5 all year (Pakistan has no daylight saving).
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}
const VISIT_STATS = { date: pktDate(), today: 0, total: 0 };
function statsRollover() {
  const d = pktDate();
  if (d !== VISIT_STATS.date) { VISIT_STATS.date = d; VISIT_STATS.today = 0; }
}
// User-agents that are never a real visitor: search-engine and social
// crawlers, headless/automation tools, HTTP libraries, uptime monitors.
const BOT_UA = /bot|crawl|spider|slurp|headless|puppeteer|playwright|selenium|phantomjs|curl|wget|python|go-http|node-fetch|axios|httpclient|okhttp|pingdom|uptimerobot|statuscake|monitor|render|facebookexternalhit|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|googlebot|bingbot|duckduckbot|yandexbot|baiduspider|sogou|exabot|facebot|ia_archiver|semrush|ahrefs|mj12bot|petalbot|bytespider/i;
function isBotUA(ua) {
  return !ua || BOT_UA.test(ua);
}
function isPagePath(p) {
  if (p === '/') return true;
  if (p[0] !== '/' || p.indexOf('/', 1) !== -1) return false;
  return Object.prototype.hasOwnProperty.call(PLATFORMS, p.slice(1));
}
app.use((req, res, next) => {
  if (req.method === 'GET' && isPagePath(req.path) && !isBotUA(req.headers['user-agent'] || '')) {
    const now = Date.now();
    const key = visitorKey(req);
    const last = VISIT_SEEN.get(key) || 0;
    if (now - last >= VISIT_DEDUP_MS) {
      VISIT_SEEN.set(key, now);
      statsRollover();
      VISIT_STATS.today += 1;
      VISIT_STATS.total += 1;
    }
  }
  next();
});
setInterval(() => {
  const cutoff = Date.now() - VISIT_DEDUP_MS;
  for (const [key, t] of VISIT_SEEN) {
    if (t < cutoff) VISIT_SEEN.delete(key);
  }
}, 60000).unref();

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
  'streamable.com', 'www.streamable.com',
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
  // Sohu (added 2026-11-24): same rule — the server only reads a link's
  // INFO; the file is downloaded by the visitor's own browser. No login
  // anywhere (see the /api/info note on Sohu's per-video geo rule).
  'tv.sohu.com', 'www.tv.sohu.com',
  'kick.com', 'www.kick.com',
  // VK + OK.ru (step 15): the server only ever reads these links'
  // INFO via yt-dlp — the file itself is downloaded by the SERVER
  // through /api/save (IP-bound URLs), never by the visitor's browser.
  'vk.com', 'www.vk.com', 'vkvideo.ru', 'www.vkvideo.ru',
  'ok.ru', 'www.ok.ru',
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com',
  'mixcloud.com', 'www.mixcloud.com',
  'odysee.com', 'www.odysee.com',
  'bitchute.com', 'www.bitchute.com',
  'framatube.org', 'www.framatube.org',
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

function isFacebook(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'facebook.com' || h.endsWith('.facebook.com');
  } catch { return false; }
}

function isInstagram(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'instagram.com' || h.endsWith('.instagram.com');
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
  'kuaishou', 'haokan', 'pear', 'zhihu', 'sohu', 'vimeo', 'streamable',
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
    if (h === 'kuaishou.com' || h.endsWith('.kuaishou.com')) return 'kuaishou';
    if (h === 'kwai.com' || h.endsWith('.kwai.com')) return 'kwai';
    if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) return 'vimeo';
    if (h === 'streamable.com' || h.endsWith('.streamable.com')) return 'streamable';
    if (h === 'kick.com' || h.endsWith('.kick.com')) return 'kick';
    if (h === 'vk.com' || h.endsWith('.vk.com') || h === 'vkvideo.ru' || h.endsWith('.vkvideo.ru')) return 'vk';
    if (h === 'ok.ru' || h.endsWith('.ok.ru')) return 'ok';
    if (h === 'haokan.baidu.com' || h.endsWith('.haokan.baidu.com')) return 'haokan';
    if (h === 'pearvideo.com' || h.endsWith('.pearvideo.com')) return 'pear';
    if (h === 'zhihu.com' || h.endsWith('.zhihu.com')) return 'zhihu';
    if (h === 'tv.sohu.com' || h.endsWith('.tv.sohu.com')) return 'sohu';
    if (h === 'soundcloud.com' || h.endsWith('.soundcloud.com')) return 'soundcloud';
    if (h === 'mixcloud.com' || h.endsWith('.mixcloud.com')) return 'mixcloud';
    if (h === 'odysee.com' || h.endsWith('.odysee.com')) return 'odysee';
    if (h === 'bitchute.com' || h.endsWith('.bitchute.com')) return 'bitchute';
    if (h === 'framatube.org' || h.endsWith('.framatube.org')) return 'peertube';
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

// ORIGINAL TITLE + NO DUPLICATE TITLE (2026-11-26, user rules): the
// downloaded file is named from the video's ORIGINAL title, and the
// title appears exactly once in the name — never repeated, and never
// the same generic name for two different videos.
// - dedupeTitle: collapse a title that repeats itself ("Title | Title",
//   "Title - Title", "Title Title") to one copy, and strip a trailing
//   media extension the platform left in the title ("Title.mp4") so the
//   filename does not become "Title.mp4.mp4". Only EXACT repeats are
//   collapsed — a caption that merely reuses a word or a hashtag
//   ("Black Photo Trend #BlackPhotoTrend") is left untouched.
// - isGenericTitle: a title that is not a video title at all — the
//   generic fallback ("video"), a bare platform/site name ("Twitch",
//   "TikTok", "Instagram" — every clip from that platform would share
//   the same filename), or a bare word like "Download"/"Watch".
// - isAuthorNameTitle: a display name followed only by (@handle) — a
//   profile/author name, not a video title (Bluesky's og:title is the
//   author's name; the post caption is the video's title). "Name
//   (@handle) on X" does NOT match (trailing words) and is kept.
// - videoShortId: a short id for the video, from its own URL (YouTube
//   v=, TikTok /video/<id>, IG shortcode, FB/X id, last path segment),
//   else the first 8 hex of the URL's SHA-256 — so two different
//   videos never share a filename when no real title exists.
const GENERIC_TITLES = new Set(['video', 'twitch', 'tiktok', 'instagram', 'facebook', 'youtube', 'x', 'twitter', 'pinterest', 'sharechat', 'moj', 'douyin', 'kuaishou', 'zhihu', 'sohu', 'bluesky', 'reddit', 'tumblr', 'dailymotion', 'vimeo', 'rumble', 'kick', 'vk', 'okru', 'soundcloud', 'likee', 'kwai', 'streamable', 'threads', 'linkedin', 'snapchat', 'tencent', 'haokan', 'pear', 'download', 'watch']);
function isGenericTitle(t) {
  // UNICODE-AWARE (2026-11-26): the old /[^a-z0-9]/ strip deleted
  // every non-Latin letter, so a real Bengali/Arabic/Chinese title
  // collapsed to '' and was rejected as generic — the file then saved
  // as "video.mp4" / "video-<id>.mp4" instead of the video's own
  // title. \p{L}\p{N} keeps letters and numbers in every script; a
  // title of only emoji/punctuation still collapses to '' (generic).
  const s = String(t || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return !s || GENERIC_TITLES.has(s);
}
function isAuthorNameTitle(t) {
  return /^\s*[^@\n]+?\(\s*@[^)\s]+\s*\)\s*$/.test(String(t || ''));
}
function dedupeTitle(t) {
  let s = String(t || '').trim();
  if (!s) return s;
  s = s.replace(/\.(mp4|mp3|m4a|webm|mov|mkv)\s*$/i, '').trim();
  const sep = '\\s*[·•|:;\\-–—]\\s*';
  const m = s.match(new RegExp('^(.+?)' + sep + '\\1$', 'i'));
  if (m) s = m[1].trim();
  else {
    const m2 = s.match(/^(.+?)\s+\1$/i);
    if (m2 && m2[1].trim().length >= 3) s = m2[1].trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}
function videoShortId(u) {
  try {
    const parsed = new URL(String(u || ''));
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') {
      const v = parsed.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v.slice(0, 11);
    }
    const segs = parsed.pathname.split('/').filter(Boolean);
    const skip = new Set(['video', 'videos', 'reel', 'reels', 'watch', 'shorts', 'status', 'statuses', 'pin', 'clip', 'clips', 'post', 'posts', 'p', 'tv', 'v', 'embed']);
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = decodeURIComponent(segs[i]).replace(/\.[a-z0-9]+$/i, '');
      if (/^[A-Za-z0-9_-]{5,32}$/.test(s) && !skip.has(s.toLowerCase())) return s;
    }
  } catch {}
  return crypto.createHash('sha256').update(String(u || '')).digest('hex').slice(0, 8);
}
// Filename title for /api/save: the frontend's `t` (its fileTitle) when
// it is a real video title; else the /api/info title cached for this
// link (the video's own title — /api/meta is 404 for most links, and
// the info title is third-party-relayed for TikTok/IG/YT-long but is
// still the platform's own title, not a third-party brand); else a
// generic name with the video's own short id, so two different videos
// never share "video.mp4".
function saveTitle(req, url) {
  const fromT = dedupeTitle(stripTitleCounts(req.query.t || req.query.title || ''));
  if (fromT && !isGenericTitle(fromT)) return safeTitle(fromT);
  try {
    const cached = rawCacheGet(url);
    const ct = cached && cached.title ? dedupeTitle(stripTitleCounts(cached.title)) : '';
    if (ct && !isGenericTitle(ct)) return safeTitle(ct);
  } catch {}
  return safeTitle('video-' + videoShortId(url));
}

// User-Agent for a title relay fetch: VK / OK.ru need a full Chrome UA
// (the bare UA gets a 400 — same rule as the chain save branch); every
// other host takes the plain UA.
function relayUa(formatId) {
  return (String(formatId || '').startsWith('vk-') || String(formatId || '').startsWith('ok-'))
    ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    : 'Mozilla/5.0';
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
  // TRUNCATE THE RAW TITLE, NEVER THE ENCODED FORM (2026-11-26):
  // slicing encodeURIComponent(raw) at 200 chars cut non-Latin
  // titles mid-triplet (a lone "%A" at the end) and lost most of the
  // title — the browser then fell back to "video.mp4". Slice the raw
  // title by code points (never splits a surrogate pair) and encode
  // the whole sliced title, so filename* is always complete and valid.
  const encoded = encodeURIComponent([...raw].slice(0, 80).join(''));
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

// PREVIEW RELAY headers (YT-long fix 2026-11-26): an inline <video>
// preview needs the file served as video, NOT as a download —
// Content-Disposition: attachment makes the browser refuse to play it
// inline. No Range support (the upstream proxies ignore Range, so a
// 206 would be a lie); the browser plays from the start, which is
// what a preview does.
function setPreviewHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-store');
}

// A Piped proxy video URL (proxy.piped.private.coffee/videoplayback).
// The googlevideo signature in it is bound to the proxy's own IP, and
// the proxy 403s every playback/download (measured 2026-11-26: 403
// from this VM and from a real browser) — the file plays/downloads
// for nobody. Never play it directly, never 302 to it, never relay
// it as if it were a file.
function isPipedProxyUrl(u) {
  return hostOfUrl(u).includes('piped');
}

// Progressive YouTube itag -> height, for mapping a dead mirror
// format (yt-<itag>) to the chain's YT-A file for the same quality
// (yd-<height>) when the mirror URL is a dead Piped proxy URL.
const YT_PROG_ITAG_HEIGHT = { 5: 240, 17: 144, 18: 360, 22: 720, 36: 240, 37: 1080, 38: 3072, 43: 360 };

// Hostname of a URL, '' when it is not a URL at all.
function hostOfUrl(u) {
  try { return new URL(String(u || '')).hostname.toLowerCase(); } catch { return ''; }
}

// A preview URL is UNPLAYABLE in a visitor's <video> element when its
// host (a) sends no CORS headers / blocks cross-origin reads, or (b)
// is signed for the server's egress IP. Measured 2026-11-26:
//   - ytdownloader.tech: CORP: same-origin, no ACAO, ignores Range,
//     Content-Disposition: attachment — black, silent, unplayable.
//   - *.googlevideo.com: signed for the server's IP — 403s from the
//     visitor's browser (the frontend already knew this: the YouTube
//     lazy-preview comment says googlevideo 403s/stalls on the phone).
// Playable hosts (choc proxy: ACAO: *, Accept-Ranges: bytes; TikTok
// CDN; Facebook/Instagram CDNs) need no relay.
function isUnplayablePreviewHost(u) {
  const h = hostOfUrl(u);
  // Piped proxy (2026-11-26): its videoplayback URL 403s globally
  // (IP-bound googlevideo signature) — never play it directly; the
  // same-origin relay is attached instead.
  return h === 'ytdownloader.tech' || h === 'googlevideo.com' || h.endsWith('.googlevideo.com') || h.includes('piped');
}

// Same-origin relay URL for a format whose direct URL is unplayable
// cross-origin. /api/save?preview=1 streams the file through the
// server with video headers (never a 302, never a download header).
// This is the PREVIEW only — the Save button keeps the cache-first
// 302 (the 302-vs-filename decision is unchanged).
function previewRelayUrl(url, formatId, title) {
  return '/api/save?url=' + encodeURIComponent(url) + '&formatId=' + encodeURIComponent(formatId) +
    '&t=' + encodeURIComponent(title || 'video') + '&preview=1';
}

// Attach previewStream to a GENERIC (buildFormats) result: when the
// preview URL's host is unplayable cross-origin (YT-A proxy /
// googlevideo), the frontend plays the same-origin relay instead.
// The relay uses the SMALLEST with-sound public format (usually itag
// 18, 360p) — NOT the preview URL's format, which is the HIGHEST
// with-sound quality (e.g. a 2160p60 merged pair): relaying that
// would ffmpeg-merge a ~200 MB file before the preview could start.
// A 360p preview starts in seconds and the player is small; the
// quality list still offers every higher quality for saving.
// Preference: a single (non-merged) with-sound format first (it
// streams directly, no ffmpeg), else the smallest merged pair.
// No-op when no with-sound format exists, or when the preview URL is
// already playable (choc proxy, TikTok/FB/IG CDNs).
function attachPreviewStream(result, url) {
  if (!result || !isYouTube(url) || !Array.isArray(result.formats)) return;
  if (!isUnplayablePreviewHost(result.previewUrl || '')) return;
  const heightOf = (f) => {
    const m = String(f.label || '').match(/(\d{3,4})p/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const withSound = result.formats.filter((f) => f && f.url && f.hasAudio && f.label !== 'Audio only');
  if (!withSound.length) return;
  const single = withSound.filter((f) => String(f.id || '').indexOf('+') === -1);
  const pool = single.length ? single : withSound;
  pool.sort((a, b) => heightOf(a) - heightOf(b));
  // YT-LONG FULL LIST (2026-11-26): with a full YT-A list the smallest
  // with-sound format is 144p — too blurry for a preview. Prefer the
  // smallest format at 360p or above (fast to start, watchable); fall
  // back to the smallest overall when nothing reaches 360p.
  const pick = pool.find((f) => heightOf(f) >= 360) || pool[0];
  if (!pick || !pick.id) return;
  result.previewStream = previewRelayUrl(url, pick.id, result.title);
}

// Stream a direct file URL straight to the client. Returns true when the
// download started, false when the URL did not answer — the caller then
// falls back to the yt-dlp save. Headers are only set after the fetch
// succeeds, so a failed attempt commits nothing. isPreview serves the
// file as inline video (preview relay) instead of a download.
async function streamThrough(res, streamUrl, title, ext, contentType, isPreview, ua) {
  const r = await fetch(streamUrl, { headers: { 'User-Agent': ua || 'Mozilla/5.0' } });
  if (!r.ok || !r.body) return false;
  // COLD-LINK FIX (2026-11-26): a stale/dead upstream URL can answer
  // with an error JSON (YT-A: {"error":"That quality is not
  // available…","available":[360]}) instead of a video file. Never
  // stream an error page as if it were the video — return false so
  // the caller falls through to a fresh resolve / a clear 502.
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('json') || ct.includes('text/html')) return false;
  if (isPreview) setPreviewHeaders(res, contentType);
  else setDownloadHeaders(res, title, ext, contentType);
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

// Progressive merged-pair save (1-SECOND START, 2026-11-25): two yt-dlp
// processes fetch the direct video/audio streams to stdout (proxyArgs
// carries the WARP proxy when the info came through it — the same egress
// that produced the info); ffmpeg muxes both into a fragmented MP4 on
// stdout, so the browser's download starts with the first muxed byte
// instead of after the whole file is downloaded + merged to disk
// (the old temp-file path: ~51s TTFB live for a 720p merge). Resolves
// true when the download was handled (streamed — even if it later
// errored mid-stream, the response is already committed by then),
// false when nothing was sent yet (the caller falls back to the
// temp-file merge). The visitor's download starts in ~1s of the streams
// flowing on a fast egress; on a throttled egress the first byte waits
// for the first video fragment (measured 11.4s on this VM's throttled
// googlevideo path — download-rate-bound, not code-bound).
async function tryStreamMerged(res, title, videoUrl, audioUrl, proxyArgs, isPreview) {
  return new Promise((resolve) => {
    let sent = false;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const yv = spawn(YTDLP, ['--no-playlist', '--no-warnings', '--socket-timeout', '15', ...proxyArgs, '-o', '-', videoUrl], { timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] });
    const ya = spawn(YTDLP, ['--no-playlist', '--no-warnings', '--socket-timeout', '15', ...proxyArgs, '-o', '-', audioUrl], { timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn(KICK_FFMPEG, ['-i', 'pipe:3', '-i', 'pipe:4', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
      { timeout: 900000, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let ffErr = '';
    ff.stderr.on('data', (d) => { if (ffErr.length < 2000) ffErr += d.toString(); });
    const killAll = () => { for (const c of [yv, ya, ff]) { try { c.kill('SIGKILL'); } catch {} } };
    const failBeforeSend = (why) => {
      if (sent) return;
      console.error('stream-merge failed before first byte:', scrub(why || ffErr.slice(-300)));
      killAll();
      done(false);
    };
    yv.on('error', () => failBeforeSend('video fetch failed to start'));
    ya.on('error', () => failBeforeSend('audio fetch failed to start'));
    ff.on('error', () => failBeforeSend('ffmpeg failed to start'));
    yv.stdout.pipe(ff.stdio[3]);
    ya.stdout.pipe(ff.stdio[4]);
    ff.stdout.on('data', (chunk) => {
      if (!sent) {
        if (isPreview) setPreviewHeaders(res, 'video/mp4');
        else setDownloadHeaders(res, title, 'mp4', 'video/mp4');
        sent = true;
      }
      if (!res.write(chunk)) ff.stdout.pause();
    });
    res.on('drain', () => { try { ff.stdout.resume(); } catch {} });
    res.on('close', () => { killAll(); done(true); });
    ff.on('close', (code) => {
      if (code === 0) {
        if (sent) { try { res.end(); } catch {} }
        done(sent);
        return;
      }
      console.error('stream-merge ffmpeg exited:', code, scrub(ffErr.slice(-300)));
      if (!sent) { killAll(); done(false); return; }
      try { res.end(); } catch {}
      done(true);
    });
  });
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

// ---- progressive TikTok merge store (2026-11-25) --------------------------
// The sync path returns the fast win at once (grace 0) so the first
// quality shows in ~3s — but the other resolver leg keeps running, and
// when it lands the UNION (Best + HD + SD + Audio) is stored here for
// up to 90s. The frontend polls GET /api/merge and swaps the fuller
// list in when it appears. Only public video info (title/thumbnail/
// formats) — the same kind of data the info cache holds, keyed by the
// pasted URL, never per-visitor. Signed URLs are minutes-fresh, so a
// 90s TTL is far inside their life.
const MERGE_TTL_MS = 90 * 1000;
const MERGE_MAX = 500;
const mergeStore = new Map(); // url -> { at, data }
function mergeStoreSet(url, data) {
  if (mergeStore.size >= MERGE_MAX) {
    const first = mergeStore.keys().next().value;
    if (first !== undefined) mergeStore.delete(first);
  }
  mergeStore.set(url, { at: Date.now(), data });
}
function mergeStoreGet(url) {
  const e = mergeStore.get(url);
  if (!e) return null;
  if (Date.now() - e.at > MERGE_TTL_MS) { mergeStore.delete(url); return null; }
  return e.data;
}
// Union of the two TikTok resolver answers: SSSTik's Best first, then
// tikwm's HD/SD/Audio (dedup by format id). Never invents a format —
// a row appears only when its lane actually returned it.
function mergeTikTokInfos(ssInfo, twInfo) {
  if (!ssInfo && !twInfo) return null;
  const base = ssInfo || twInfo;
  const seen = new Set();
  const formats = [];
  for (const info of [ssInfo, twInfo]) {
    for (const f of (info && info.formats) || []) {
      if (!f || !f.id || seen.has(f.id)) continue;
      seen.add(f.id);
      formats.push(f);
    }
  }
  if (!formats.length) return null;
  return {
    title: base.title || 'Video',
    thumbnail: base.thumbnail || '',
    duration: base.duration || 0,
    uploader: base.uploader || '',
    previewUrl: base.previewUrl || '',
    formats,
    // NO clientSide flag (2026-11-26): same reason as ssstikInfoFresh
    // — the flag routed saves around the server relay, losing the
    // original-title filename to the CDN's name.
    note: '',
  };
}

// Raw info (with direct stream URLs) for /api/save: the public result
// above drops the URLs, but a save can stream a direct URL instead of
// running yt-dlp a second time — which matters when yt-dlp only answers
// through one specific client on this IP.
const rawCache = new Map();
// Chain-lane answers (SSSTik, freeapi, ytChain) carry signed token URLs
// that live ~5 min — cache them only 4 min so /api/save can 302 at once
// while the token is still live. Own yt-dlp info uses the full INFO_TTL.
const CHAIN_CACHE_TTL_MS = 4 * 60 * 1000;
function rawCacheSet(url, info, ttlMs) {
  if (rawCache.size >= 200) {
    const first = rawCache.keys().next().value;
    if (first) rawCache.delete(first);
  }
  rawCache.set(cacheKey(url), { at: Date.now(), info, ttl: ttlMs || INFO_TTL });
}
function rawCacheGet(url) {
  const e = rawCache.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > (e.ttl || INFO_TTL)) { rawCache.delete(cacheKey(url)); return null; }
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

// ---- per-IP rate limit, one bucket per route (counts only, no URLs stored) --
// 2026-11-25 fix: the old code kept ONE shared `hits` map for every route, so
// a visitor's /api/meta + /api/info calls + job polls (20/min while a job runs)
// filled the same bucket that /api/save and POST /api/job check against a
// 10/min limit — pasting a few links and then hitting a slow one 429'd the
// job POST and the save even though those routes were barely used. Each route
// now has its own bucket; the limits themselves are unchanged.
const hitBuckets = new Map();
function rateLimit(bucket, max, windowMs) {
  if (!hitBuckets.has(bucket)) hitBuckets.set(bucket, new Map());
  const hits = hitBuckets.get(bucket);
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
  for (const hits of hitBuckets.values()) {
    for (const [ip, arr] of hits) {
      const kept = arr.filter((t) => now - t < 600000);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }
}, 60000).unref();

// ---- TikTok via the free tikwm API (primary), yt-dlp as fallback -----------

// Short-link resolution cache (2026-11-25): a short code always maps
// to the same canonical video URL, so the 301 resolve (~1.3s) is paid
// once per short link, not on every paste — repeat pastes (retries
// after a 502, the same viral link pasted again) skip it entirely.
// Only SUCCESSFUL resolves are cached (the canonical /video/ URL); a
// failed resolve returns the original URL uncached, so a transient
// failure retries next time instead of sticking for 24h. Bounded
// (2,000 entries, 24h TTL) so a long-lived process cannot grow
// without limit.
const SHORT_RESOLVE_CACHE = new Map(); // shortUrl -> { value, at }
const SHORT_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const SHORT_RESOLVE_MAX = 2000;
function shortResolveCacheGet(url) {
  const hit = SHORT_RESOLVE_CACHE.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > SHORT_RESOLVE_TTL_MS) { SHORT_RESOLVE_CACHE.delete(url); return null; }
  return hit.value;
}
function shortResolveCacheSet(url, value) {
  if (SHORT_RESOLVE_CACHE.size >= SHORT_RESOLVE_MAX) {
    const oldest = SHORT_RESOLVE_CACHE.keys().next().value;
    if (oldest !== undefined) SHORT_RESOLVE_CACHE.delete(oldest);
  }
  SHORT_RESOLVE_CACHE.set(url, { value, at: Date.now() });
}

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
    const cached = shortResolveCacheGet(url);
    if (cached) return cached;
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
        if (abs.includes('/video/')) { shortResolveCacheSet(url, abs); return abs; }
        current = abs;
      } catch { return url; } finally { clearTimeout(timer); }
    }
    return url;
  } catch { return url; }
}

// tikwmInfoDetailed also returns tikwm's own status code: 0 means the
// video resolved, -1 means tikwm answered but cannot parse this URL at
// all ("Url parsing is failed" — no video data behind it), null means
// tikwm never answered (network error / timeout / non-JSON reply).
// NOTE on timing: tikwm's -1 answers take 13-20s (measured 2026-11-24),
// while the /api/info race caps the tikwm call at 8s — so in the live
// server flow a no-stream video usually shows up as code null
// (aborted), not -1.
// The -1 is still recorded (and logged) as the definitive form; the
// no-stream verdict below does NOT require it, because the yt-dlp leg
// ("No video formats found") is what makes the verdict safe — see the
// no-stream comment in /api/info.
async function tikwmInfoDetailed(url, timeoutMs = 12000) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Rate limit is 1 req/s: a first call can answer code -1 ("Free Api
    // Limit"). Wait 2.5s and retry once inside the same timeout.
    let j = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        j = await r.json();
      } catch { return { info: null, code: null }; }
      if (j && j.code === -1 && attempt === 0) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
      break;
    }
    if (j && j.code === 0 && j.data && j.data.play) {
      const d = j.data;
      const formats = [];
      if (d.hdplay) formats.push({ id: 'tt-hd', label: 'HD', ext: 'mp4', hasAudio: true, filesize: 0, note: 'Best quality', url: d.hdplay });
      formats.push({ id: 'tt-sd', label: 'SD', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: d.play });
      if (d.music) formats.push({ id: 'tt-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only', url: d.music });
      return {
        info: {
          title: d.title || ('TikTok video by ' + (d.author && d.author.nickname ? d.author.nickname : 'unknown')),
          thumbnail: d.cover || '',
          duration: d.duration || 0,
          uploader: (d.author && d.author.nickname) || '',
          previewUrl: d.hdplay || d.play || '',
          formats,
        },
        code: 0,
      };
    }
    return { info: null, code: (j && typeof j.code === 'number') ? j.code : null };
  } catch { return { info: null, code: null }; } finally { clearTimeout(timer); }
}

async function tikwmInfo(url, timeoutMs = 12000) {
  return (await tikwmInfoDetailed(url, timeoutMs)).info;
}

async function tikwmStreamUrl(url, kind) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    // Same 1 req/s rate limit as tikwmInfo: retry once after 2.5s.
    let j = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        j = await r.json();
      } catch { return null; }
      if (j && j.code === -1 && attempt === 0) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
      break;
    }
    if (!j || j.code !== 0 || !j.data) return null;
    if (kind === 'tt-hd') return j.data.hdplay || j.data.play || null;
    if (kind === 'tt-sd') return j.data.play || null;
    if (kind === 'tt-audio') return j.data.music || null;
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- Fallback resolver chains (step 10, own-first build) -----------------
// Verified 2026-11-24 by the social-fallbacks prober (PROBE.md in
// own-first/social-fallbacks/): every lane below returned a REAL file,
// downloaded and ffprobe-checked. A lane that only resolves a URL is
// NOT in this file — resolving is not proof.
//
// ORDER (standing rule): these run ONLY after our own extraction has
// failed on THIS link (per-link fallback, never per-platform). The
// chains are budget-aware: each lane gets min(its ideal timeout, the
// time left inside the 25s /api/info cap), and a lane is skipped when
// under 2.5s remain. Chain order inside each platform is fastest
// first, so one slow lane cannot burn the budget (this differs from
// the prober's suggested order in two places — curl-x is last on X and
// Facebook because its 22-28s resolve would starve every lane after
// it; SaveReelsFast is capped at 50/day/IP, so it is never first).
//
// INVISIBILITY: format ids are neutral (fa-/fx-/vx-/cx-/sr-/xc-/ip-)
// — no resolver or service name reaches the visitor. All calls are
// server-side; no chain hostname appears in client code or UI.

async function fetchJsonHeaders(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function postJsonTimeout(url, body, timeoutMs, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(extraHeaders || {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// freeapi.pro — one endpoint serves TikTok / X / Facebook / Instagram.
// TikTok: videoUrl only, no qualities (same file as tikwm play,
// md5-identical, 10.8s resolve). X: qualities 1280x720 / 640x360 /
// 320x180 via an acxcdn proxy. Facebook: SD 360p only, and ONLY with
// the www.facebook.com host (web.facebook.com returns 400
// "Unsupported platform") — the URL is normalised below. Instagram:
// videoUrl via a rapidcdn proxy (slow, 19-37s downloads).
async function freeapiInfo(url, timeoutMs = 11000) {
  const u = url.replace(/^https:\/\/web\.facebook\.com\//, 'https://www.facebook.com/');
  const j = await fetchJsonTimeout('https://freeapi.pro/api/alldl?url=' + encodeURIComponent(u), timeoutMs);
  if (!j || !j.success || !j.mediaInfo || !j.mediaInfo.videoUrl) return null;
  const mi = j.mediaInfo;
  const formats = [];
  if (Array.isArray(mi.qualities) && mi.qualities.length) {
    for (const q of mi.qualities) {
      if (!q || !q.url) continue;
      const m = String(q.quality || '').match(/(\d+)\s*x\s*(\d+)/);
      const h = m ? m[2] : heightOf(q.quality);
      formats.push({ id: 'fa-' + (h || 'video'), label: String(q.quality || 'Video'), ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: q.url });
    }
  }
  if (!formats.length) formats.push({ id: 'fa-video', label: 'Video', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: mi.videoUrl });
  if (mi.audioUrl) formats.push({ id: 'fa-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only', url: mi.audioUrl });
  return {
    title: mi.title || '',
    thumbnail: mi.thumbnail || '',
    duration: Number(mi.duration) || 0,
    uploader: mi.author || '',
    previewUrl: mi.videoUrl || '',
    formats,
  };
}

// fxtwitter — X. Fastest X lane (2.04s measured). Returns the platform's
// own twimg mp4 variants (320x180 / 640x360 / 1280x720) — no proxy.
async function fxtwitterInfo(url, timeoutMs = 8000) {
  const m = url.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  // Do NOT use fetchJsonTimeout here: its bare 'Mozilla/5.0' UA gets a
  // 403 from api.fxtwitter.com (Cloudflare flags the bare token as a
  // bot signature). A full Chrome UA answers 200 — verified 2026-11-24
  // by direct test (bare UA 403, full Chrome UA 200, no UA 200).
  const j = await fetchJsonHeaders('https://api.fxtwitter.com/' + m[1] + '/status/' + m[2], timeoutMs,
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' });
  const media = j && j.tweet && j.tweet.media && Array.isArray(j.tweet.media.all)
    ? j.tweet.media.all.find((a) => a && a.type === 'video') : null;
  if (!media) return null;
  const mp4 = (media.formats || [])
    .filter((f) => f && f.container === 'mp4' && f.url)
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  if (!mp4.length) return null;
  const formats = mp4.map((f) => {
    const hm = String(f.url).match(/\/vid\/(\d+)x(\d+)\//);
    const h = hm ? hm[2] : '';
    return { id: 'fx-' + (h || Math.round((f.bitrate || 0) / 1000)), label: h ? h + 'p' : (Math.round((f.bitrate || 0) / 1000) + ' kbps'), ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: f.url };
  });
  return {
    title: (j.tweet.text || '').slice(0, 120),
    thumbnail: media.thumbnail_url || '',
    duration: media.duration || 0,
    uploader: (j.tweet.author && j.tweet.author.screen_name) || m[1],
    previewUrl: mp4[mp4.length - 1].url,
    formats,
  };
}

// vxtwitter — X. Same twimg file as fxtwitter, but UA-sensitive: a
// browser User-Agent gets a 403 Cloudflare challenge, a plain client
// UA answers 200. Never send a browser UA here.
async function vxtwitterInfo(url, timeoutMs = 10000) {
  const m = url.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const j = await fetchJsonHeaders('https://api.vxtwitter.com/' + m[1] + '/status/' + m[2], timeoutMs,
    { 'User-Agent': 'SaveVideo/1.0', Accept: 'application/json' });
  const urls = (j && Array.isArray(j.mediaURLs) && j.mediaURLs.length)
    ? j.mediaURLs
    : (j && Array.isArray(j.media_extended) ? j.media_extended.map((x) => x && x.url).filter(Boolean) : []);
  if (!urls.length) return null;
  return {
    title: (j.text || '').slice(0, 120),
    thumbnail: '',
    duration: 0,
    uploader: m[1],
    previewUrl: urls[0],
    formats: urls.map((u, i) => ({ id: 'vx-' + i, label: urls.length > 1 ? 'Video ' + (i + 1) : 'Video', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: u })),
  };
}

// curl-x — X / Facebook / Instagram. Slow resolver (12-28s); last in
// every chain, only on leftover budget. Single variant for IG.
async function curlxInfo(url, timeoutMs = 20000) {
  const j = await postJsonTimeout('https://www.curl-x.com/api/extract', { url }, timeoutMs);
  const media = j && Array.isArray(j.media)
    ? (j.media.find((mm) => mm && mm.type === 'video') || j.media[0]) : null;
  if (!media || !Array.isArray(media.variants) || !media.variants.length) return null;
  const formats = media.variants
    .filter((v) => v && v.url)
    .map((v, i) => ({ id: 'cx-' + i, label: v.width ? v.width + 'x' + v.height : 'Video', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: v.url }));
  if (!formats.length) return null;
  return {
    title: (j.text || '').slice(0, 120),
    thumbnail: media.thumbnailUrl || '',
    duration: 0,
    uploader: j.author || '',
    previewUrl: formats[formats.length - 1].url,
    formats,
  };
}

// SaveReelsFast — TikTok (audio only) / Facebook / X. Limit 50
// requests/day/IP, 20/minute — never first in a chain. TikTok
// video_url 403s from datacenter IPs (v16-webapp-prime CDN family),
// so for TikTok only the audio_url is exposed; FB/X video_url works.
async function srfInfo(url, timeoutMs = 8000) {
  const j = await fetchJsonTimeout('https://www.savereelsfast.com/api/public/extract?url=' + encodeURIComponent(url), timeoutMs);
  if (!j || !j.success || !j.data) return null;
  const d = j.data;
  const formats = [];
  if (d.video_url && !isTikTok(url)) formats.push({ id: 'sr-video', label: d.quality || 'Video', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: d.video_url });
  if (d.audio_url) formats.push({ id: 'sr-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only', url: d.audio_url });
  if (!formats.length) return null;
  return {
    title: d.title || d.caption || '',
    thumbnail: d.thumbnail || '',
    duration: Number(d.duration) || 0,
    uploader: d.author || '',
    previewUrl: d.video_url || '',
    formats,
  };
}

// fb.xcasper.space — Facebook. Best FB lane: scrape-direct answers in
// ~3s with HD 720p + SD 360p direct fbcdn URLs. (scrape-best/art use
// a slow artplayer proxy, 31-37s downloads; scrape-snap times out —
// not used. The chain moves on to the next lane instead.)
async function xcasperFbInfo(url, timeoutMs = 8000) {
  const j = await fetchJsonTimeout('https://fb.xcasper.space/scrape-direct?url=' + encodeURIComponent(url), timeoutMs);
  if (!j || !j.success || !Array.isArray(j.links) || !j.links.length) return null;
  const formats = j.links
    .filter((l) => l && l.url)
    .map((l, i) => ({ id: 'xc-' + i, label: String(l.label || 'Quality ' + (i + 1)), ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: l.url }));
  if (!formats.length) return null;
  return {
    title: (j.title || '').slice(0, 120),
    thumbnail: '',
    duration: Number(j.duration) || 0,
    uploader: '',
    previewUrl: formats[0].url,
    formats,
  };
}

// instapdown — Instagram. Flaky at probe time: 502 {"ok":false,
// "code":"all_failed"} on 3 of 5 calls, 200 on 2 — any non-200 means
// "try the next lane now", never wait and retry. Verified on the NASA
// reel DTQXTbvjp4y (2,727,106 B) and natgeo reel DdG4RIxIPyf
// (17,220,854 B); the assigned task reel C-2QzQyXvYJ is deleted /
// private / login-walled (404 everywhere) and is NOT a usable test case.
async function instapdownInfo(url, timeoutMs = 20000) {
  const j = await postJsonTimeout('https://instapdown.com/api/download', { url, variant: 'reels' }, timeoutMs);
  if (!j || !j.ok || !Array.isArray(j.items) || !j.items.length) return null;
  const formats = j.items
    .filter((it) => it && it.url)
    .map((it, i) => ({ id: 'ip-' + i, label: it.kind === 'photo' ? 'Photo' : 'Video', ext: it.kind === 'photo' ? 'jpg' : 'mp4', hasAudio: true, filesize: 0, note: '', url: it.url }));
  if (!formats.length) return null;
  return {
    title: (j.caption || '').slice(0, 120),
    thumbnail: j.items[0].thumbnail || '',
    duration: 0,
    uploader: j.author || '',
    previewUrl: formats[0].url,
    formats,
  };
}

// Run chain lanes in order, each with min(its ideal timeout, the time
// left inside the 25s /api/info cap). A lane is skipped when under
// 2.5s remain. Returns the first result, or null.
async function runChain(lanes, budgetLeft) {
  for (const [fn, ideal] of lanes) {
    const left = budgetLeft();
    if (left < 2500) return null;
    const r = await fn(Math.min(ideal, left));
    if (r) return r;
  }
  return null;
}

async function xChain(url, budgetLeft) {
  return runChain([
    [(t) => fxtwitterInfo(url, t), 8000],
    [(t) => vxtwitterInfo(url, t), 10000],
    [(t) => srfInfo(url, t), 8000],
    [(t) => freeapiInfo(url, t), 12000],
    [(t) => curlxInfo(url, t), 20000],
  ], budgetLeft);
}

async function fbChain(url, budgetLeft) {
  const r = await runChain([
    [(t) => xcasperFbInfo(url, t), 8000],
    [(t) => srfInfo(url, t), 8000],
    // curl-x before freeapi (speed fix 2026-11-25, measured): curl-x
    // answers in 4.5-5.9s with 2 formats, freeapi times out 0/2 at
    // its 12s cap (~8.8s even with a 30s cap) — last on both platforms.
    [(t) => curlxInfo(url, t), 20000],
    [(t) => freeapiInfo(url, t), 12000],
  ], budgetLeft);
  if (!r) return null;
  // FACEBOOK (2026-11-25): most video files Facebook returns are
  // video-only (ffprobe-proven); the sound is a separate track the
  // chain surfaces as an audio row when it has one. The lanes assert
  // hasAudio:true on the video rows — correct that here so the site
  // never promises sound on a silent file. (The 'Audio only' rows keep
  // hasAudio:true — they are the sound.)
  // EXCEPTION (2026-11-26, ffprobe-proven on a live download):
  // xcasper's files DO carry real audio (HE-AAC stereo, mean -16.1 dB,
  // max -5.5 dB on the 5,202,168 B HD file) — never override those.
  for (const f of (r.formats || [])) {
    if (!f || f.ext !== 'mp4' || f.label === 'Audio only') continue;
    if (String(f.id || '').startsWith('xc-')) { f.hasAudio = true; f.note = 'With sound'; continue; }
    f.hasAudio = false; f.note = 'Video only';
  }
  return r;
}

async function igChain(url, budgetLeft) {
  return runChain([
    // curl-x FIRST (speed fix 2026-11-25, measured): 2.3-8.2s, the
    // fastest IG lane, 1 format + preview + thumbnail. instapdown
    // was first with a 5s cap that can never fire (raw answer 12.6s)
    // and burned 5s of budget on every lookup — now last with a 15s
    // cap so it can still answer when it recovers.
    [(t) => curlxInfo(url, t), 20000],
    [(t) => freeapiInfo(url, t), 15000],
    [(t) => instapdownInfo(url, t), 15000],
  ], budgetLeft);
}

// Chain fallback streams: re-run the lane that produced this format id
// and return its direct file URL. Id prefixes are neutral (no service
// names): fa- freeapi, fx- fxtwitter, vx- vxtwitter, cx- curl-x,
// sr- SaveReelsFast, xc- xcasper, ip- instapdown.
async function chainStreamUrl(url, formatId) {
  let info = null;
  if (formatId.startsWith('fa-')) info = await freeapiInfo(url, 15000);
  else if (formatId.startsWith('fx-')) info = await fxtwitterInfo(url, 10000);
  else if (formatId.startsWith('vx-')) info = await vxtwitterInfo(url, 12000);
  else if (formatId.startsWith('cx-')) info = await curlxInfo(url, 20000);
  else if (formatId.startsWith('sr-')) info = await srfInfo(url, 10000);
  else if (formatId.startsWith('xc-')) info = await xcasperFbInfo(url, 10000);
  else if (formatId.startsWith('ip-')) info = await instapdownInfo(url, 20000);
  // YouTube chain lanes (steps 11-13): re-run the lane that produced
  // the format id and pick the same id again. The resolve is
  // deterministic per video, so the same id comes back.
  else if (formatId.startsWith('yd-')) info = await ytdownloaderTech(url, 20000);
  else if (formatId.startsWith('ym-')) info = await y2mateEta(url, 20000);
  else if (formatId.startsWith('ch-')) info = await invidiousChocInfo(url, 18000);
  else if (formatId.startsWith('cb-')) info = await cobaltRue(url, 15000);
  // Kwai own lane (step 13): re-resolve the slide-0 mp4 fresh.
  else if (formatId.startsWith('kw-')) info = await kwaiInfo(url, 15000);
  // BitChute own lane (step 14): re-resolve the direct mp4 fresh.
  else if (formatId.startsWith('bc-')) info = await bitchuteInfo(url, 15000);
  // SoundCloud fallback MP3 (step 14): re-run the lane; the sc-mp3
  // format only exists when own yt-dlp failed at info time, so a
  // save-time own success means this id is gone -> null -> 502.
  else if (formatId === 'sc-mp3') info = await soundcloudInfo(url, 15000);
  // VK / OK.ru own lanes (step 15): IP-bound URLs — re-resolve fresh
  // via vkOkStreamUrl and return the file URL directly (the lane's
  // neutral ids do not match yt-dlp's raw format ids, so the
  // find-by-id below cannot resolve them).
  else if (formatId.startsWith('vk-') || formatId.startsWith('ok-')) return vkOkStreamUrl(url, formatId);
  if (!info) return null;
  const f = (info.formats || []).find((x) => x && x.id === formatId);
  return f ? f.url : null;
}

// ---- Fallback chains, part 2: YouTube + Western social (steps 11-13) -----
// Verified 2026-11-24 by the probers (PROBE.md in own-first/yt-fallbacks/,
// yt-fallbacks-b/ and social-west-fallbacks/): every lane below returned
// a REAL file, downloaded and ffprobe-checked. A lane that only resolves
// a URL is NOT here — resolving is not proof.
//
// ORDER (standing rule): these run ONLY after our own extraction has
// failed on THIS link (per-link fallback, never per-platform). The YT
// chain is budget-aware via runChain (each lane gets min(its ideal,
// the time left inside the 25s /api/info cap)). The Bluesky / Twitch /
// Tumblr lanes below are NOT third-party fallbacks — they are the
// platforms' OWN public no-login APIs, used as own-extraction lanes
// BEFORE yt-dlp (they answer faster and return the original file).
//
// YT CHAIN ORDER: ytdownloader.tech (fastest, 360p cap) -> y2mate/eta
// (best quality, merged mp4) -> Invidious choc proxy (adaptive-only,
// needs the /latest_version proxy — direct googlevideo URLs 403) ->
// cobalt rue (240p only, video-dependent). Piped private.coffee runs
// inside the mirror step before this chain (it is a Piped instance in
// the mirror list). The prober's recommended order is kept except the
// mirrors stay where they are (inside ytdlpInfoWithFallbacks).
//
// YT EXHAUSTIVE COUNTS (two probes, 2026-11-24): 102 candidates (web
// search) + 106 (GitHub/instance lists) = 208; file-verified working:
// ytdownloader.tech, y2mate/eta, invidious choc, cobalt rue (+ piped
// private.coffee, flaky). Everything else failed, was key-gated, or
// was API-only. The chain is built on the working ones only.
//
// INVISIBILITY: format ids are neutral (yd-/ym-/ch-/cb-/bs-/tw-/tb-)
// — no resolver or service name reaches the visitor. All calls are
// server-side; no chain hostname appears in client code or UI.

async function fetchTextTimeout(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', ...(headers || {}) } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

// ytdownloader.tech — POST /api/resolve {url} -> the FULL list in one
// call: 8 merged mp4s (2160p down to 144p, all with sound) + m4a audio
// (itag 140, 128 kbps). Measured 2026-11-26: resolve ~1.5s (warm) to
// ~3.5s (fresh video), and ALL prepared views are ready with saveUrls
// — even for a video never resolved before. The old code took only
// j.video[0] (the highest format) and threw the rest away, so the
// first list was 1 format (yd-2160). Now the whole resolve response
// is used: each format's saveUrl comes from prepared.views
// ('video:<height>' / 'm4a:140'). A format whose view is not ready is
// prepared in parallel (same /api/prepare flow, bounded by the
// remaining budget); formats that never become ready are omitted and
// the caller marks the answer partial so the upgrade job can fill
// them in. 429s carry retry-after — a 429 just returns null here
// (postJsonTimeout returns null on !ok) and the chain moves on.
// No cookies, no login.
async function ytdownloaderTech(url, timeoutMs) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const H = { Referer: 'https://ytdownloader.tech/' };
  const j = await postJsonTimeout('https://ytdownloader.tech/api/resolve',
    { url: 'https://www.youtube.com/watch?v=' + vid }, Math.max(2000, Math.min(left(), 30000)), H);
  if (!j || !Array.isArray(j.video) || !j.video.length) return null;
  const views = (j.prepared && j.prepared.views) || {};
  const full = (saveUrl) => (saveUrl && saveUrl.startsWith('/')) ? 'https://ytdownloader.tech' + saveUrl : saveUrl;
  // Prepare one missing format (the flow the old code used for
  // video[0]): POST /api/prepare + poll ?job= until saveUrl. Returns
  // the saveUrl or null. Bounded by the shared deadline.
  const prepareOne = async (formatId, media) => {
    const p = await postJsonTimeout('https://ytdownloader.tech/api/prepare',
      { videoId: vid, formatId: String(formatId), media }, Math.max(2000, Math.min(left(), 30000)), H);
    if (!p || !p.job) return null;
    while (left() > 4000) {
      await new Promise((ok) => setTimeout(ok, 3000));
      if (left() < 3000) break;
      const q = await fetchJsonHeaders('https://ytdownloader.tech/api/prepare?job=' + encodeURIComponent(p.job),
        Math.max(2000, Math.min(left(), 30000)), { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ytdownloader.tech/', Accept: 'application/json' });
      if (q && q.saveUrl) return q.saveUrl;
      if (q && q.error) return null;
    }
    return null;
  };
  const formats = [];
  const missing = [];
  for (const v of j.video) {
    const h = parseInt(v.height, 10) || 0;
    const view = views['video:' + v.formatId];
    const saveUrl = view && view.status === 'ready' ? view.saveUrl : null;
    if (saveUrl) {
      formats.push({ id: 'yd-' + (h || v.formatId), label: h ? h + 'p' : 'Video', ext: 'mp4', hasAudio: true, filesize: v.sizeBytes || 0, note: 'With sound', url: full(saveUrl) });
    } else {
      missing.push({ kind: 'video', formatId: String(v.formatId), media: 'video', height: h, sizeBytes: v.sizeBytes || 0 });
    }
  }
  // Audio (m4a itag 140, 128 kbps) — its prepared view is 'm4a:140'.
  const audioView = views['m4a:140'];
  const audioUrl = audioView && audioView.status === 'ready' ? audioView.saveUrl : null;
  if (audioUrl) {
    formats.push({ id: 'yd-audio', label: 'Audio only', ext: 'm4a', hasAudio: true, filesize: 0, note: 'Sound only', url: full(audioUrl) });
  } else if (j.m4a && j.m4a.formatId) {
    missing.push({ kind: 'audio', formatId: String(j.m4a.formatId), media: 'm4a', height: 0, sizeBytes: 0 });
  }
  // Prepare the missing ones in parallel (bounded by the deadline).
  // The resolve usually returns everything ready, so this rarely runs.
  if (missing.length && left() > 5000) {
    const done = await Promise.all(missing.map(async (m) => {
      const saveUrl = await prepareOne(m.formatId, m.media);
      return saveUrl ? { ...m, saveUrl } : null;
    }));
    for (const pm of done) {
      if (!pm || !pm.saveUrl) continue;
      if (pm.kind === 'audio') {
        formats.push({ id: 'yd-audio', label: 'Audio only', ext: 'm4a', hasAudio: true, filesize: 0, note: 'Sound only', url: full(pm.saveUrl) });
      } else {
        formats.push({ id: 'yd-' + (pm.height || pm.formatId), label: pm.height ? pm.height + 'p' : 'Video', ext: 'mp4', hasAudio: true, filesize: pm.sizeBytes || 0, note: 'With sound', url: full(pm.saveUrl) });
      }
    }
  }
  if (!formats.length) return null;
  // Highest first (2160p down), audio last — the order the list shows.
  const hOf = (f) => { const m = String(f.label || '').match(/(\d{3,4})p/); return m ? parseInt(m[1], 10) : 0; };
  formats.sort((a, b) => ((b.label === 'Audio only') - (a.label === 'Audio only')) || (hOf(b) - hOf(a)));
  return { title: j.title || vid, formats };
}

// y2mate.gs via eta.etacloud.org — one merged mp4 at the best available
// quality (720p for the 8-min video, 240p for the zoo video which is its
// source max) + mp3. Multi-step flow: homepage public key (re-extracted
// at runtime on every run — it can rotate, NEVER hardcoded) -> auth ->
// init -> convert -> poll progressURL until progress == 3. Requires
// Referer/Origin https://y2mate.gs/ (auth 403s without them). Only the
// mp4 is offered here: the mp3 needs a second full flow, and the chain's
// job is video fallback.
async function y2mateEta(url, timeoutMs) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const H = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://y2mate.gs/', Origin: 'https://y2mate.gs/', Accept: 'application/json' };
  const home = await fetchTextTimeout('https://y2mate.gs/', Math.max(2000, Math.min(left(), 15000)),
    { Referer: 'https://y2mate.gs/', Accept: 'text/html' });
  if (!home) return null;
  const m = /decodeKey\('([^']+)'\)/.exec(home);
  if (!m) return null;
  let apiKey;
  try { apiKey = Buffer.from(m[1].split('').reverse().join(''), 'base64').toString(); } catch { return null; }
  if (!apiKey) return null;
  const auth = await fetchJsonHeaders(
    'https://eta.etacloud.org/api/v1/auth?api_key=' + encodeURIComponent(apiKey) + '&_=' + Date.now(),
    Math.max(2000, Math.min(left(), 15000)), H);
  if (!auth || auth.err || !auth.key) return null;
  const init = await fetchJsonHeaders(
    'https://eta.etacloud.org/api/v1/init?_=' + Date.now(),
    Math.max(2000, Math.min(left(), 15000)), { ...H, Authorization: 'Bearer ' + auth.key });
  if (!init || init.error || !init.convertURL) return null;
  let conv = await fetchJsonHeaders(
    init.convertURL + '&v=' + vid + '&f=mp4&_=' + Date.now(),
    Math.max(2000, Math.min(left(), 15000)), H);
  if (!conv || conv.error) return null;
  if (conv.redirect === 1 && conv.redirectURL) {
    conv = await fetchJsonHeaders(
      conv.redirectURL + '&v=' + vid + '&f=mp4&_=' + Date.now(),
      Math.max(2000, Math.min(left(), 15000)), H);
    if (!conv || conv.error) return null;
  }
  let dl = conv.downloadURL || null;
  while (!dl && left() > 4000 && conv.progressURL) {
    await new Promise((ok) => setTimeout(ok, 3000));
    if (left() < 3000) break;
    const p = await fetchJsonHeaders(conv.progressURL + '&_=' + Date.now(),
      Math.max(2000, Math.min(left(), 15000)), H);
    if (!p) break;
    conv = p;
    if (p.downloadURL) dl = p.downloadURL;
    if (conv.progress >= 3 && !dl) break;
  }
  if (!dl) return null;
  return {
    title: conv.title || vid,
    formats: [{ id: 'ym-video', label: 'Best quality', ext: 'mp4', url: dl }],
  };
}

// Invidious yt.chocolatemoo53.com — adaptive video+audio only (no merged
// progressive). Direct googlevideo URLs 403 from datacenter IPs (and the
// instance returns stale cached signatures), so formats use the instance
// proxy /latest_version?id&itag&local=true. Video itags are video-ONLY
// (note 'Video only'); audio is the best m4a (note 'Sound only'). The
// proxy is slow (~55s for 322 KB on the probe) — this lane is last
// before cobalt for that reason.
async function invidiousChocInfo(url, timeoutMs) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const j = await fetchJsonTimeout('https://yt.chocolatemoo53.com/api/v1/videos/' + vid, timeoutMs);
  if (!j || !Array.isArray(j.adaptiveFormats)) return null;
  const formats = [];
  let bestAudio = null;
  for (const f of (j.adaptiveFormats || [])) {
    if (!f || !f.itag) continue;
    const t = String(f.type || '');
    const isVid = t.startsWith('video/') || t === 'video';
    const isAud = t.startsWith('audio/') || t === 'audio';
    const cont = String(f.container || (t.includes('webm') ? 'webm' : 'mp4')).toLowerCase();
    const proxy = 'https://yt.chocolatemoo53.com/latest_version?id=' + vid + '&itag=' + f.itag + '&local=true';
    if (isVid && cont === 'mp4') {
      formats.push({
        id: 'ch-' + f.itag,
        label: f.qualityLabel || (f.height ? f.height + 'p' : 'Video'),
        ext: 'mp4', note: 'Video only', url: proxy,
      });
    } else if (isAud && (cont === 'mp4' || cont === 'm4a')) {
      // Bitrate is a STRING in the API response ("130875" < "50200"
      // lexicographically) — compare numerically or the lowest-bitrate
      // audio wins. (YT-long fix 2026-11-26: this picked itag 139
      // 50 kbps over itag 140 130 kbps.)
      if (!bestAudio || (Number(f.bitrate) || 0) > (Number(bestAudio.bitrate) || 0)) bestAudio = { itag: f.itag, bitrate: f.bitrate || 0 };
    }
  }
  if (bestAudio) {
    formats.push({
      id: 'ch-audio', label: 'Audio only', ext: 'm4a', note: 'Sound only',
      url: 'https://yt.chocolatemoo53.com/latest_version?id=' + vid + '&itag=' + bestAudio.itag + '&local=true',
    });
  }
  if (!formats.length) return null;
  return { title: j.title || vid, formats };
}

// Cobalt rue-cobalt.xenon.zone (v11 tunnel) — ONE file only: single 240p
// h264 muxed mp4, no quality choice. Video-dependent: the zoo video
// verified (742,286 B) but the 8-min video's tunnel downloaded 0 bytes
// twice — the /api/info call cannot detect that (it does not download
// the file), so this lane is strictly last resort. Re-probe weekly;
// the host can gain Turnstile or die without notice.
async function cobaltRue(url, timeoutMs) {
  const j = await postJsonTimeout('https://rue-cobalt.xenon.zone/',
    { url, videoQuality: '720', audioFormat: 'mp3', downloadMode: 'auto' }, timeoutMs);
  if (!j || (j.status !== 'tunnel' && j.status !== 'redirect') || !j.url) return null;
  return {
    title: String(j.filename || 'video').replace(/ \(\d+p.*$/, ''),
    formats: [{ id: 'cb-video', label: '240p', ext: 'mp4', url: j.url }],
  };
}

// ---- YouTube resolver chain: merge + preview helpers (YT-long fix) ----

// Merge several chain-lane answers into ONE info object: the union of
// every lane's formats, deduped by id. Chain formats carry no
// vcodec/acodec/height (only id/label/ext/url), so buildFormats would
// collapse them all into one "Best quality" row and pair them into
// merged ids chainStreamUrl cannot resolve — the union is returned
// as-is (like the old ytChain early return) and never goes through
// buildFormats.
function mergeChainAnswers(answers) {
  const seen = new Set();
  const formats = [];
  let title = '';
  for (const a of answers) {
    if (!a) continue;
    if (!title && a.title) title = a.title;
    for (const f of (Array.isArray(a.formats) ? a.formats : [])) {
      if (!f || !f.url || !f.id) continue;
      const id = String(f.id);
      if (seen.has(id)) continue;
      seen.add(id);
      formats.push(f);
    }
  }
  if (!formats.length) return null;
  return { title: title || 'Video', formats };
}

// Height of a chain format, from its label ("1080p60", "720p", "360p").
function chainFormatHeight(f) {
  const m = String((f && f.label) || '').match(/(\d{3,4})p/);
  return m ? parseInt(m[1], 10) : 0;
}

// Pick the preview format from a CHAIN answer: a progressive
// (with-sound) file first (YT-A yd-, y2mate ym-, cobalt cb-), else the
// highest video-only mp4 (choc). Chain formats carry no height field,
// so the label decides.
function chainPreviewFormat(formats) {
  const list = (Array.isArray(formats) ? formats : []).filter((f) => f && f.url);
  if (!list.length) return null;
  const prog = list
    .filter((f) => /^(yd|ym|cb)-/.test(String(f.id || '')))
    .sort((a, b) => chainFormatHeight(b) - chainFormatHeight(a))[0];
  if (prog) return prog;
  return list
    .filter((f) => String(f.ext || '').toLowerCase() === 'mp4')
    .sort((a, b) => chainFormatHeight(b) - chainFormatHeight(a))[0] || list[0];
}

// Set previewUrl (+ previewStream when the pick is unplayable
// cross-origin) on a chain answer body. The choc proxy URL is playable
// as-is (ACAO: *, Range); the YT-A proxy URL is not (CORP, no ACAO,
// no Range) so it gets the same-origin relay.
function attachChainPreview(body, url) {
  const pick = chainPreviewFormat(body.formats);
  if (!pick) { body.previewUrl = ''; return; }
  body.previewUrl = pick.url;
  if (isUnplayablePreviewHost(pick.url)) {
    body.previewStream = previewRelayUrl(url, pick.id, body.title);
  }
}

// A chain list is THIN when it has fewer than 8 formats or tops out
// below 720p (same bar as isLimitedList, but reading the label height
// chain formats carry). A thin chain answer is marked partial:true so
// the frontend still starts the silent upgrade job.
function chainListIsThin(formats) {
  const list = Array.isArray(formats) ? formats : [];
  if (list.length < 8) return true;
  let maxH = 0;
  for (const f of list) { const h = chainFormatHeight(f); if (h > maxH) maxH = h; }
  return maxH < 720;
}

async function ytChain(url, budgetLeft, ydPrefetch, chocPrefetch) {
  const vid = youtubeId(url);
  if (!vid) return null;
  // YT-LONG FIX (2026-11-26): the old code awaited ydPrefetch FIRST
  // and returned it immediately when non-null — even a THIN 1-format
  // answer — so the fuller choc list (already in hand) was discarded
  // and the job completed with the same single 360p format (verified
  // live 2026-11-26: job 0ef78cfe ready at ~100s with formats=1).
  // Await BOTH prefetches (they run in parallel since lookupInfo
  // started them) and the remaining lanes, then return the UNION —
  // the fullest saveable answer. y2mate/cobalt are dead right now
  // (auth null / HTTP 400, measured 2026-11-26), so the union is
  // choc (up to 1080p60 video-only + audio) + YT-A (360p with sound)
  // in practice; a recovered lane joins the union automatically.
  const answers = [];
  if (ydPrefetch) {
    try {
      const r = await withTimeout(ydPrefetch, Math.max(0, budgetLeft()), 'prefetch timeout');
      if (r) answers.push(r);
    } catch {}
  }
  if (chocPrefetch) {
    try {
      const r = await withTimeout(chocPrefetch, Math.max(0, budgetLeft()), 'prefetch timeout');
      if (r) answers.push(r);
    } catch {}
  }
  // Remaining lanes that were NOT prefetch-started (y2mate, cobalt —
  // both dead right now, they fail fast in ~2-5s). The fresh YT-A /
  // choc resolves are skipped when the prefetches already answered:
  // they are the same endpoints, so a fresh resolve would cost ~20s
  // for a duplicate. Only when BOTH prefetches came back empty is the
  // full chain retried (a prefetch can fail while a fresh call works
  // if the instance was briefly down).
  const rest = await runChain([
    [(t) => y2mateEta(url, t), 20000],
    [(t) => cobaltRue(url, t), 15000],
  ], budgetLeft);
  if (rest) answers.push(rest);
  if (!answers.length) {
    const retry = await runChain([
      [(t) => ytdownloaderTech(url, t), 20000],
      [(t) => invidiousChocInfo(url, t), 18000],
    ], budgetLeft);
    if (retry) answers.push(retry);
  }
  return mergeChainAnswers(answers);
}

// ---- Western social: platform's OWN public APIs as own lanes ----------

// Bluesky — AT Protocol public XRPC (no key). getPostThread gives the
// video blob CID + the author's DID; getBlob returns the original file
// (the endpoint 302s to the CDN — the browser follows it). One file
// only (the upload itself, 1080x1920 on the probe: 6,059,979 B). The
// HLS playlist is NOT offered: a .m3u8 is not a saveable video file.
// The getBlob URL is content-addressed (CID), not signed, so the
// result may be cached.
async function blueskyInfo(url, timeoutMs) {
  const m = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i);
  if (!m) return null;
  const handle = m[1];
  const rkey = m[2];
  const thread = await fetchJsonTimeout(
    'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=' +
    encodeURIComponent('at://' + handle + '/app.bsky.feed.post/' + rkey), timeoutMs);
  const post = thread && thread.thread && thread.thread.post;
  const embed = post && post.embed;
  if (!embed || !String(embed.$type || '').includes('video')) return null;
  const did = post.author && post.author.did;
  const cid = embed.cid;
  if (!did || !cid) return null;
  const title = (post.record && post.record.text ? String(post.record.text) : '').slice(0, 200);
  return {
    title: title || 'Bluesky video',
    formats: [{
      id: 'bs-original', label: 'Original', ext: 'mp4',
      url: 'https://bsky.social/xrpc/com.atproto.sync.getBlob?did=' + did + '&cid=' + cid,
    }],
  };
}

// Twitch clips — anonymous GQL (no key; the public client-id the
// anonymous Twitch website itself uses) + signed CloudFront mp4.
// Bare sourceURL 401s; the ?sig=&token= from playbackAccessToken makes
// it work. 1080/720/480/360 (720p 17,474,567 B, 1080p 43,989,736 B on
// the probe). Clips only — VODs are a different GQL shape and fall
// through to yt-dlp (and its VOD guard). No cache: signed URLs.
async function twitchClipInfo(url, timeoutMs) {
  const m = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const body = {
    query: 'query($slug:ID!){clip(slug:$slug){id title durationSeconds videoQualities{quality sourceURL} playbackAccessToken(params:{platform:"web",playerType:"site"}){value signature}}}',
    variables: { slug: m[1] },
  };
  const j = await postJsonTimeout('https://gql.twitch.tv/gql', body, timeoutMs,
    { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' });
  const clip = j && j.data && j.data.clip;
  if (!clip || !Array.isArray(clip.videoQualities) || !clip.videoQualities.length) return null;
  if ((clip.durationSeconds || 0) > 7200) return null; // not a clip
  const tok = clip.playbackAccessToken || {};
  if (!tok.value || !tok.signature) return null;
  const formats = clip.videoQualities.map((q) => ({
    id: 'tw-' + q.quality, label: q.quality + 'p', ext: 'mp4',
    url: q.sourceURL + '?sig=' + tok.signature + '&token=' + encodeURIComponent(tok.value),
  }));
  return { title: clip.title || '', formats };
}

// Tumblr — public api/read/json (no key). The canonical post page 403s
// from datacenter IPs but the read API answers 200 with the mp4 in the
// post's video-player embed (3,218,299 B, h264 480x852 on the probe).
// Only the _480 rendition was listed in the embed.
async function tumblrReadInfo(url, timeoutMs) {
  const m = url.match(/([a-z0-9-]+)\.tumblr\.com\/post\/(\d+)/i) || url.match(/tumblr\.com\/([^/]+)\/(\d+)/i);
  if (!m) return null;
  const text = await fetchTextTimeout('https://' + m[1] + '.tumblr.com/api/read/json?type=video&id=' + m[2], timeoutMs);
  if (!text) return null;
  let json;
  try { json = JSON.parse(text.replace(/^var tumblr_api_read = /, '').replace(/;\s*$/, '')); } catch { return null; }
  const post = json && json.posts && json.posts[0];
  if (!post) return null;
  const player = post['video-player'] || post['video-player-500'] || '';
  const src = String(player).match(/<source src="([^"]+\.mp4)"/);
  if (!src) return null;
  const caption = String(post['video-caption'] || '').replace(/<[^>]+>/g, '').slice(0, 200);
  return {
    title: caption || '',
    formats: [{ id: 'tb-video', label: 'Video', ext: 'mp4', url: src[1] }],
  };
}

// ---- Fallback chains, part 3: Chinese platforms (step 12) ---------------
// Verified 2026-11-24 by the prober (PROBE.md in
// own-first/social-cn-fallbacks/): every lane below returned a REAL
// file, downloaded and ffprobe-checked. A lane that only resolves a URL
// is NOT here — resolving is not proof.
//
// ORDER (standing rule): these run ONLY after our own extraction has
// failed on THIS link (per-link fallback, never per-platform). Each
// platform has exactly one chain lane here (its fastest verified one).
// No cache: the returned URLs are direct CDN links handed to the
// visitor promptly (Baidu auth_key URLs are signed and expire).
//
// NOT integrated (documented in REPORT.md §5.5, with reasons):
// - FreeApi for Douyin/Kuaishou: works, but resolves in ~32s — over
//   the 25s /api/info cap. It cannot run inside the current cap.
// - SaveZuno for Zhihu: works, but the download ONLY succeeds with the
//   job session cookie — the visitor's browser does not have it, so it
//   needs a server-save exception for Zhihu (future work).
// - Sohu / Reddit / Xigua / Xiaohongshu / iQIYI: NO working fallback
//   found at all (see the CN PROBE.md failed sections).
//
// INVISIBILITY: format ids are neutral (tx-/pr-/dy-/sn-/ks-) —
// platform abbreviations, never a resolver or service name. All calls
// are server-side; no chain hostname appears in client code or UI.

// Videofish backend — POST /api/resolve {platform, link} -> media[]
// with a direct CDN mp4. Verified slugs: tencent-video (119,041,583 B,
// 640x352, 1904s — title comes back weak, 'Media'), pearvideo
// (929,777 B, 406x720), douyin (6,588,975 B, 1280x720 — byte-identical
// to FreeApi's 720p file, but resolved in ~3s instead of ~32s).
// Other slugs fail on this endpoint (kuaishou 422 parse_failed,
// xiaohongshu 422, sohu/haokan/zhihu 400 unsupported, iqiyi 422,
// xigua 422) — this lane is only called with a verified slug.
async function videofishInfo(url, slug, timeoutMs) {
  const ids = { 'tencent-video': 'tx-video', pearvideo: 'pr-video', douyin: 'dy-video' };
  const id = ids[slug];
  if (!id) return null;
  const j = await postJsonTimeout('https://back.videofish.cc/api/resolve',
    { platform: slug, link: url }, timeoutMs);
  if (!j || !j.ok || !Array.isArray(j.media)) return null;
  const media = j.media.find((x) => x && x.type === 'video' && x.url);
  if (!media) return null;
  const title = (j.title && j.title !== 'Media') ? String(j.title) : 'Video';
  return {
    title,
    formats: [{ id, label: 'Video', ext: 'mp4', url: media.url }],
  };
}

// SnapVideoTools — POST /api/snap {"text": url} with the Referer of its
// Haokan page (the field name matters: {"url": ...} returns a system
// error). Verified on Haokan: 26,144,091 B, h264 1920x1080, 136.06s.
// The returned Baidu URL carries an auth_key (signed, expires) —
// resolve and hand it over promptly, never cache it. Other platforms
// on this endpoint fail (Xigua/Zhihu/iQIYI 'Video parsing failed',
// Sohu 'not supported') — Haokan only.
async function snapHaokan(url, timeoutMs) {
  const j = await postJsonTimeout('https://snapvideo-api.kalman03.com/api/snap',
    { text: url }, timeoutMs, { Referer: 'https://snapvideo-api.kalman03.com/haokan-downloader' });
  const data = j && j.data;
  if (!data || !Array.isArray(data.mediaUrls)) return null;
  const media = data.mediaUrls.find((x) => x && x.type === 'video' && x.suffix === 'mp4' && x.url);
  if (!media) return null;
  return {
    title: data.title || 'Video',
    formats: [{ id: 'sn-video', label: 'Video', ext: 'mp4', url: media.url }],
  };
}

// btch backend — GET /kuaishou?url= -> {success, videoUrl, title}.
// Verified on Kuaishou: 5,130,563 B, h264 720x1280, 12.10s —
// byte-identical to FreeApi's Kuaishou file, but fast (~1.5-4s).
// Douyin on this backend returns just {"status": true} (no video);
// rednote returns an empty shell — Kuaishou only.
async function btchKuaishou(url, timeoutMs) {
  const j = await fetchJsonHeaders(
    'https://backend1.tioo.eu.org/kuaishou?url=' + encodeURIComponent(url),
    timeoutMs, { 'User-Agent': 'btch/6.0.38', Accept: 'application/json' });
  if (!j || !j.success || !j.videoUrl) return null;
  return {
    title: j.title || 'Video',
    formats: [{ id: 'ks-video', label: 'Video', ext: 'mp4', url: j.videoUrl }],
  };
}

// ---- New own lanes, part 4: worldwide-A/B working platforms (step 13) --
// Verified 2026-11-24 by the probers (PROBE.md in own-first/worldwide-a/
// and worldwide-b/): every lane below returned a REAL file, downloaded
// and ffprobe-checked. These are the platforms' OWN pages/APIs, used as
// own-extraction lanes BEFORE yt-dlp (they answer faster and return the
// original file). No third-party resolver is involved.
//
// - Vimeo: player config API, direct progressive mp4s 240-1080p
//   (240p file 9,178,442 B verified). DRM-only videos have no progressive
//   formats -> return null, fall through to yt-dlp (which also refuses
//   them). Signed URLs: NO cache. Client-side (browser can fetch them).
//   FIX 2026-11-24 (scratch-vimeo): the step-13 slow path had TWO bugs
//   that made the test video 502 at 25.3s: (1) it called
//   ytdlpInfoWithFallbacks, which races TWO concurrent yt-dlp processes
//   (plain + iPhone UA) with 20s timeouts — measured 14.2s together on
//   this 1.5-CPU VM vs 9.2s for ONE process, and any slowdown tripped
//   the 17s lane cap; (2) it mapped formats from f.label / f.hasAudio,
//   but raw yt-dlp -J formats carry NEITHER field (both null) — so even
//   when yt-dlp succeeded, zero formats were mapped and the lane
//   returned null. The fix calls ytdlpJson ONCE (plain args, direct
//   egress, 15s) and reads the quality from format_id (http-240p …
//   http-1080p): the pixel-height field is the ultra-wide frame height
//   (86 for "240p"), NOT the label. Progressive http-* mp4s are
//   video+audio combined (verified file has aac sound).
// - Streamable: page HTML embeds direct signed mp4s 720p + 360p-mobile
//   (full 720p file 16,244,418 B verified). Signed URLs expire ~24h:
//   NO cache. Client-side.
// - Kwai: page HTML, slide-0 video player mp4 (full file 4,868,564 B
//   verified). The URL carries no visible IP binding, but cross-IP
//   playback was never proven, so Kwai is NOT client-side-only: the
//   visitor saves through /api/save (kw-video -> kwaiStreamUrl below),
//   which fetches from this server's IP. Signed URL: NO cache.
//   NOTE: kwai.com is NOT kuaishou.com — the two are different apps
//   (Kwai is Kuaishou's international brand) and have different lanes.
//   clientSideKey splits them (see build.py step 13).
//
// NOT integrated here (deferred, see REPORT.md §13): VK + OK.ru (own
// yt-dlp lanes verified, but their file URLs are IP-bound to the
// resolving server — they need server-save-only formats, a parent
// decision); Kick + Dailymotion (HLS-only — need server-side ffmpeg
// remux, a new capability); Rumble / Threads / Likee (no working route
// from plain server-side HTTP at probe time).
//
// INVISIBILITY: format ids are neutral (vm-/st-/kw-) — no resolver or
// service name reaches the visitor. All calls are server-side.

async function vimeoInfo(url, timeoutMs) {
  const m = url.match(/vimeo\.com\/(\d+)/i);
  if (!m) return null;
  const playerUrl = 'https://player.vimeo.com/video/' + m[1];
  // Fast path: player config API (200 for some videos, 403 "Sorry"
  // for others — per-video gating, measured 2026-11-24). The 403
  // arrives in ~1.5s and a 200 in ~2.6s, so a 4s cap never burns the
  // lane budget. Headers do not unblock it: a full browser UA gets
  // the same 403 (measured 2026-11-24).
  const cfg = await fetchJsonTimeout(playerUrl + '/config', Math.min(4000, timeoutMs));
  if (cfg) {
    const title = (cfg.video && cfg.video.title) || '';
    const prog = (cfg.request && cfg.request.files && cfg.request.files.progressive) || [];
    const formats = [];
    for (const p of prog) {
      if (!p || !p.url || !p.height) continue;
      formats.push({ id: 'vm-' + p.height + 'p', label: p.height + 'p', ext: 'mp4', hasAudio: true, filesize: 0, url: p.url });
    }
    if (formats.length) return { title, formats };
  }
  // Slow path: ONE plain yt-dlp call on the PLAYER url (the watch page
  // needs login; the player URL returns the progressive mp4s — verified
  // 2026-11-24: 240p file 9,178,442 B; single -J measured 9.2s).
  // Do NOT use ytdlpInfoWithFallbacks here (see header: two concurrent
  // processes, 14.2s measured, trips the lane cap). ytdlpJson's exec
  // timeout kills the child on expiry, so no orphan process lingers.
  // Budget: config took at most 4s above, so timeoutMs - 5000 leaves
  // the lane inside its budget (20s lane budget -> 15s for yt-dlp).
  const ytBudget = Math.max(5000, timeoutMs - 5000);
  let info;
  try {
    info = await ytdlpJson(playerUrl, ytBudget, [], false);
  } catch { return null; }
  const fmts = (info && info.formats) || [];
  const formats = [];
  for (const f of fmts) {
    if (!f || !f.url || f.ext !== 'mp4') continue;
    if (f.protocol && f.protocol !== 'https') continue; // skip HLS (m3u8_native)
    // Quality lives in format_id (http-240p … http-1080p). Raw -J
    // formats have no `label` and no `hasAudio` (both null), and the
    // pixel height is the ultra-wide frame height (86 for "240p") —
    // neither gives the label. Progressive http-* mp4s are
    // video+audio combined (verified file: h264 + aac).
    const hm = String(f.format_id || '').match(/^http-(\d+)p$/);
    if (!hm) continue;
    const id = 'vm-' + hm[1] + 'p';
    if (formats.some((x) => x.id === id)) continue;
    formats.push({ id, label: hm[1] + 'p', ext: 'mp4', hasAudio: true, filesize: 0, url: f.url });
  }
  if (!formats.length) return null;
  return { title: (info && info.title) || '', formats };
}

async function streamableInfo(url, timeoutMs) {
  const m = url.match(/streamable\.com\/(?:s\/|e\/)?([a-z0-9]+)/i);
  if (!m) return null;
  const html = await fetchTextTimeout('https://streamable.com/' + m[1], timeoutMs);
  if (!html) return null;
  // The page embeds the same URL three ways: raw `&`, HTML-escaped
  // `&amp;`, and JSON-escaped `\u0026` — normalise all three before
  // dedup, or the same file shows up twice.
  const urls = [...new Set([...html.matchAll(/https:\/\/cdn-cf-east\.streamable\.com\/video\/(mp4|mp4-mobile)\/[a-z0-9]+\.mp4\?[^"' ]+/gi)].map((x) => x[0].replace(/&amp;/g, '&').replace(/\\u0026/g, '&')))];
  if (!urls.length) return null;
  const title = ((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '').trim().replace(/\s*[|\-–—]\s*Streamable.*$/i, '') || ('Streamable video #' + m[1]);
  const seen = new Set();
  const formats = [];
  for (const u of urls) {
    const id = u.includes('mp4-mobile') ? 'st-360' : 'st-720';
    if (seen.has(id)) continue;
    seen.add(id);
    formats.push({ id, label: id === 'st-360' ? '360p' : '720p', ext: 'mp4', url: u });
  }
  return { title, formats };
}

async function kwaiInfo(url, timeoutMs) {
  const m = url.match(/k\.kwai\.com\/p\/([A-Za-z0-9]+)/)
    || url.match(/kwai\.com\/@[^/]+\/video\/(\d+)/)
    || url.match(/kwai\.com\/video\/(\d+)/);
  if (!m) return null;
  // fetch follows the k.kwai.com short-link 302 to the full video page.
  const html = await fetchTextTimeout(url, timeoutMs);
  if (!html) return null;
  // Target video is ALWAYS slide 0 — never take any other mp4 on the page.
  const src = (html.match(/<a-video-player[^>]*id="video-0"[^>]*src="([^"]+\.mp4[^"]*)"/)
    || html.match(/id="video-0"[^>]*src="([^"]+\.mp4[^"]*)"/) || [])[1];
  if (!src) return null;
  const title = ((html.match(/<title>([^<|]+)/) || [])[1] || '').trim();
  return { title, formats: [{ id: 'kw-video', label: 'Video', ext: 'mp4', url: src }] };
}

// /api/save resolver for kw-video: re-resolve fresh (the URL is signed)
// and return the file URL for the server to stream through.
async function kwaiStreamUrl(url) {
  const info = await kwaiInfo(url, 15000);
  if (!info) return null;
  const f = (info.formats || [])[0];
  return f ? f.url : null;
}

// ---- New own lanes, part 5: worldwide-C working platforms (step 14) --
// Verified 2026-11-24 by the prober (PROBE.md in own-first/worldwide-c/):
// every lane below returned a REAL file, downloaded and ffprobe-checked.
// These are the platforms' OWN pages/APIs (or their own yt-dlp
// extractors), used as own-extraction lanes BEFORE generic yt-dlp.
// No third-party resolver is involved in any own lane.
//
// - SoundCloud (audio-only): own yt-dlp (api-v2 HLS m4a 96k/160k;
//   211.9s file 4,275,624 B verified). Fallback INSIDE this lane only:
//   freeapi.pro /api/alldl -> direct MP3 (5,086,398 B verified) —
//   used ONLY when own yt-dlp returns nothing on THIS link
//   (own-first, per-link). DRM tracks return no formats -> null.
// - Mixcloud (audio-only): own yt-dlp. CAPPED at the 64k lane only:
//   the full 54-min mix at 64k took 20m02s to download from this VM
//   (~25 KiB/s); the 192k lane would be ~3x that, so it is NOT
//   offered. One format, mc-audio ("Audio 64k"). The yt-dlp info also
//   carries a direct progressive m4a URL (dl.mixcloud.com "secure"
//   path) — it is exposed as the format url so the visitor's browser
//   can try it first; the server save (yt-dlp -f hls-64) is the
//   fallback when the direct fetch fails. No third-party fallback
//   exists for Mixcloud.
// - Odysee (video): own LBRY resolve/get API (no key) -> streaming_url
//   -> HEAD with Referer follows the redirect to the tokenised
//   master.m3u8 -> variant playlists 144p/360p/720p (first 10s 144p
//   segment 190,632 B verified). The token is short-lived, so the
//   whole get->HEAD->playlist chain runs in ONE go, inside this
//   function, on every call (info AND save both re-resolve fresh).
//   The direct mp4 streaming URL is NOT used: it 401s without a
//   fresh token and 429s under repeat hits from this IP. Claims that
//   no longer resolve (NOT_FOUND) return null and fall through to
//   generic yt-dlp (its lbry extractor works on live claims).
// - BitChute (video): own public API POST api.bitchute.com/api/beta/
//   video/media -> media_url, a single direct mp4 (full 1196s file
//   124,478,566 B verified). yt-dlp's call to the same endpoint FAILS
//   from this VM (remote end closed connection) while plain fetch
//   works instantly — so this lane uses direct fetch, never yt-dlp.
//   Title comes from the page's og:title (page is ~8 KB).
// - PeerTube (video): own yt-dlp, any instance. This instance
//   (framatube.org) serves HLS playlists only — NO single-file mp4
//   URLs in the format list, despite the probe's "direct mp4" wording:
//   the verified 58,062,792 B file is yt-dlp downloading the HLS
//   360p variant and remuxing it. So the lane offers the HLS variants
//   (pt-<height>p) and the save goes through yt-dlp, exactly like the
//   other HLS lanes. Other instances that DO serve direct progressive
//   mp4s are offered with their direct URL when yt-dlp reports one.
//
// SAVE MODEL (why the ids are neutral AND the save works):
// HLS lanes (sc-/mc-/od-/pt-) carry NO playable file URL — the
// format url field is OMITTED on purpose (the frontend tries a direct
// download of any format url first; handing it a .m3u8 playlist would
// "save" a playlist file, not audio/video). The visitor's Save goes
// to /api/save, where worldcSaveSpec() re-runs the lane fresh and
// returns the yt-dlp invocation (sc-/mc-/pt-: -f <native format id>
// on the page URL; od-: yt-dlp on the fresh variant m3u8 URL).
// The native yt-dlp format id travels in the internal-only _ytid
// field (Odysee: _m3u8) — stripWorldcInternal() removes both before
// the result reaches the visitor. Direct-file lanes (bc-video,
// sc-mp3, Mixcloud's mc-audio direct URL) DO carry url and are
// saved by the chain branch (chainStreamUrl) like Kwai.
// Cache: NO cache for SoundCloud (fallback MP3 link may be signed /
// short-lived), Mixcloud (direct URL is a "secure" signed path),
// Odysee (short-lived token), BitChute (signed seed URL — Kwai
// precedent). PeerTube MAY cache (stable instance files, no token
// in the URL; HLS variants carry no url at all).
//
// INVISIBILITY: format ids are neutral (sc-/mc-/od-/bc-/pt-) — no
// resolver or service name reaches the visitor. All calls are
// server-side. Bilibili is NOT built here: metadata resolves but
// media is 403/567-blocked from this VM (datacenter-IP block on the
// upos CDN) — re-verify from Render before shipping any lane.

async function soundcloudInfo(url, timeoutMs) {
  if (!/soundcloud\.com\//i.test(url)) return null;
  // Own first: yt-dlp (api-v2 HLS). Bounded so the 25s /api/info cap
  // still leaves room for the fallback below.
  try {
    const res = await withTimeout(
      ytdlpInfoWithFallbacks(url),
      Math.max(5000, timeoutMs - 3000),
      'soundcloud yt-dlp timed out');
    const info = res && res.info;
    const fmts = (info && info.formats) || [];
    const audio = [];
    for (const f of fmts) {
      if (!f || !f.url) continue;
      const v = f.vcodec && f.vcodec !== 'none';
      const a = f.acodec && f.acodec !== 'none';
      if (v || !a) continue;
      const abr = Math.round(f.abr || 0);
      audio.push({
        id: abr ? 'sc-' + abr + 'k' : 'sc-audio',
        label: abr ? 'Audio ' + abr + 'k' : 'Audio',
        ext: (f.ext || 'm4a').toLowerCase(),
        hasAudio: true,
        filesize: f.filesize || f.filesize_approx || 0,
        note: 'Sound only',
        // NO url: this is an HLS manifest, not a file (see header).
        _ytid: String(f.format_id),
      });
    }
    if (audio.length) {
      audio.sort((x, y) => {
        const ax = parseInt(String(x.id).replace(/[^0-9]/g, ''), 10) || 0;
        const ay = parseInt(String(y.id).replace(/[^0-9]/g, ''), 10) || 0;
        return ay - ax;
      });
      if (res.clientArgs) rawClientSet(url, res.clientArgs);
      return {
        title: (info && info.title) || 'SoundCloud track',
        thumbnail: (info && info.thumbnail) || '',
        duration: (info && info.duration) || 0,
        uploader: (info && info.uploader) || (info && info.channel) || '',
        previewUrl: '',
        formats: audio,
      };
    }
    // Own returned nothing (DRM track, removed, geo) — fall through
    // to the fallback below, NOT to generic yt-dlp (it is the same
    // call and would fail identically).
  } catch { /* own failed — try the fallback below */ }
  // Fallback, ONLY when own returned nothing on THIS link: the
  // no-key HTTP lane -> one direct MP3 file (5,086,398 B verified
  // 2026-11-24). The MP3 IS a single file, so url is included.
  const j = await fetchJsonTimeout(
    'https://freeapi.pro/api/alldl?url=' + encodeURIComponent(url),
    Math.min(15000, timeoutMs));
  if (!j || !j.success || !j.mediaInfo || !j.mediaInfo.audioUrl) return null;
  const mi = j.mediaInfo;
  return {
    title: mi.title || 'SoundCloud track',
    thumbnail: mi.thumbnail || '',
    duration: Number(mi.duration) || 0,
    uploader: mi.author || '',
    previewUrl: '',
    formats: [{
      id: 'sc-mp3', label: 'Audio MP3', ext: 'mp3', hasAudio: true,
      filesize: 0, note: 'Sound only', url: mi.audioUrl,
    }],
  };
}

async function mixcloudInfo(url, timeoutMs) {
  if (!/mixcloud\.com\//i.test(url)) return null;
  // Own: yt-dlp. 64k ONLY — the 192k lane is ~3x the bytes and the
  // 64k full-mix download already took 20m02s from this VM. The
  // direct progressive m4a URL (when present) is exposed as the
  // format url; the server save uses _ytid (hls-64) as fallback.
  try {
    const res = await withTimeout(
      ytdlpInfoWithFallbacks(url),
      Math.max(5000, timeoutMs - 2000),
      'mixcloud yt-dlp timed out');
    const info = res && res.info;
    const fmts = (info && info.formats) || [];
    let direct = null;
    let hls64 = null;
    for (const f of fmts) {
      if (!f || !f.url) continue;
      const v = f.vcodec && f.vcodec !== 'none';
      const a = f.acodec && f.acodec !== 'none';
      if (v) continue;
      if (String(f.protocol || '') === 'https' && !direct) direct = f;
      if (String(f.format_id || '') === 'hls-64') hls64 = f;
    }
    const base = hls64 || direct;
    if (!base) return null;
    if (res.clientArgs) rawClientSet(url, res.clientArgs);
    const fmt = {
      id: 'mc-audio', label: 'Audio 64k',
      ext: (direct && direct.ext ? direct.ext : base.ext || 'm4a').toLowerCase(),
      hasAudio: true,
      filesize: (direct && (direct.filesize || direct.filesize_approx)) || 0,
      note: 'Sound only',
      _ytid: String(base.format_id),
    };
    // Direct progressive file when yt-dlp reports one — the browser
    // tries it first; the server save is the fallback.
    if (direct) fmt.url = direct.url;
    return {
      title: (info && info.title) || 'Mixcloud mix',
      thumbnail: (info && info.thumbnail) || '',
      duration: (info && info.duration) || 0,
      uploader: (info && info.uploader) || (info && info.channel) || '',
      previewUrl: '',
      note: 'Full-length mix — saving the audio can be slow.',
      formats: [fmt],
    };
  } catch { return null; }
}

async function odyseeInfo(url, timeoutMs) {
  const m = url.match(/odysee\.com\/(@[^/?#]+\/[^/?#]+)/i);
  if (!m) return null;
  const uri = decodeURIComponent(m[1]).replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const rpc = (method, params, budget) => postJsonTimeout(
    'https://api.lbry.tv/api/v1/proxy',
    { jsonrpc: '2.0', id: 1, method, params },
    Math.max(2000, Math.min(8000, budget)),
    { 'Content-Type': 'application/json-rpc' });
  // Whole chain in one go: the token in the m3u8 URL is short-lived.
  if (left() < 3000) return null;
  const r = await rpc('resolve', { urls: [uri] }, left());
  const claim = r && r.result && r.result[uri];
  if (!claim || claim.error || !claim.value || claim.value.stream_type !== 'video') return null;
  if (left() < 3000) return null;
  const g = await rpc('get', { uri, save_file: false }, left());
  const streamUrl = g && g.result && g.result.streaming_url;
  if (!streamUrl) return null;
  // HEAD with Referer follows the redirect to the tokenised
  // master.m3u8. The direct mp4 URL is deliberately NOT used (401
  // without a fresh token, 429 under repeat hits from this IP).
  let m3u8Url = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(2000, Math.min(10000, left())));
    try {
      const head = await fetch(streamUrl, {
        method: 'HEAD', redirect: 'follow', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://odysee.com/' },
      });
      if (head && head.url && head.url.includes('m3u8')) m3u8Url = head.url;
    } finally { clearTimeout(timer); }
  } catch { /* fall through */ }
  if (!m3u8Url || left() < 3000) return null;
  const master = await fetchTextTimeout(m3u8Url, Math.max(2000, Math.min(10000, left())),
    { Referer: 'https://odysee.com/' });
  if (!master) return null;
  const variants = [...master.matchAll(/#EXT-X-STREAM-INF:BANDWIDTH=(\d+),RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g)]
    .map((x) => {
      const h = parseInt(x[3], 10) || 0;
      return {
        id: 'od-' + h + 'p', label: h + 'p', ext: 'mp4', hasAudio: true,
        filesize: 0, note: 'With sound',
        // NO url: HLS manifest, not a file (see header).
        _m3u8: new URL(x[4].trim(), m3u8Url).href,
        _h: h,
      };
    })
    .filter((f) => f._h > 0);
  if (!variants.length) return null;
  variants.sort((a, b) => b._h - a._h);
  for (const f of variants) delete f._h;
  const thumb = claim.value.thumbnail && claim.value.thumbnail.url;
  return {
    title: claim.value.title || 'Odysee video',
    thumbnail: thumb || '',
    duration: Number(claim.value.duration) || 0,
    uploader: (claim.signing_channel && claim.signing_channel.name) || '',
    previewUrl: '',
    formats: variants,
  };
}

async function bitchuteInfo(url, timeoutMs) {
  const m = url.match(/bitchute\.com\/video\/([A-Za-z0-9]+)/i);
  if (!m) return null;
  // Own public API (no key). Direct fetch — yt-dlp's call to this
  // same endpoint fails from this VM, plain fetch works instantly.
  const d = await postJsonTimeout(
    'https://api.bitchute.com/api/beta/video/media',
    { video_id: m[1] },
    Math.min(10000, timeoutMs),
    { 'Content-Type': 'application/json' });
  if (!d || !d.media_url) return null;
  // Title from the page's og:title (page is ~8 KB, fast).
  let title = '';
  const html = await fetchTextTimeout(url, Math.min(8000, timeoutMs));
  if (html) {
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
      || html.match(/<title>([^<]+)<\/title>/i);
    if (t) title = t[1].trim().replace(/\s*[|\-–—]\s*BitChute.*$/i, '');
  }
  return {
    title: title || 'BitChute video',
    thumbnail: '',
    duration: 0,
    uploader: '',
    previewUrl: d.media_url,
    formats: [{
      id: 'bc-video', label: 'Video', ext: 'mp4', hasAudio: true,
      filesize: 0, note: 'With sound', url: d.media_url,
    }],
  };
}

async function peertubeInfo(url, timeoutMs) {
  // Any instance host — the allowlist gates which instances reach
  // this lane (framatube.org today; add an instance to ALLOWED_HOSTS
  // + clientSideKey before its links can use it).
  try {
    const res = await withTimeout(
      ytdlpInfoWithFallbacks(url),
      Math.max(5000, timeoutMs - 2000),
      'peertube yt-dlp timed out');
    const info = res && res.info;
    const fmts = (info && info.formats) || [];
    // Prefer direct progressive mp4s (some instances serve them);
    // otherwise the HLS variants (this instance: HLS only).
    const byHeight = new Map();
    for (const f of fmts) {
      if (!f || !f.url || !f.height) continue;
      const v = f.vcodec && f.vcodec !== 'none';
      if (!v) continue;
      const isManifest = String(f.protocol || '').includes('m3u8')
        || String(f.url).includes('.m3u8');
      const isDirect = !isManifest && String(f.protocol || '') === 'https'
        && (f.acodec && f.acodec !== 'none');
      const cur = byHeight.get(f.height);
      const cand = {
        id: 'pt-' + f.height + 'p', label: f.height + 'p', ext: 'mp4',
        hasAudio: true,
        filesize: f.filesize || f.filesize_approx || 0,
        note: 'With sound',
        _ytid: String(f.format_id),
        _direct: isDirect,
      };
      if (isDirect) cand.url = f.url;
      // Direct beats HLS at the same height; higher bitrate wins
      // within the same kind.
      if (!cur || (cand._direct && !cur._direct)
        || (cand._direct === cur._direct && (f.tbr || 0) > (cur._tbr || 0))) {
        cand._tbr = f.tbr || 0;
        byHeight.set(f.height, cand);
      }
    }
    const formats = [...byHeight.values()]
      .sort((a, b) => parseInt(b.id.slice(3), 10) - parseInt(a.id.slice(3), 10))
      .map((f) => { delete f._direct; delete f._tbr; return f; });
    if (!formats.length) return null;
    if (res.clientArgs) rawClientSet(url, res.clientArgs);
    return {
      title: (info && info.title) || 'PeerTube video',
      thumbnail: (info && info.thumbnail) || '',
      duration: (info && info.duration) || 0,
      uploader: (info && info.uploader) || (info && info.channel) || '',
      previewUrl: '',
      formats,
    };
  } catch { return null; }
}

// Strip the internal-only fields before a lane result reaches the
// visitor (info path). The save path re-runs the lane itself, so it
// still sees _ytid / _m3u8.
function stripWorldcInternal(result) {
  if (!result || !Array.isArray(result.formats)) return;
  for (const f of result.formats) {
    if (!f) continue;
    delete f._ytid;
    delete f._m3u8;
  }
}

// /api/save resolver for the HLS world-C lanes (sc-/mc-/od-/pt-).
// Returns the yt-dlp invocation that downloads + remuxes the lane's
// media, or null. sc-mp3 (direct MP3 file) is NOT handled here — it
// goes through the chain branch like the other direct files.
async function worldcSaveSpec(url, formatId) {
  if (formatId.startsWith('sc-')) {
    const info = await soundcloudInfo(url, 20000);
    const f = (info && info.formats || []).find((x) => x && x.id === formatId);
    if (!f || !f._ytid) return null;
    const ext = (f.ext || 'm4a').toLowerCase();
    return { mode: 'ytdlp', ytdlpFormatId: f._ytid, ext,
      ctype: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' };
  }
  if (formatId.startsWith('mc-')) {
    const info = await mixcloudInfo(url, 20000);
    const f = (info && info.formats || []).find((x) => x && x.id === formatId);
    if (!f || !f._ytid) return null;
    const ext = (f.ext || 'm4a').toLowerCase();
    return { mode: 'ytdlp', ytdlpFormatId: f._ytid, ext,
      ctype: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4' };
  }
  if (formatId.startsWith('od-')) {
    const info = await odyseeInfo(url, 20000);
    const f = (info && info.formats || []).find((x) => x && x.id === formatId);
    if (!f || !f._m3u8) return null;
    return { mode: 'm3u8', m3u8Url: f._m3u8, ext: 'mp4', ctype: 'video/mp4' };
  }
  if (formatId.startsWith('pt-')) {
    const info = await peertubeInfo(url, 20000);
    const f = (info && info.formats || []).find((x) => x && x.id === formatId);
    if (!f || !f._ytid) return null;
    return { mode: 'ytdlp', ytdlpFormatId: f._ytid, ext: 'mp4', ctype: 'video/mp4' };
  }
  return null;
}

// ---- New own lanes, part 6: VK + OK.ru (step 15) ------------------------
// Verified 2026-11-24 by the worldwide-B prober (PROBE.md in
// own-first/worldwide-b/): both lanes returned REAL files, downloaded
// and ffprobe-checked (VK full 144p file 46,028,218 B, h264 + aac,
// 1983.30 s; OK 30 s sd section 880,704 B, h264 852x480 + aac).
// These are the platforms' OWN extractors, used as own-extraction
// lanes BEFORE yt-dlp's generic block — no third-party resolver is
// involved anywhere (no working third-party lane exists for either
// platform: the prober found none).
//
// IP-BOUND (confirmed by the probe, still true): every file URL the
// lanes return carries srcIp=<THIS server's egress IP> + expires=
// (~3 days VK, ~24 h OK) + sig=. A visitor's browser (a different IP)
// CANNOT fetch the URL, so these formats are SERVER-SAVE-ONLY:
//  - the result carries NO clientSide flag (the frontend shows the
//    server Save button, never a direct link);
//  - the result is NEVER cached (the URLs expire; a cached result
//    would hand out dead links);
//  - /api/save re-resolves fresh via vkOkStreamUrl below and streams
//    the file through from this server's IP (the same IP the URL is
//    bound to) — the same mechanism /api/save already uses for
//    merged/chain saves, extended, not a new download path.
// The raw file URL must never appear as a clickable/direct link in
// the UI. Do NOT add 'vk'/'ok' to CLIENT_SIDE_ONLY — /api/save must
// accept them (that set is exactly what /api/save refuses).
//
// VK: yt-dlp only (the watch page 302s to the homepage, vk.com/video
// 302s to a login wall — a page scrape cannot work). Progressive mp4s
// url144..url1080 (protocol https, vcodec/acodec reported as null by
// yt-dlp, but the downloaded files are h264 + aac — verified).
//
// CALL SHAPE (measured 2026-11-24): the lanes call ytdlpJson(url,
// timeout, [], false) DIRECTLY — one plain attempt, direct egress —
// NOT ytdlpInfoWithFallbacks. That helper races a plain attempt
// against an iPhone-UA attempt, and for VK the iPhone-UA attempt
// crashes the extractor outright (KeyError('params'), 7.4 s) while
// the two concurrent processes push the good attempt past the
// helper's 20 s cap: the first /api/save test 502'd at 18.7 s on
// exactly this. A single plain -J answers in ~12-16 s. Direct egress
// (allowProxy=false) is also REQUIRED, not incidental: the file URL
// is bound to the resolving IP, and the /api/save fetch runs on the
// server's direct egress — resolving through a proxy would bind the
// URL to the proxy IP and the save fetch would fail.
// OK.ru: yt-dlp first (progressive mp4s mobile/lowest/low/sd/hd +
// HLS); the page HTML is the BACKUP and runs ONLY when yt-dlp fails
// or returns no progressive format — the page embeds the same five
// renditions as JSON-escaped "videos":[{"name":...,"url":...}] entries.
// OK heights are NOT in the yt-dlp data (height is null on the
// progressive formats), so OK ids/labels use the platform's own
// quality names (Mobile/Lowest/Low/SD/HD) — no height is invented.
// (The sd file was ffprobe-verified at 852x480 and hd is the top
// rendition, but the labels stay with the names.)
//
// INVISIBILITY: format ids are neutral (vk-/ok-) — no resolver,
// service or CDN name reaches the visitor. All calls are server-side.

// VK progressive mp4s: format_id url144..url1080, protocol https.
async function vkInfo(url, timeoutMs) {
  const m = url.match(/(?:vk\.com|vkvideo\.ru)\/(?:video|clip)(-?\d+_\d+)/i);
  if (!m) return null;
  let info = null;
  try {
    info = await withTimeout(ytdlpJson(url, timeoutMs, [], false), timeoutMs, 'vk timed out');
  } catch { return null; }
  const list = (info && Array.isArray(info.formats)) ? info.formats : [];
  const formats = [];
  for (const f of list) {
    if (!f || !f.url || f.ext !== 'mp4') continue;
    const hm = String(f.format_id || '').match(/^url(\d+)$/);
    if (!hm) continue; // DASH/HLS variants only — never a single file
    if (String(f.protocol || '').toLowerCase().includes('m3u8') || String(f.protocol || '').toLowerCase().includes('dash')) continue;
    const h = parseInt(hm[1], 10);
    if (!h) continue;
    if (formats.some((x) => x.id === 'vk-' + h + 'p')) continue;
    // hasAudio: true — the progressive files carry sound (probe:
    // full 144p download is h264 + aac). yt-dlp reports no codec
    // info for these formats, so this is asserted from the probe,
    // not read from the format record.
    formats.push({ id: 'vk-' + h + 'p', label: h + 'p', ext: 'mp4', hasAudio: true, filesize: 0, note: 'With sound', url: f.url });
  }
  if (!formats.length) return null;
  formats.sort((a, b) => parseInt(b.label, 10) - parseInt(a.label, 10));
  return {
    title: (info && info.title) || '',
    thumbnail: (info && info.thumbnail) || '',
    duration: (info && info.duration) || 0,
    uploader: (info && (info.uploader || info.channel)) || '',
    previewUrl: previewUrl(info),
    formats,
  };
}

// OK.ru progressive mp4s, by the platform's own quality names.
const OK_PROG = {
  mobile: { rank: 0, label: 'Mobile' },
  lowest: { rank: 1, label: 'Lowest' },
  low: { rank: 2, label: 'Low' },
  sd: { rank: 3, label: 'SD' },
  hd: { rank: 4, label: 'HD' },
};

function okFormatsFromYtdlp(info) {
  const list = (info && Array.isArray(info.formats)) ? info.formats : [];
  const formats = [];
  for (const f of list) {
    if (!f || !f.url || f.ext !== 'mp4') continue;
    const name = String(f.format_id || '');
    if (!OK_PROG[name]) continue; // hls-* are playlists, not files
    if (String(f.protocol || '').toLowerCase().includes('m3u8') || String(f.protocol || '').toLowerCase().includes('dash')) continue;
    if (formats.some((x) => x.id === 'ok-' + name)) continue;
    // hasAudio: true — the progressive files carry sound (probe:
    // 30 s sd section is h264 + aac). yt-dlp reports no codec info
    // for these formats, so this is asserted from the probe.
    formats.push({ id: 'ok-' + name, label: OK_PROG[name].label, ext: 'mp4', hasAudio: true, filesize: 0, note: 'With sound', url: f.url });
  }
  formats.sort((a, b) => OK_PROG[b.id.slice(3)].rank - OK_PROG[a.id.slice(3)].rank);
  return formats;
}

// OK.ru page-HTML backup — runs ONLY when yt-dlp fails or returns no
// progressive format. The page embeds the same five renditions as
// JSON-escaped entries: &quot;name&quot;:&quot;mobile&quot;,
// &quot;url&quot;:&quot;https://vd*.okcdn.ru/?expires=...&quot;
// with the query separators JSON-escaped as \u0026. Same IP-bound
// caveat as the yt-dlp path — server-save only, never cached.
async function okPageInfo(url, timeoutMs) {
  const html = await fetchTextTimeout(url, timeoutMs);
  if (!html) return null;
  const formats = [];
  const re = /&quot;name&quot;:&quot;(mobile|lowest|low|sd|hd)&quot;,&quot;url&quot;:&quot;(https:\/\/vd\d+\.okcdn\.ru\/\?[^&]*?(?:\\u0026[^&]*?)*)&quot;/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1];
    if (formats.some((x) => x.id === 'ok-' + name)) continue;
    const fileUrl = m[2].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    if (!fileUrl) continue;
    formats.push({ id: 'ok-' + name, label: OK_PROG[name].label, ext: 'mp4', hasAudio: true, filesize: 0, note: 'With sound', url: fileUrl });
  }
  if (!formats.length) return null;
  formats.sort((a, b) => OK_PROG[b.id.slice(3)].rank - OK_PROG[a.id.slice(3)].rank);
  const rawTitle = ((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '').trim();
  return {
    title: decodeEntities(rawTitle),
    thumbnail: '',
    duration: 0,
    uploader: '',
    previewUrl: '',
    formats,
  };
}

async function okInfo(url, timeoutMs) {
  const m = url.match(/ok\.ru\/video\/(\d+)/i);
  if (!m) return null;
  // yt-dlp first; the page scrape is the backup, not the primary.
  try {
    const info = await withTimeout(ytdlpJson(url, timeoutMs, [], false), timeoutMs, 'ok timed out');
    const formats = okFormatsFromYtdlp(info);
    if (formats.length) {
      return {
        title: (info && info.title) || '',
        thumbnail: (info && info.thumbnail) || '',
        duration: (info && info.duration) || 0,
        uploader: (info && (info.uploader || info.channel)) || '',
        previewUrl: previewUrl(info),
        formats,
      };
    }
  } catch {
    // yt-dlp failed — fall through to the page backup below.
  }
  return okPageInfo(url, timeoutMs);
}

// /api/save resolver for vk-*/ok-*: re-resolve fresh (the URL is
// IP-bound to this server and expires, so a stored URL would be dead
// or bound to the wrong IP) and return the file URL for the server to
// stream through. The same neutral id comes back on a re-resolve.
async function vkOkStreamUrl(url, formatId) {
  let info = null;
  // 30 s (not 20 s): /api/save has no 25 s cap, and a single VK -J
  // takes ~12-16 s — the headroom is for slow days.
  if (formatId.startsWith('vk-')) info = await vkInfo(url, 30000);
  else if (formatId.startsWith('ok-')) info = await okInfo(url, 30000);
  if (!info) return null;
  const f = (info.formats || []).find((x) => x && x.id === formatId);
  return f ? f.url : null;
}

// ---- New own lane, part 7: Kick (step 16) -------------------------------
// Verified 2026-11-24 by the remux prober (REMUX-PROTOTYPE.md in
// scratch-remux/): the Kick VOD (kick.com/4oe1/videos/01a20ae9…,
// 9,867 s) resolves via own yt-dlp -J to HLS variants 160p/360p/480p/
// 720p + audio-only (resolve 4.97 s). NO direct mp4 exists — the
// server must remux HLS->mp4 with ffmpeg -c copy (60 s remux 7.52 s,
// 5,320,999 B, ffprobe h264 640x360 + aac; 300 s remux 27.09 s,
// 26,518,438 B; linear ~0.09-0.13 s wall per content-second).
// This is the platform's OWN extractor (yt-dlp), used as an
// own-extraction lane BEFORE generic yt-dlp. No third-party resolver.
//
// SAVE MODEL: the visitor saves through /api/save (kc-* branch in
// build.py step 16), which re-resolves the variant playlist fresh and
// remuxes it to a temp file, then streams the file and deletes it —
// the same temp-file/stream/delete pattern as the merged save. The
// format carries NO url (an HLS playlist is not a file — the browser
// would "save" a text playlist). No cache (signed URLs). No
// clientSide flag. Duration caps (enforced at save time): 600 s max
// inline; 720p only to 300 s. Longer VODs need a background job
// (not built) and get a neutral "too long" message.
// VODs only — Kick Clips (kick.com/<channel>/clips/<id>) were NOT
// probed; they fall through to generic yt-dlp.
//
// INVISIBILITY: format ids are neutral (kc-) — no resolver or
// service name reaches the visitor. All calls are server-side.

// Remux caps (used by the /api/save kc- branch, build.py step 16).
const KICK_REMUX_MAX_DURATION_S = 600;
const KICK_REMUX_TIMEOUT_MS = 300000;
const KICK_FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Kick VOD: yt-dlp -J -> HLS variant playlists (m3u8_native).
// Returns {title, duration, formats:[{id:'kc-360p',...}]} or null.
// The _ytid is internal-only: the save branch re-resolves via
// kickVariantUrl, so it is NOT included here (nothing to strip).
async function kickInfo(url, timeoutMs) {
  const m = url.match(/kick\.com\/[^/]+\/videos\/[0-9a-f-]+/i);
  if (!m) return null;
  let info = null;
  try {
    info = await withTimeout(ytdlpJson(url, timeoutMs, [], false), timeoutMs, 'kick timed out');
  } catch { return null; }
  const fmts = (info && Array.isArray(info.formats)) ? info.formats : [];
  const formats = [];
  for (const f of fmts) {
    if (!f || !f.url || String(f.protocol || '') !== 'm3u8_native') continue;
    const isAudio = !f.vcodec || f.vcodec === 'none';
    const h = parseInt(String(f.height || ''), 10) || 0;
    let id, label, ext;
    if (isAudio) { id = 'kc-audio'; label = 'Audio only'; ext = 'm4a'; }
    else if (h) { id = 'kc-' + h + 'p'; label = h + 'p'; ext = 'mp4'; }
    else continue;
    if (formats.some((x) => x.id === id)) continue;
    formats.push({ id, label, ext, hasAudio: true, filesize: 0, note: isAudio ? 'Sound only' : 'With sound' });
  }
  if (!formats.length) return null;
  return {
    title: (info && info.title) || '',
    thumbnail: (info && info.thumbnail) || '',
    duration: Number(info.duration) || 0,
    uploader: (info && (info.uploader || info.channel)) || '',
    previewUrl: '',
    formats,
  };
}

// /api/save resolver for kc-*: re-resolve fresh (variant URLs are
// signed/short-lived) and return {url, duration, title} or null.
// One retry: Kick's API closes the connection without a response on
// roughly half the -J calls from this VM (measured 2026-11-24:
// three direct -J attempts in a row went fail / ok / fail, and two
// back-to-back saves failed both their attempts) — without retries,
// a visitor's save 502s on a flake the lane itself cannot control.
// Three attempts with a 3 s pause between them: the pause matters
// because four rapid attempts in ~15 s ALL failed (burst throttle),
// while an attempt after a short pause succeeded. Three attempts
// at ~50% each still fail ~1 time in 8 — the lane is honest about
// that in REPORT.md §13; a fourth attempt would only add latency.
async function kickVariantUrl(url, formatId) {
  const quality = formatId.slice(3); // '160p' | '360p' | '480p' | '720p' | 'audio'
  let info = null;
  for (let attempt = 0; attempt < 3 && !info; attempt++) {
    try {
      info = await ytdlpJson(url, 25000, [], false);
    } catch { info = null; }
    if (!info && attempt < 2) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!info || !Array.isArray(info.formats)) return null;
  const f = info.formats.find((x) => {
    if (!x || !x.url || String(x.protocol || '') !== 'm3u8_native') return false;
    if (quality === 'audio') return !x.vcodec || x.vcodec === 'none';
    return (parseInt(String(x.height || ''), 10) || 0) === parseInt(quality, 10);
  });
  if (!f) return null;
  return { url: f.url, duration: Number(info.duration) || 0, title: info.title || null };
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

// yt-dlp's exact verdict when the platform answered but the video has no
// stream at all: TikTok's API returned an aweme with no video URL behind
// it. Distinct from a timeout (no answer), a block (403/IP message) and
// a deleted/private video ("Video unavailable", "private", "Login
// required") — none of those match this pattern, so matching it is a
// positive statement about the VIDEO, not about our network.
function isNoFormats(text) {
  if (!text) return false;
  return /no video formats found/i.test(String(text));
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
    execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15', ...extraArgs, ...pargs, url],
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

// A YouTube result is "degraded" when it has no adaptive video-only
// streams and no audio-only streams — only progressive files (in
// practice: the Android client answering with just format 18 when
// YouTube demands signature deciphering). Such a result hides every
// other quality the video actually has, so it must never settle the
// client race while another round could still return the full list.
function isDegradedInfo(info) {
  const list = Array.isArray(info && info.formats) ? info.formats : [];
  let vo = 0, ao = 0;
  for (const f of list) {
    if (!f || f.ext === 'mhtml') continue;
    const v = f.vcodec && f.vcodec !== 'none';
    const a = f.acodec && f.acodec !== 'none';
    if (v && !a) vo++;
    else if (!v && a) ao++;
  }
  return vo === 0 && ao === 0;
}

function withTimeout(promise, ms, msg) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); }),
  ]);
}

// First-success race with a short grace window (YouTube speed fix
// 2026-11-25). Each promise resolves to a FULL (non-degraded) result
// or null; degraded results never settle the race — the caller keeps
// the best degraded as a fallback instead. The first full result
// wins, but a second result landing within ~500ms with a fuller list
// (higher infoScore) replaces it, so a fast thin answer does not beat
// an own full list that was a fraction behind it. A geo-block
// rejection ends the race at once: no other lane in this region can
// read the video, so waiting out the other side only burns the 25s
// cap. Any other rejection counts as that side answering null.
// First truthy result wins; resolves null only when every leg settled
// without one (a rejection counts as that leg answering null). A
// geoBlocked rejection ends the race at once: no other lane in this
// region can read the video, so waiting out the other side only burns
// the cap — same fast-fail as raceFirstFull.
function firstNonNull(promises) {
  return new Promise((resolve, reject) => {
    let done = 0;
    let settled = false;
    if (!promises.length) { resolve(null); return; }
    promises.forEach((p) => {
      Promise.resolve(p).then((v) => {
        if (settled) return;
        done++;
        if (v) { settled = true; resolve(v); }
        else if (done === promises.length) { settled = true; resolve(null); }
      }, (e) => {
        if (settled) return;
        if (e && e.geoBlocked) { settled = true; reject(e); return; }
        done++;
        if (done === promises.length) { settled = true; resolve(null); }
      });
    });
  });
}

function raceFirstFull(promises, graceMs = 500) {
  return new Promise((resolve, reject) => {
    let best = null;
    let done = 0;
    let settled = false;
    let graceTimer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(v);
    };
    const failGeo = (e) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      reject(e);
    };
    if (!promises.length) { finish(null); return; }
    promises.forEach((p) => {
      Promise.resolve(p).then((v) => {
        if (settled) return;
        done++;
        if (v && (!best || infoScore(v.info) > infoScore(best.info))) {
          const isFirst = !best;
          best = v;
          if (isFirst && done < promises.length) {
            graceTimer = setTimeout(() => finish(best), graceMs);
            return;
          }
        }
        if (done === promises.length) finish(best);
      }, (e) => {
        if (settled) return;
        if (e && e.geoBlocked) { failGeo(e); return; }
        done++;
        if (done === promises.length) finish(best);
      });
    });
  });
}

// Info lookup: OWN FIRST (standing rule 2026-11-24) — our own extraction runs before any third-party resolver. TikTok runs in TWO rounds —
// direct first (8s), then the WARP proxy round (12s). Direct first, so
// a host whose own IP works never hides behind the proxy; the proxy
// only runs when direct fails.
// YouTube runs its clients SEQUENTIALLY, android first (the reliable
// progressive itag-18 answer, which settles as partial:true at once —
// see ownDegradedP), then default / tv_embedded / web_embedded / ios
// for the full list, direct pass then WARP pass — measured 2026-11-24:
// concurrent clients each take ~17s and are killed by the round caps,
// while one client alone takes ~5-8s. The Invidious/Piped mirrors are
// pre-fetched alongside the sequence (cheap HTTP, no yt-dlp process)
// and RACED against it (first full list wins, 500ms grace for a fuller
// second result) — a mirror that answers in ~2s no longer waits behind
// passes that nominally take 5 clients x 9s + 5 x 12s and are killed by
// the 25s cap. The YT-A resolve (pre-started in lookupInfo) is raced
// too (ydFastP): a ~1s resolve for a short video is the first list.
// A degraded (android-only, format 18) result settles the lookup at
// once as partial:true on the SYNC path — the default client no longer
// gates the first list; its full list arrives via the silent upgrade
// (job path). On the JOB path (opts.fastPartial === false) no partial
// side settles: the job is the completeness route, so it waits for the
// full list instead of answering with the same partial again.
// TikTok: the plain client races two other API hostnames (the
// iPhone user-agent breaks TikTok in yt-dlp, so it is NOT used here).
// Everything else: plain + iPhone user-agent, 20s, direct only —
// except Instagram, which is plain ONLY (the iPhone-UA attempt
// hard-fails at the extractor level, "Instagram sent an empty media
// response", and its retries starve the plain attempt past the 14s
// cap), and Tumblr, which gets a second WARP-proxy round (20s) after
// the direct round (15s), because Render's IPs fail on it.
// Returns { info, clientArgs, viaProxy } — clientArgs are the yt-dlp
// extra args of the client that produced this info (null for mirrors),
// so /api/save can download with the same client AND the same egress:
// a format from tv_embedded does not exist for the android client, and
// a save with the wrong client fails.
async function ytdlpInfoWithFallbacks(url, opts = {}) {
  // FAST-QUALITY opts (2026-11-25): fastPartial (default true) — a
  // partial answer may settle the lookup at once on the SYNC path;
  // lookupInfo passes fastPartial:false on the job path. ydPrefetch —
  // the YT-A resolve started alongside the own branch (lookupInfo).
  const fastPartial = !opts || opts.fastPartial !== false;
  const ydPrefetchOpt = (opts && opts.ydPrefetch) || null;
  const chocPrefetchOpt = (opts && opts.chocPrefetch) || null;
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
    // SEQUENTIAL clients, android first — measured 2026-11-24 on this
    // VM (zoo video): 2+ concurrent yt-dlp processes each take ~17s
    // (YouTube throttles parallel requests from one IP; the VM has 1.5
    // shared CPUs), while ONE client alone takes ~5-8s. The old code
    // ran all five at once inside an 8s round cap, so every client was
    // killed before it could answer — and the only one fast enough to
    // finish inside the 12s round-2 cap was android, which returns just
    // format 18. That is exactly the "one quality" the owner saw.
    // ANDROID FIRST (speed fix 2026-11-25, measured 2026-11-25):
    // android is the only client that never failed here (8/8; default
    // failed 3 of its last 5 with the bot-check) and it always returns
    // the progressive itag-18 file (playable preview with sound).
    // It runs first so its degraded answer can settle as partial:true
    // at once (ownDegradedP below) instead of waiting behind the
    // default + tv_embedded clients (~9s each) that used to gate it;
    // the default client then runs for the full-list upgrade only.
    const clients = [
      ['--extractor-args', 'youtube:player_client=android'], // degraded (format 18 only) — FIRST, reliable progressive
      [], // default web client — full adaptive list when it answers
      ['--extractor-args', 'youtube:player_client=tv_embedded'], // full list
      ['--extractor-args', 'youtube:player_client=web_embedded'],
      ['--extractor-args', 'youtube:player_client=ios'],
    ];
    let lastDetail = '';
    // Best degraded result across passes (see isDegradedInfo below) —
    // returned only when no side produced a full format list.
    let ownFallback = null;
    // Fast geo probe — resolves true (geo) or false (inconclusive)
    // within ~4s of starting. A yt-dlp probe CANNOT work: a single
    // android client takes 7.5–9.5s to surface the geo error (its player
    // requests get 429'd and retried), and 4 concurrent clients take
    // 13–19s — measured 2026-11-24. The watch-page fetch in
    // geoBlockedInPlayer answers in ~2s instead. It runs alongside
    // the client sequence (a plain fetch, not a process, so a normal
    // video costs nothing).
    // REGRESSION (2026-11-24): the probe used to be checked only at the
    // END of a pass — fine when clients ran concurrently and round 1
    // finished in 8s, but a sequential pass is 5 clients x 9s = 45s
    // while /api/info caps at 25s, so the handler aborted mid-pass and
    // the check never ran: a geo-blocked video answered 502 "taking
    // too long" with no geoBlocked flag. Now the probe is (a) awaited
    // briefly up front (2500ms cap), and (b) re-checked before/after
    // EVERY client, so a geo-blocked video fails fast (~2-3s when the
    // probe is quick, right after the first client at worst).
    const probeGeo = (async () => {
      // The watch-page fetch can miss on a throttled IP (abort, a 429,
      // or a consent page with no playabilityStatus): a miss is
      // retried once — the fetch usually lands in ~2s unloaded, and a
      // retry still answers in time for the race below. A page with no
      // playabilityStatus at all is not a watch page (consent
      // redirect), so it counts as a miss, not as "not blocked".
      // Measured 2026-11-24: a single 4s fetch returned null 3 runs
      // in a row while curl got the real page in ~2s — so one attempt
      // is not reliable enough here.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const html = await fetchPageHtml(url, 8000);
          if (html && html.includes('playabilityStatus')) return geoBlockedInPlayer(html);
        } catch { /* fall through to retry */ }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    })();
    // Settled value of the probe, read by the checks below. Never
    // throw inside this .then: the probe runs un-awaited after the
    // up-front race, and a throw there would be an unhandled rejection.
    let geoProbeBlocked = false;
    // Resolves the moment the probe says geo-blocked; never resolves
    // otherwise. Used to race the client calls below, so a probe that
    // answers mid-client (its page fetch can take ~4s on a throttled
    // IP, while the client runs 9s) fails fast instead of waiting out
    // the client's timeout.
    let geoWatchResolve;
    const geoWatch = new Promise((r) => { geoWatchResolve = r; });
    probeGeo.then((v) => {
      geoProbeBlocked = v;
      if (v) geoWatchResolve(true);
    });
    const geoThrow = () => {
      const gerr = new Error('This video is blocked in this region.');
      gerr.detail = lastDetail;
      gerr.geoBlocked = true;
      throw gerr;
    };
    // Wait briefly for the fast geo probe before starting anything
    // else: the probe's page fetch competes with the mirror burst and
    // the yt-dlp clients for this IP's throttled egress, and a fetch
    // that starts into that burst can abort (measured 2026-11-24:
    // the same fetch is 4/4 reliable alone in ~1-2s, but returned
    // null 3 runs in a row inside the server). Giving it a quiet
    // ~2.5s window first makes it reliable. It usually answers in
    // ~2s, so a geo-blocked video fails here in ~2s instead of after
    // a 9s client timeout. The wait is capped at 2500ms, so a slow
    // probe costs normal videos at most 2.5s (a normal lookup still
    // lands in ~8s, inside the frontend's 27s per-origin budget). If
    // the probe has not answered yet, the sequence starts anyway and
    // the per-client checks + race below catch it the moment it
    // resolves.
    await Promise.race([
      probeGeo,
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    if (geoProbeBlocked) geoThrow();
    // The Invidious/Piped mirrors are pre-fetched alongside the client
    // sequence (started here, after the probe's quiet window): cheap HTTP
    // fetches, no yt-dlp process, so they cost nothing. Bounded at 9s and
    // never rejects, so a dead mirror cannot hang the sequence. The
    // mirror is a RACE side now (raceFirstFull below), not a last
    // resort: whichever of the mirror / own passes returns a FULL list
    // first wins, so a round ends at the first success.
    // FAST FIRST RENDER (speed fix 2026-11-25): laneStart marks when the
    // mirror fetch starts, so the degraded-mirror deadline below is
    // measured from the lane start, not from when the mirror happens
    // to be checked.
    const laneStart = Date.now();
    let mirrorBest = null;
    const mirrorDone = withTimeout(mirrorInfo(url), 9000, 'mirror timeout')
      .then((info) => { if (info) mirrorBest = { info, clientArgs: null }; })
      .catch(() => {});
    // Mirror race side: resolves to the mirror's FULL list, or null
    // when the mirror is dead or degraded-only. mirrorBest keeps the
    // raw mirror answer for the degraded-fallback comparison after
    // the race.
    const mirrorFullP = mirrorDone.then(() => {
      if (mirrorBest && !isDegradedInfo(mirrorBest.info)) {
        mirrorBest.viaProxy = false;
        return mirrorBest;
      }
      return null;
    });
    // FAST FIRST RENDER (speed fix 2026-11-25): a DEGRADED mirror
    // answer (itag 18 progressive, with sound) that lands within
    // ~3s of the lane start settles the lookup at once — the visitor
    // gets a playable preview + the 360p quality in ~2s instead of
    // waiting ~22s for the own passes. The mirror's own landing
    // time decides: no fixed 3s sleep is added when the mirror is
    // already in hand. After the deadline the promise never settles
    // and the lookup falls through to the existing raceFirstFull
    // behaviour unchanged. A full mirror answer never resolves here
    // (it is the raceFirstFull side above). A geo-block rejects
    // instead, so the geo fast-fail still wins over a degraded
    // mirror in both paths.
    const mirrorDegradedP = (async () => {
      const waited = await Promise.race([
        mirrorDone.then(() => 'mirror'),
        geoWatch.then(() => 'geo'),
        new Promise((r) => setTimeout(() => r('timeout'),
          Math.max(0, 3000 - (Date.now() - laneStart)))),
      ]);
      if (waited === 'geo') geoThrow();
      if (waited !== 'mirror') return new Promise(() => {});
      // Job path (fastPartial false): never settle a partial — the job
      // is the completeness route, and settling here would answer the
      // upgrade with the same thin list it already has (verified
      // 2026-11-25: with the mirror alive, the ~3s partial settled the
      // lookup and the own full list was discarded, upgrade never
      // landed). The post-race fallback below still returns the
      // degraded mirror when nothing fuller exists.
      if (!fastPartial) return new Promise(() => {});
      if (mirrorBest && isDegradedInfo(mirrorBest.info)) {
        mirrorBest.partial = true;
        return mirrorBest;
      }
      return new Promise(() => {});
    })();
    // FAST FIRST RENDER (speed fix 2026-11-25): a DEGRADED own answer
    // (android itag 18, the reliable progressive file) settles the
    // lookup at once as partial:true — the same treatment the degraded
    // mirror gets above. The default client no longer gates the first
    // list: android runs first in the sequence, and its answer is the
    // first list; the default client's full list arrives via the
    // silent upgrade (job path). Sync path only (fastPartial): on the
    // job path the lookup waits for the full list instead.
    // raceSettled stops the own passes starting NEW clients once the
    // lookup already answered (the in-flight client still runs to its
    // own cap) — without it a ~3s mirror settle leaves five clients
    // burning CPU in the background for up to ~100s.
    let raceSettled = false;
    let ownDegradedResolve;
    let ownDegradedFired = false;
    const ownDegradedP = new Promise((r) => { ownDegradedResolve = r; });
    const fireOwnDegraded = (cand) => {
      if (!fastPartial || ownDegradedFired || !ownDegradedResolve) return;
      ownDegradedFired = true;
      ownDegradedResolve({ ...cand, partial: true });
    };
    // FAST FIRST RENDER (speed fix 2026-11-25): the YT-A resolve
    // (ytdownloaderTech) was pre-started alongside the own branch in
    // lookupInfo — race it here too, so a ~1s resolve for a short
    // video settles as the partial first list instead of waiting for
    // ytChain (which only runs after own failure). The resolve is a
    // single merged progressive mp4: it is mapped to yt-dlp shape
    // (format_id 'yd-<height>', the resolver's own id) so the winner
    // handling below (progressive check, limited-list partial flag)
    // and the generic build treat it like any progressive format.
    // /api/save dispatches 'yd-' ids to chainStreamUrl, which re-runs
    // the same resolver — so the quality saves correctly. Sync path
    // only (fastPartial): on the job path the lookup waits for the
    // full list.
    const ydFastP = (async () => {
      if (!fastPartial || !ydPrefetchOpt) return new Promise(() => {});
      const r = await ydPrefetchOpt;
      if (!r || !Array.isArray(r.formats) || !r.formats.length || !r.formats[0].url) return new Promise(() => {});
      // YT-LONG FULL LIST (2026-11-26): the 1.5s choc grace is GONE.
      // It existed because YT-A's answer was a THIN 1-format list and
      // choc's was FULL — YT-A had to wait so choc could win. Now
      // ytdownloaderTech returns the FULL list itself (8 merged mp4s
      // + audio), so YT-A settles immediately with it; the grace only
      // cost 1.5s on every first list. (Choc is blocked from Render
      // anyway, so the grace never paid off live.) If choc happens to
      // resolve first on a clean IP, chocFastP still settles with its
      // list and the upgrade job adds YT-A.
      // Convert ALL of YT-A's formats to info formats (not just the
      // first) so the first list is the full list. partial is set by
      // the same bar as isLimitedList/chainListIsThin (< 8 formats or
      // max height < 720p); a full list is not partial, so the
      // frontend does not start the upgrade job for it.
      const infoFormats = r.formats.filter((f) => f && f.url).map((f) => {
        const isAudio = String(f.id || '') === 'yd-audio' || String(f.label || '') === 'Audio only';
        const h = isAudio ? 0 : (parseInt(String(f.label || '').replace(/[^0-9]/g, ''), 10) || 0);
        return {
          format_id: String(f.id || ('yd-' + (h || 'video'))),
          ext: isAudio ? (f.ext || 'm4a') : 'mp4',
          height: h,
          width: 0,
          fps: 0,
          vcodec: isAudio ? 'none' : 'avc1',
          acodec: 'mp4a',
          url: f.url,
          filesize: f.filesize || 0,
          filesize_approx: f.filesize || 0,
          tbr: 0,
        };
      });
      if (!infoFormats.length) return new Promise(() => {});
      const maxH = Math.max(0, ...infoFormats.map((x) => x.height || 0));
      const isFull = infoFormats.length >= 8 && maxH >= 720;
      const info = {
        title: r.title || 'Video',
        thumbnail: '',
        duration: 0,
        uploader: '',
        formats: infoFormats,
      };
      return { info, clientArgs: null, viaProxy: false, partial: !isFull };
    })();
    // YT-LONG FIX (2026-11-26): the choc (Invidious) metadata was
    // pre-started alongside the own branch in lookupInfo but never
    // raced here — it only ran inside ytChain AFTER own failure, with
    // ~0-4s budget left. Choc's metadata answers in ~1.5-2s with the
    // FULL adaptive list (10 mp4 video-only up to 1080p60 + best
    // audio m4a) and its proxy files DO download (9.1 MB in 8.9s at
    // ~1 MB/s, 720p60 66 MB in 30.7s at ~2.1 MB/s, both with a plain
    // browser UA — measured 2026-11-26; the old "~55s for 322 KB"
    // probe is stale). Racing it here makes the first list the FULL
    // list in ~2.5s on Render, instead of YT-A's thin 1-format list
    // in ~20s. The answer is marked partial:true (no progressive
    // format in it — the preview is the choc video-only stream,
    // silent) so the frontend still starts the silent upgrade job,
    // which returns the union (choc + YT-A progressive) and the
    // preview relay with sound. Sync path only (fastPartial): on the
    // job path the lookup waits for the full own list instead.
    // The info is returned as a CHAIN answer (chainAnswer): its
    // formats carry no vcodec/acodec/height, so buildFormats would
    // collapse all 10 video rows into one "Best quality" row with id
    // "undefined" and pair them into merged ids chainStreamUrl cannot
    // resolve — lookupInfo returns chain answers as-is, like ytChain.
    // skipProgRescue: the android rescue (fetchAndroidProg, 12s cap)
    // would block this ~2.5s answer for 12s on Render and its itag-18
    // URL is IP-bound anyway (unplayable in the browser); the
    // progressive format arrives via the upgrade job instead.
    const chocFastP = (async () => {
      if (!fastPartial || !chocPrefetchOpt) return new Promise(() => {});
      const r = await chocPrefetchOpt;
      if (!r || !Array.isArray(r.formats) || !r.formats.length) return new Promise(() => {});
      // YT-LONG FULL LIST (2026-11-26): YT-A now returns the FULL list
      // itself (8 merged mp4s with sound + audio), which is the better
      // first list (with sound, not partial) than choc's video-only
      // list. Give YT-A a 1.5s grace to land after choc before
      // settling: YT-A (~2s) usually lands inside it, so the first
      // list is YT-A's full list; when YT-A is down/slow the grace
      // expires and choc settles alone. The grace is ONE-SIDED (only
      // chocFastP waits) so the two sides can never deadlock — YT-A
      // settles the moment it resolves.
      if (ydPrefetchOpt) {
        const ydWon = await Promise.race([
          ydPrefetchOpt.then((x) => (x && Array.isArray(x.formats) && x.formats.length) ? 'yd' : 'no'),
          new Promise((ok) => setTimeout(() => ok('grace'), 1500)),
        ]).catch(() => 'no');
        if (ydWon === 'yd') return new Promise(() => {}); // YT-A wins — ydFastP settles it
      }
      // Settles the moment choc resolves (no grace — the grace lives
      // one-sided in chocFastP so the two sides can never deadlock).
      return { info: { ...r, chainAnswer: true }, clientArgs: null, viaProxy: false, partial: true, skipProgRescue: true };
    })();
    // Two passes: direct egress first, then the WARP proxy. Direct
    // first, so a host whose own IP works never hides behind the
    // proxy; the proxy only runs when direct fails.
    // The passes run as runOwnPasses(), RACED against the mirror (see
    // below): the first FULL list wins. A pass that only ever yields
    // a degraded list resolves null — the best degraded list is kept
    // in ownFallback and returned only when no side produced a full
    // list at all. A geo-block still throws out of the passes and
    // rejects the race at once (fail fast, no other lane can help).
    const runOwnPasses = async () => {
    const passes = [{ allowProxy: false, timeout: 9000 }, { allowProxy: true, timeout: 12000 }];
    for (let pi = 0; pi < passes.length; pi++) {
      const pass = passes[pi];
      // YT-LONG FIX (2026-11-26): on the JOB path (fastPartial false)
      // skip the WARP pass once the direct pass produced nothing. The
      // live job took ~105s (direct 45s + WARP 60s) and still returned
      // 1 format — the WARP egress (Cloudflare datacenter IP) is
      // blocked for YouTube exactly like Render's own IP, so the pass
      // burns 60s for nothing; the ytChain union is the job's answer.
      // A geo-blocked video never reaches here (the probe throws
      // first), so the WARP pass loses no geo coverage. The SYNC path
      // keeps the WARP pass (bounded by the 25s cap).
      if (pi === 1 && !fastPartial) return null;
      for (const args of clients) {
        // The lookup already answered (a fast partial side settled the
        // race): do not start another client for it — the in-flight
        // client still runs to its own cap, but nothing new spawns.
        if (raceSettled || ownDegradedFired) return null;
        // Geo probe answered while a client was running? Fail fast —
        // no other client, mirror or proxy pass in THIS region can read
        // the video, so waiting out the pass only burns the 25s cap.
        if (geoProbeBlocked) geoThrow();
        try {
          // Race the client against the geo probe: if the probe says
          // blocked while the client is still running, fail fast
          // (~probe time) instead of waiting out the 9s client timeout.
          // The geo side resolves with { geo: true } (never rejects),
          // so no unhandled rejection if the client wins and the probe
          // answers later. The yt-dlp process keeps running in the
          // background in that case and is killed by its own timeout.
          const raced = await Promise.race([
            ytdlpJson(url, pass.timeout, args, pass.allowProxy).then((info) => ({ info })),
            geoWatch.then(() => ({ geo: true })),
          ]);
          if (raced.geo) geoThrow();
          const info = raced.info;
          // The probe may have resolved while this client was running.
          if (geoProbeBlocked) geoThrow();
          const cand = { info, clientArgs: args, viaProxy: pass.allowProxy };
          if (!isDegradedInfo(info)) return cand;
          // Degraded list only (e.g. Android returning just format 18):
          // on the SYNC path it settles the lookup at once as partial
          // (fireOwnDegraded above) instead of waiting behind the rest
          // of the sequence — the fuller list arrives via the silent
          // upgrade. On the JOB path it is only a fallback (the job
          // waits for the full list). Keep the best degraded either way.
          if (!ownFallback || infoScore(info) > infoScore(ownFallback.info)) ownFallback = cand;
          if (isDegradedInfo(info)) fireOwnDegraded(cand);
        } catch (e) {
          lastDetail = (e && e.detail) || '';
          // Either geo signal fails fast: the probe (above), or the
          // client's own stderr — yt-dlp does print the geo reason
          // when it gets that far ("This video is available in ...").
          if (geoProbeBlocked || isGeoBlocked(lastDetail)) geoThrow();
        }
      }
      // Geo-block: no other client, mirror or proxy pass in THIS region
      // can read the video — the restriction is the region itself. Stop
      // here (fast) so the frontend can retry another region instead of
      // burning the WARP pass and timing out on a generic error. The
      // probe is checked first: it answers in ~2s, while the clients'
      // geo text often never surfaces at all (429-killed with empty
      // stderr).
      if (await probeGeo) geoThrow();
      if (isGeoBlocked(lastDetail)) geoThrow();
    }
    // Both passes ran without a full list: no full own result.
    return null;
    };
    // FIRST-SUCCESS RACE (YouTube speed fix 2026-11-25): the mirror
    // and the own passes run in parallel and the first FULL list
    // wins, with a 500ms grace for a fuller second result. A degraded
    // mirror answer (the only kind the surviving Piped host returns
    // for this video) never settles the race — it waits as a fallback.
    // Order when nothing is full: best degraded (own or mirror) >
    // error. The old code used the mirror only after both passes
    // failed (5 clients x 9s + 5 x 12s nominal), so a mirror that
    // answered in ~2s was never reached inside the 25s cap.
    // FAST FIRST RENDER: the race below is itself raced against the
    // fast-partial sides — mirrorDegradedP (degraded mirror within
    // ~3s of the lane start), ownDegradedP (degraded android itag 18
    // the moment it lands) and ydFastP (pre-started YT-A resolve) —
    // each returns at once (partial: true) instead of waiting out the
    // own passes; the frontend then upgrades it in place via a
    // background job. The partial sides only settle on the SYNC path
    // (fastPartial): on the JOB path they never resolve, so the job
    // waits for the full list and the upgrade can actually deliver one.
    const winner = await Promise.race([
      raceFirstFull([
        runOwnPasses(),
        mirrorFullP,
      ], 500),
      mirrorDegradedP,
      ownDegradedP,
      ydFastP,
      chocFastP,
    ]);
    raceSettled = true;
    // PREVIEW SOUND (2026-11-25): the winner's list can be DASH-only
    // (yt-dlp pairs "133+140" carry only a video-only URL), so
    // previewUrl() picks a silent stream while the quality is labelled
    // "With sound" (the pair's audio lives in a separate file). A
    // progressive (video+audio) format must be prepended so the
    // preview has sound — and it also appears as a real extra quality
    // in the list (a real file with sound, not a fake entry).
    // DIAGNOSIS (2026-11-25, video 2ptQ0Z1deuA): the prepend missed
    // because NEITHER source had a progressive format in hand — the
    // own default client returned a FULL list (53 formats, zero
    // progressive, no format 18 at all), so the android client never
    // ran and ownFallback stayed null; and the Piped mirror answered
    // 500 (SignInConfirmNotBot / LOGIN_REQUIRED), so mirrorBest was
    // null too. The winner's previewUrl then fell through to the
    // highest direct video-only stream (itag 315/401, silent). The
    // android client DOES return itag 18 (360p, avc1+mp4a) for this
    // video when run directly — so the third source below runs one
    // bounded android pass when nothing in hand has a progressive
    // format. Sources, in order: the own android fallback (itag 18)
    // if it already ran, else the mirror result (Piped progressive
    // videoStreams) — mirrorDone is awaited here, but it started in
    // parallel with the race and carries a 9s cap, so by the time a
    // slow own-passes winner resolves it has already settled — else
    // a single android-client pass (12s cap, direct egress only).
    // If no source yields a progressive stream, the preview ships
    // as-is (never a faked with-sound preview).
    const findProg = (list) => (Array.isArray(list) ? list : [])
      .filter((f) => f && f.url && isDirectFileUrl(f.url) && !isManifestFormat(f) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
      .sort((a, b) => ((b.height || heightFromUrl(b.url) || 0) - (a.height || heightFromUrl(a.url) || 0)))[0] || null;
    const hasProgFormat = (list) => (Array.isArray(list) ? list : [])
      .some((f) => f && f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
    // The android rescue must use the SAME egress as the winning pass
    // (2026-11-25 fix): on Render the direct egress is blocked for
    // YouTube and only the WARP proxy answers — the old code hardcoded
    // direct egress, so the rescue failed live and the preview fell
    // through to a silent video-only itag (315) even though the android
    // client returns itag 18. allowProxy comes from the winner's
    // viaProxy (the egress that proved to work for this video).
    const fetchAndroidProg = async (allowProxy) => {
      if (geoProbeBlocked) geoThrow();
      try {
        const raced = await Promise.race([
          ytdlpJson(url, 12000, ['--extractor-args', 'youtube:player_client=android'], allowProxy).then((info) => ({ info })),
          geoWatch.then(() => ({ geo: true })),
        ]);
        if (raced.geo) geoThrow();
        if (geoProbeBlocked) geoThrow();
        return findProg(raced.info && raced.info.formats);
      } catch (e) {
        if (e && e.geoBlocked) throw e;
        return null;
      }
    };
    // Prepend the best progressive format found in any source to a
    // format list that has none. Returns the (possibly new) list.
    const ensureProgressive = async (formats, allowProxy) => {
      if (hasProgFormat(formats)) return formats;
      let prog = (ownFallback && ownFallback.info) ? findProg(ownFallback.info.formats) : null;
      if (!prog) {
        await mirrorDone;
        if (mirrorBest && mirrorBest.info) prog = findProg(mirrorBest.info.formats);
      }
      if (!prog) prog = await fetchAndroidProg(allowProxy);
      return prog ? [prog, ...formats] : formats;
    };
    // LIMITED LIST (speed fix 2026-11-25, merge review): a winner that
    // arrives via the slow path can still be a thin list — e.g. the
    // android client's handful of formats, or the mirror's list when
    // it lands after the 3s fast deadline and raceFirstFull accepts
    // it as "full" (isDegradedInfo only catches lists with zero
    // video-only AND zero audio-only formats, so a thin list that
    // happens to hold one of each passes as full). A full own list
    // has 20+ formats up to 1080p/2160p; a thin list has < 8 formats
    // and/or tops out below 720p. Marking such a list partial is safe:
    // the frontend upgrades it silently, and if the job finds nothing
    // fuller the list simply stays (upgradeSwap only swaps a strictly
    // longer list). Without this, a slow-path thin list would never
    // upgrade and the video's higher qualities would never appear.
    const isLimitedList = (formats) => {
      const list = Array.isArray(formats) ? formats : [];
      if (list.length < 8) return true;
      let maxH = 0;
      for (const f of list) {
        const h = (f && (f.height || heightFromUrl(f.url))) || 0;
        if (h > maxH) maxH = h;
      }
      return maxH < 720;
    };
    if (winner) {
      const wf = Array.isArray(winner.info && winner.info.formats) ? winner.info.formats : [];
      // YT-LONG FIX: a chain winner (choc) skips the progressive
      // rescue — the android pass would cost 12s on Render and its
      // itag-18 URL is IP-bound (no playable preview from it); the
      // progressive format + relay arrive via the upgrade job.
      winner.info.formats = winner.skipProgRescue ? wf : await ensureProgressive(wf, winner.viaProxy);
      if (!winner.partial && isLimitedList(winner.info.formats)) winner.partial = true;
      return winner;
    }
    await mirrorDone;
    if (mirrorBest && (!ownFallback || infoScore(mirrorBest.info) > infoScore(ownFallback.info))) ownFallback = mirrorBest;
    if (ownFallback) {
      const of = Array.isArray(ownFallback.info && ownFallback.info.formats) ? ownFallback.info.formats : [];
      ownFallback.info.formats = await ensureProgressive(of, ownFallback.viaProxy);
      if (isDegradedInfo(ownFallback.info) || isLimitedList(ownFallback.info.formats)) ownFallback.partial = true;
      return ownFallback;
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
    // Instagram: PLAIN ONLY (speed fix 2026-11-25, measured): the
    // iPhone-UA attempt hard-fails at the extractor level ("Instagram
    // sent an empty media response") and retries internally, so it can
    // never win — it only starves the plain attempt past the 14s cap
    // on a weak host (0/2 as a doubled leg, 13.4s solo).
    : isInstagram(url)
      ? [[]]
    : [
        [],
        ['--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
      ];
  const isTumblr = clientSideKey(url) === 'tumblr';
  const rounds = isTikTok(url)
    // Round 1 is 13s, not 8s: yt-dlp needs ~11s to print "No video
    // formats found" for a streamless video (measured 2026-11-24),
    // and the 8s kill truncated it before the verdict existed — so
    // the no-stream path could never fire inside the 25s cap (the
    // WARP round then ran and the outer cap fired first). 13s lets
    // the verdict print in round 1, so the no-formats early-throw
    // skips round 2 and the verdict lands at ~17s. A round that
    // fails fast (blocked) still ends fast — the cap only bites
    // when an attempt hangs.
    ? [{ allowProxy: false, timeout: 13000 }, { allowProxy: true, timeout: 12000 }]

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
      // No-formats early exit: Promise.any only rejects when the LAST
      // attempt fails, so one slow client (the api-hostname variants
      // hang to their 13s kill) held the round open even after another
      // client had already proved the video has no stream — and the
      // verdict then landed after the 25s outer cap. Race the round
      // against the FIRST no-formats failure instead: the verdict is a
      // property of the video (every client queries the same aweme),
      // so a client that finds formats would already have resolved
      // (finding formats takes ~5-10s, this verdict ~11s) — waiting
      // for the stragglers cannot change the answer.
      let noFormatsReject;
      const noFormatsP = new Promise((_, rej) => { noFormatsReject = rej; });
      const attemptPs = attempts.map((args) => {
        const p = tag(ytdlpJson(url, round.timeout, args, round.allowProxy), args);
        p.catch((e) => { if (isNoFormats(e.detail)) noFormatsReject(e); });
        return p;
      });
      const res = await Promise.race([Promise.any(attemptPs), noFormatsP]);
      res.viaProxy = round.allowProxy;
      return res;
    } catch (e) {
      lastErr = e;
      // Geo-block: the WARP round cannot help — the restriction is the
      // region, not the IP. Fail fast so the frontend can try another
      // region inside its per-origin budget.
      const d = (e && e.errors && e.errors.map((x) => x && x.detail).filter(Boolean).join(' | ')) || (e && e.detail) || '';
      if (isGeoBlocked(d)) throw wrapErr(e);
      // No formats: the video itself has no stream — the WARP round cannot
      // help (same video, same empty aweme, different IP). Fail fast so
      // the no-stream verdict reaches /api/info inside its 25s budget
      // instead of burning the second round and timing out.
      if (isNoFormats(d)) throw wrapErr(e);
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
// oEmbed (public, no login): YouTube, Vimeo, Reddit — the platforms' own
// metadata endpoints, not downloader services. TikTok's oEmbed was
// tested 2026-11-24 on two videos — it returns NO title and NO
// thumbnail_url, so TikTok's preview comes from the og scrape of
// TikTok's own page (tikwm used to fill this gap; removed 2026-11-24
// under the own-first rule — /api/meta is preview-only, so a missing
// preview never breaks a download). Facebook's oEmbed endpoint is
// deprecated (400) and Instagram has no public oEmbed, so their
// previews come from /api/info (yt-dlp, ~1s warm) and the frontend
// shows that result the moment it arrives.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // Numeric entities (hex &#xb7; and decimal &#183;) — Facebook
    // titles arrive with them (&#xb7; for ·, &#x1f431; for the cat
    // emoji). Without this, stripTitleCounts cannot match the ·
    // separator and the view/reaction counts stay in the title.
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; } });
}

// TITLE CLEANER (2026-11-25, user rule): a video's displayed title must
// be ONLY the title — no view/reaction/like/comment/share counts.
// Platforms (notably Facebook) prefix the page title with engagement
// counts: "79K views · 438K reactions | SWITZERLAND in winter...".
// Strip count segments (number + unit) at the start, at the end, and
// between separators. A bare word like "view" with no number is NOT
// stripped ("A view from the top" stays intact) — only the count
// pattern (number + unit) goes. A leading/trailing count is stripped
// only when a separator, another count, or the end follows it, so a
// sentence like "10 views of the valley" survives. If nothing is
// stripped, the input is returned byte-identical.
function stripTitleCounts(t) {
  var s = String(t || '').trim();
  if (!s) return '';
  var orig = s;
  // One count segment: "79K", "1.2M", "79,123", "500" + a unit.
  var num = '\\d[\\d,]*?(?:\\.\\d+)?\\s*[KMB]?';
  var unit = '(?:views?|reactions?|likes?|comments?|shares?)';
  var sep = '[·•|:\\-–—]';
  // Middle: a count segment sandwiched between separators.
  var mid = new RegExp('\\s*' + sep + '\\s*' + num + '\\s*' + unit + '(?=\\s*' + sep + ')', 'gi');
  s = s.replace(mid, '');
  // Leading: count segments at the start, one after another.
  var lead = new RegExp('^\\s*(?:' + num + '\\s*' + unit + '\\s*,\\s*)*' + num + '\\s*' + unit + '(?=\\s*(?:' + sep + '|\\d|$))\\s*(?:' + sep + '\\s*)?', 'i');
  while (lead.test(s)) s = s.replace(lead, '');
  // Trailing: "(10K reactions)" or " | 500K likes" / " - 2.3M views".
  var trailParen = new RegExp('\\s*\\(\\s*' + num + '\\s*' + unit + '\\s*\\)\\s*$', 'i');
  var trailSep = new RegExp('\\s*' + sep + '\\s*' + num + '\\s*' + unit + '\\s*$', 'i');
  var before;
  do {
    before = s;
    s = s.replace(trailParen, '').replace(trailSep, '');
  } while (s !== before);
  // Whole title is only a count ("500K likes") — nothing is left.
  if (new RegExp('^\\s*' + num + '\\s*' + unit + '\\s*$', 'i').test(s)) s = '';
  if (s === orig) return s;
  // Tidy only when something was stripped: collapse spaces, drop a
  // separator left dangling at an edge.
  s = s.replace(/\s{2,}/g, ' ').replace(/^[·•|:\-–—]\s*/, '').replace(/\s*[·•|:\-–—]$/, '').trim();
  return s;
}

// Response-door cleaner: every /api/info + /api/job body passes through
// here, so a lane that returns its own title directly (fbChain, ytChain,
// mirrors, ytdlpDirectFallback) is cleaned even though it never touches
// the result assembly below. Also stamps the TITLE PROVENANCE default:
// a body no lane tagged is original by construction (yt-dlp own, page
// scrape, oEmbed, platform-API lanes); third-party lanes tag
// 'third-party' at their return points.
function cleanBodyTitle(body) {
  if (!body || typeof body.title !== 'string') return body;
  // COLD-LINK FIX (2026-11-26): decode entities BEFORE stripping
  // counts, so a title like "1.7M views &#xb7; 10K reactions |
  // Funny cats…" is cleaned on the FIRST render instead of showing
  // dirty and cleaning up seconds later.
  body.title = stripTitleCounts(decodeEntities(body.title)) || 'Video';
  if (!body.titleOrigin) body.titleOrigin = 'original';
  return body;
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
    const title = stripTitleCounts(decodeEntities(
      metaContent(html, 'name', 'parsely-title').replace(/ – @\S+ on Tumblr$/, '') ||
      ogTag(html, 'og:title') ||
      ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '')));
    const img = metaContent(html, 'name', 'parsely-image-url') || ogTag(html, 'og:image');
    // Kuaishou's shell page (served when the cookie set is missing or
    // the fetch is slow) carries the generic site <title> "短视频-快手"
    // — that is not the video's title, so treat it as no preview
    // rather than flash the wrong name; Stage 2 renders the real one.
    if (clientSideKey(url) === 'kuaishou' && title === '短视频-快手') return null;
    // Error/block pages (Facebook serves one to datacenter IPs) carry a
    // junk <title> like "Error" — that is not the video's title, so
    // treat it as no preview rather than flash "Error" as the video's
    // name; Stage 2 renders the real title when the info lands.
    const junkTitle = String(title || '').trim().toLowerCase();
    if (junkTitle === 'error' || junkTitle === 'something went wrong' ||
        junkTitle === 'page not found' || junkTitle === 'not found' ||
        junkTitle === '404 not found' || junkTitle === 'access denied' ||
        junkTitle === 'forbidden' || junkTitle === 'unavailable' ||
        /^error\s*[|\-–—]/.test(String(title || '').trim())) return null;
    if (title || img) return { title: title || 'Video', thumbnail: img, uploader: ogTag(html, 'og:site_name') || '', duration: 0 };
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
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    jobs.push(oembedMeta('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url), 2500));
  }
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
    jobs.push(oembedMeta('https://www.reddit.com/oembed?url=' + encodeURIComponent(url), 2500));
  }
  if (isTikTok(url)) {
    // TikTok meta (2026-11-25, verified): the page scrape is useless
    // for TikTok — datacenter IPs get a shell page ("TikTok - Make
    // Your Day", no og:title, no og:image), so meta 404'd or returned
    // the generic title with an EMPTY thumbnail, and TikTok's oEmbed
    // carries no thumbnail_url either. The preview's real title +
    // cover come from SSSTik's poster instead (~2.7s, inside the 4s
    // meta budget). Deduped with the info race's SSSTik call (see
    // ssstikInfo), so the parallel meta+info fire costs one POST.
    // The og leg is skipped for TikTok: its generic title is worse
    // than no preview (the info answer carries the real title).
    jobs.push(ssstikInfo(url, 3500).then((info) => {
      if (!info || !info.thumbnail) return null;
      return { title: info.title || 'Video', thumbnail: info.thumbnail, uploader: info.uploader || '', duration: info.duration || 0 };
    }).catch(() => null));
  } else {
    jobs.push(ogScrapeMeta(url, 3500));
  }
  // First non-null answer wins; give up after 4s so /api/meta never
  // keeps the preview waiting. Every job swallows its own errors.
  const out = await Promise.race([
    Promise.any(jobs.map((j) => j.then((v) => { if (!v) throw new Error('no meta'); return v; }))).catch(() => null),
    new Promise((ok) => setTimeout(() => ok(null), 4000)),
  ]);
  if (out) {
    // Title cleaner: oEmbed/SSSTik titles can also carry engagement
    // counts — strip them before the meta is cached and returned.
    out.title = stripTitleCounts(out.title) || 'Video';
    // TITLE PROVENANCE: TikTok's meta comes from SSSTik (a third-party
    // resolver); every other meta comes from the platform's own page
    // (og scrape) or its own oEmbed — original.
    out.titleOrigin = isTikTok(url) ? 'third-party' : 'original';
    cacheSet('meta:' + url, out);
  }
  return out;
}
// ---- YouTube via public Invidious / Piped mirrors (fallback) ---------------
// Render's IP is bot-checked by YouTube, so when yt-dlp fails we ask public
// mirrors that keep their own YouTube access. Each attempt is short (5s) and
// fail-safe: a dead mirror just means "try the next one". Hosts are
// configurable via INVIDIOUS_HOSTS / PIPED_HOSTS (comma-separated) for tests.
// MIRROR HEALTH (measured 2026-11-25 from this machine, video Bgou81ffn5U):
// every listed Invidious host was dead — invidious.privacyredirect.com
// empty reply in 2.4s, yewtu.be 403 in 2.2s, inv.nadeko.net 403 in 1.9s
// (extra candidates iv.melmac.space / vid.puffyan.us / invidious.0011.lt /
// yt.ahwx.org also dead) — and of the Piped hosts only
// api.piped.private.coffee answered 200 (2.4s, 22 KB, but only the
// progressive 360p itag-18 stream for this video: a DEGRADED result, so
// it can only ever be a fallback, never the race winner — see
// isDegradedInfo). kavin.rocks + libre both timed out at 6s, leptons.xyz
// 502, projectsegfau.lt "Piped has shutdown", adminforge.de 403,
// reallyaweso.me 502, smnz.de timeout. Dead hosts are DROPPED from the
// defaults: each one cost up to 5s of the 9s mirror budget while the
// working host waited behind it. This machine's egress is not Render's,
// so a host dropped here could in principle answer from Render — the
// env vars above restore any host without a code change.
const INVIDIOUS_HOSTS = (process.env.INVIDIOUS_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PIPED_HOSTS = (process.env.PIPED_HOSTS || 'https://api.piped.private.coffee').split(',').map((s) => s.trim()).filter(Boolean);

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
      // Adaptive-only answers count too (speed fix 2026-11-25): the
      // only working Invidious host returns 16-32 adaptiveFormats
      // with formatStreams [] — the old formatStreams-only check
      // discarded the richest answer available. invidiousToInfo
      // builds video rows from the adaptive set when there is no
      // progressive stream.
      if (j && ((Array.isArray(j.formatStreams) && j.formatStreams.length) || (Array.isArray(j.adaptiveFormats) && j.adaptiveFormats.length))) return j;
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
      format_id: 'yt-' + (s.itag || heightOf(s.quality)),
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
  // Adaptive-only host (speed fix 2026-11-25): no progressive stream
  // exists, so build video-only rows from adaptiveFormats (direct
  // googlevideo URLs) + the best audio below. Without this an
  // adaptive-only answer would surface as audio-only.
  if (!formats.length) {
    for (const s of (j.adaptiveFormats || [])) {
      if (!s || !s.url) continue;
      const t = String(s.type || '');
      if (!(t.startsWith('video/') || t === 'video')) continue;
      const cont = String(s.container || (t.includes('webm') ? 'webm' : 'mp4')).toLowerCase();
      const enc = (t.match(/codecs="([^,"]+)/) || [])[1] || s.encoding || 'avc1';
      formats.push({
        format_id: 'yt-' + (s.itag || heightOf(s.qualityLabel || s.quality)),
        ext: cont,
        height: s.height || heightOf(s.qualityLabel || s.quality),
        width: s.width || 0,
        fps: s.fps || 0,
        vcodec: enc,
        acodec: 'none',
        url: s.url,
        filesize: s.size || 0,
        filesize_approx: s.size || 0,
        tbr: s.bitrate ? s.bitrate / 1000 : 0,
      });
    }
  }
  let bestAudio = null;
  for (const s of (j.adaptiveFormats || [])) {
    // The type is a full MIME string ('audio/mp4; codecs="mp4a..."'),
    // never the bare word 'audio' — the old `s.type !== 'audio'`
    // check skipped every entry, so no audio row was ever built.
    if (!s || !s.url) continue;
    const t = String(s.type || '');
    if (!(t.startsWith('audio/') || t === 'audio')) continue;
    if (!bestAudio || (s.bitrate || 0) > (bestAudio.bitrate || 0)) bestAudio = s;
  }
  if (bestAudio) {
    formats.push({
      format_id: 'yt-audio',
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
      format_id: 'yt-' + (s.itag || heightOf(s.quality)),
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
      format_id: 'yt-audio',
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

// PIPED PROXY LIVENESS (2026-11-26): the Piped API answers but its
// video proxy (proxy.piped.private.coffee/videoplayback) 403s globally
// — the googlevideo signature is bound to the proxy's own IP, so the
// file plays/downloads for nobody (measured: 403 from this VM and
// from a real browser; the proxy thumbnail still answers 200, so the
// host is up and only videoplayback is dead). Probe the first video
// URL (Range 0-0, 2s cap, Chrome UA): alive only on 200/206.
async function pipedProxyAlive(info) {
  const f = (info && info.formats || []).find((x) => x && x.url && isDirectFileUrl(x.url));
  if (!f) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(f.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Range: 'bytes=0-0',
      },
    });
    clearTimeout(timer);
    const alive = r.status === 200 || r.status === 206;
    try { await r.arrayBuffer(); } catch {}
    return alive;
  } catch { return false; }
}

async function mirrorInfo(url) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const [inv, pip] = await Promise.all([invidiousInfo(vid), pipedInfo(vid)]);
  if (inv) return invidiousToInfo(inv);
  if (pip) {
    const info = pipedToInfo(pip);
    // Do not offer a dead format: if the Piped proxy refuses the
    // file, treat Piped as dead so the lookup falls through to the
    // chain (YT-A) or the honest error — never a dead play button
    // and a 403 save page.
    if (info && await pipedProxyAlive(info)) return info;
    return null;
  }
  return null;
}

async function mirrorStreamUrl(url, formatId) {
  const vid = youtubeId(url);
  if (!vid) return null;
  const wantAudio = formatId.endsWith('-audio');
  const itag = wantAudio ? '' : formatId.slice(3);
  // Unified 'yt-' prefix (invisibility): the id no longer says which
  // mirror produced it, so try Invidious first, then Piped — the same
  // YouTube itag on either mirror is the same file.
  const fromInv = async () => {
    const j = await invidiousInfo(vid);
    if (!j) return null;
    if (wantAudio) {
      let best = null;
      for (const s of (j.adaptiveFormats || [])) {
        // Type is a full MIME string, never bare 'audio' (see
        // invidiousToInfo) — match the prefix.
        if (s && String(s.type || '').startsWith('audio/') && s.url && (!best || (s.bitrate || 0) > (best.bitrate || 0))) best = s;
      }
      return best ? best.url : null;
    }
    for (const s of (j.formatStreams || [])) {
      if (s && String(s.itag) === itag && s.url) return s.url;
    }
    // Adaptive-only host: the itag lives in adaptiveFormats instead
    // (direct googlevideo URL — the visitor's browser fetches it;
    // a server-side fetch may 403 on a stale signature, in which
    // case the honest 502 below stands).
    for (const s of (j.adaptiveFormats || [])) {
      if (s && String(s.itag) === itag && s.url) return s.url;
    }
    return null;
  };
  const fromPip = async () => {
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
  };
  return (await fromInv()) || (await fromPip());
}

// Prefer widely playable codecs: h264 first, then vp9, then av1.
function codecRank(vcodec) {
  const v = String(vcodec || '').toLowerCase();
  if (v.includes('avc1') || v.includes('h264')) return 0;
  if (v.includes('vp09') || v.includes('vp9')) return 1;
  if (v.includes('av01') || v.includes('av1')) return 2;
  return 3;
}

// 1 for a direct file (https), 0 for an HLS/DASH playlist — used as a
// selection tier so a playlist never beats the same stream as a file.
function protoRank(f) {
  const proto = String((f && f.protocol) || '').toLowerCase();
  return (!proto.includes('m3u8') && !proto.includes('dash')) ? 1 : 0;
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

// 1-SECOND START (2026-11-25): a direct file URL the visitor's browser
// can be REDIRECTED to — a plain public CDN file. googlevideo URLs are
// signed for the egress IP that minted them (and carry an ip= tag), so
// redirecting one hands the visitor a 403; those are never redirected
// and fall through to the server stream paths below. Piped-proxy URLs
// are safe (the proxy fetches googlevideo itself).
function isRedirectSafeUrl(u) {
  if (!isDirectFileUrl(u)) return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h === 'googlevideo.com' || h.endsWith('.googlevideo.com')) return false;
    // Piped proxy (2026-11-26): its videoplayback URL 403s globally,
    // so a 302 to it lands the visitor on an error page. Never
    // redirect there — fall through to the format branch, which
    // re-resolves and relays (or answers with a clear message).
    if (h.includes('piped')) return false;
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
  let bestAudioDrc = null; // DRC duplicate, only if no plain audio exists

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
      // Direct https file beats an HLS/DASH playlist of the same height:
      // the playlist's tbr is inflated (same pixels, slower segment
      // download), so protocol is a tier above the score.
      const key = protoRank(f) * 1e12 + score;
      if (!cur || key > cur._key) byHeight.set(h, { ...f, _key: key });
    } else if (v && !a && h > 0) {
      const cur = videoOnly.get(h);
      const rank = codecRank(f.vcodec);
      // (3 - rank): codecRank numbers h264=0, vp9=1, av1=2 — LOWER is
      // better (buildDirectFormats does the same). The old line used
      // rank directly, so AV1 beat VP9 beat h264 and every merged row
      // shipped AV1 video in an .mp4 — the least compatible file.
      // h264 first (plays everywhere), then vp9, then av1. Within one
      // codec, a direct https file beats an HLS/DASH playlist (same
      // pixels, single file, faster download).
      const key = (3 - rank) * 1e15 + protoRank(f) * 1e12 + score;
      if (!cur || key > cur._key) videoOnly.set(h, { ...f, _key: key });
    } else if (!v && a) {
      // Skip DRC (dynamic-range-compressed) duplicates: same bitrate as
      // the plain variant, different sound. Only used if no plain audio
      // exists at all.
      const fid = String(f.format_id || '');
      if (fid.endsWith('-drc')) {
        if (!bestAudioDrc) bestAudioDrc = f;
      } else {
        // Bitrate first (real quality), direct-file second (tiebreak).
        const key = (f.abr || 0) * 10 + protoRank(f);
        if (!bestAudio || key > bestAudio._key) bestAudio = { ...f, _key: key };
      }
    }
  }
  if (!bestAudio) bestAudio = bestAudioDrc;

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
  // FACEBOOK (2026-11-25): Facebook serves video and audio as SEPARATE
  // files — its hd/sd video files are video-only (ffprobe-proven twice:
  // preview AV1, HD h264 and SD h264 all carry no audio stream, and no
  // audio format is ever returned on Render). The old code asserted
  // hasAudio:true + "With sound" for them, which is false. For Facebook
  // only, unknown-codec formats are video-only; the sound, when it
  // exists, is the separate m4a (bestAudio → merged pairs / Audio only).
  const fbVideoOnly = !!(opts && opts.facebookVideoOnly);
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
      hasAudio: fbVideoOnly ? false : true,
      url: f.url || '',
      filesize: f.filesize || f.filesize_approx || 0,
      note: fbVideoOnly ? 'Video only' : 'With sound',
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
  return { title, thumbnail: thumb, duration: 0, uploader: blog, previewUrl: video, formats: [directFormat(video)] };
}

async function scrapeDirectInfo(url) {
  const key = clientSideKey(url);
  if (key === 'tumblr') return scrapeTumblr(url);
  const html = await fetchPageHtml(url);
  if (!html) {
    // The page did not load at all — distinguish "post removed"
    // (404/410) from a slow/blocked fetch, so a removed post fails
    // fast with a clear message instead of burning the yt-dlp rounds.
    // The probe runs ONLY on this failure path, so live posts cost
    // nothing extra. A 403/challenge or a timeout is NOT dead — the
    // fallbacks below may still read the video.
    if (key === 'sharechat' || key === 'pinterest') {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(url, { signal: ctrl.signal, method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } });
        clearTimeout(timer);
        if (r.status === 404 || r.status === 410) return { dead: true };
      } catch { /* fall through to the fallbacks */ }
    }
    return null;
  }
  // Soft-404: a removed ShareChat post sometimes answers 200 (Render
  // IPs) with a "Page Not Found" page instead of 410 — the scrape below
  // then finds no video and the chain burns the yt-dlp rounds before a
  // 25s 502. Catch it from the page itself so the lookup fails fast
  // with the removed-post message. A live post never carries this
  // title (verified: dead page "<title>Page Not Found</title>", live
  // post a real video title, 0 "no longer available" hits).
  if (key === 'sharechat' && /<title>\s*Page Not Found\s*<\/title>/i.test(html)) return { dead: true };
  const title = stripTitleCounts(decodeEntities(ogTag(html, 'og:title')));
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
    return { title: title || 'Pinterest video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: mp4s[0], formats: [directFormat(mp4s[0])] };
  }
  if (key === 'moj') {
    // og:video IS the requested video's direct mp4.
    const video = decodeHtmlEntities(ogTag(html, 'og:video'));
    if (!video || !video.includes('.mp4')) return null;
    return { title: title || 'Moj video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: video, formats: [directFormat(video)] };
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
    return { title: title || 'ShareChat video', thumbnail: thumb, duration: 0, uploader: '', previewUrl: video, formats: [directFormat(video)] };
  }
  if (key === 'snapchat') {
    // og:video is the direct file on Snapchat's CDN (yt-dlp's extractor
    // cannot read the page's Next.js data, so the scrape is the route).
    // og:title is engagement text ("47.5K likes…"), so the title comes
    // from <title> and the uploader from the @handle in og:title.
    const video = decodeHtmlEntities(ogTag(html, 'og:video'));
    if (!video || !video.includes('sc-cdn.net')) return null;
    const titleTag = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
    const cleanTitle = stripTitleCounts(decodeEntities(titleTag).split(' | ')[0].trim()) || 'Snapchat video';
    const handle = (title.match(/@([A-Za-z0-9_.]+)/) || [])[1] || '';
    return { title: cleanTitle, thumbnail: thumb, duration: 0, uploader: handle, previewUrl: video, formats: [directFormat(video)] };
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
      // COLD-LINK FIX (2026-11-26): newer X posts embed the amplify
      // copy (/vid/avc1/320x568/) instead of ext_tw_video
      // (/vid/1280x720/). The old regex only matched the ext_tw_video
      // shape, so every amplify variant mapped to height 0 and the
      // byRes map collapsed all four resolutions into one "Best"
      // row (direct-0). Accept the optional avc1/ segment.
      const m = u.match(/\/vid\/(?:avc1\/)?(\d+)x(\d+)\//);
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
    return { title: title || 'X video', thumbnail: thumb, duration: Math.round(durMs / 1000) || 0, uploader: handle, previewUrl: formats[0].url, formats };
  }
  return null;
}

// Pinterest widget API (the platform's own public no-key API — the same
// data the pin page embeds, as ~6 KB of JSON instead of a 1.35 MB page).
// The pin page is challenged/slow from datacenter IPs (live 502 in
// 16.5s), while widgets.pinterest.com answers the same video URL. Own
// extraction, not a third-party resolver: it returns Pinterest's own
// video file. Picks the best mp4 from the pin's story pages (V_720P
// first) or its videos object; HLS (.m3u8) is skipped — the visitor
// downloads one mp4 file, never a playlist.
async function pinterestPidgetsInfo(url, timeoutMs = 8000) {
  const m = String(url || '').match(/pinterest\.com\/pin\/(\d+)/);
  let pinId = m ? m[1] : '';
  if (!pinId) {
    // pin.it short link: resolve the redirect to the canonical pin URL.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      clearTimeout(timer);
      const loc = r.headers.get('location') || '';
      pinId = (loc.match(/pinterest\.com\/pin\/(\d+)/) || [])[1] || '';
    } catch { return null; }
  }
  if (!pinId) return null;
  const j = await fetchJsonTimeout('https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=' + pinId, timeoutMs);
  const pin = j && Array.isArray(j.data) && j.data[0];
  if (!pin) return null;
  const mp4s = [];
  const takeList = (list) => {
    if (!list) return;
    for (const v of Object.values(list)) {
      const u = v && v.url;
      if (u && /\.mp4(\?|$)/i.test(u)) mp4s.push({ url: u, h: v.height || 0 });
    }
  };
  takeList(pin.videos && pin.videos.video_list);
  const pages = (pin.story_pin_data && pin.story_pin_data.pages) || [];
  for (const page of pages) for (const b of (page.blocks || [])) takeList(b.video && b.video.video_list);
  if (!mp4s.length) return null;
  mp4s.sort((a, b) => b.h - a.h);
  const video = mp4s[0].url;
  const title = (decodeEntities(pin.description || '').slice(0, 120)) || 'Pinterest video';
  const imgs = pin.images || {};
  const thumb = (imgs['564x'] && imgs['564x'].url) || (imgs['236x'] && imgs['236x'].url) || '';
  return { title, thumbnail: thumb, duration: 0, uploader: '', previewUrl: video, formats: [directFormat(video)] };
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
// Token warm-up (2026-11-25): the token fetch costs ~1.1-1.4s of the
// first TikTok paste after idle (cold), ~0s warm (10-min cache). The
// keep-alive ping keeps this process awake, so refresh the token every
// 8 min in the background and TikTok answers stay on the fast path.
// One cheap homepage GET per 8 min; a failure just leaves the old
// token (or none) and ssstikInfo fetches it lazily as before.
ssstikToken().catch(() => {});
setInterval(() => { ssstikToken().catch(() => {}); }, 8 * 60 * 1000).unref();
function ssstikDuration(s) {
  const m = String(s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}
// In-flight dedupe for SSSTik (2026-11-25): the frontend fires /api/meta
// and /api/info in parallel, and both now resolve TikTok through SSSTik
// — without dedupe the same link would POST twice at once (extra load
// on SSSTik, and a self-inflicted rate limit). Concurrent calls for one
// URL share a single fetch; the shared fetch runs at least 7s (the info
// race's cap) so a short-timeout caller cannot abort the leg the info
// race is waiting on — the caller just stops waiting at its own cap.
const ssstikInflight = new Map(); // url -> Promise
async function ssstikInfo(url, timeoutMs = 15000) {
  const existing = ssstikInflight.get(url);
  if (existing) return existing;
  const p = ssstikInfoFresh(url, Math.max(timeoutMs, 7000));
  ssstikInflight.set(url, p);
  const clear = () => { if (ssstikInflight.get(url) === p) ssstikInflight.delete(url); };
  p.then(clear, clear);
  return p;
}

async function ssstikInfoFresh(url, timeoutMs = 15000) {
  // SSSTik resolves any public TikTok URL — Series or normal — and
  // races alongside own extraction + tikwm in /api/info (speed fix
  // 2026-11-24); it is the only route that reads Series videos, so
  // for those it usually wins the race. Normal videos prefer tikwm
  // when tikwm answers first (3 formats vs SSSTik's single best).
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
          title: title || ('TikTok video' + (videoId ? ' ' + videoId : '')),
          thumbnail: posterM ? posterM[1] : '',
          duration: ssstikDuration(durM && durM[1]),
          uploader: authorM ? authorM[1].trim() : '',
          previewUrl: link[1],
          formats: [{ id: 'best', label: 'Best quality', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: link[1] }],
          // NO clientSide flag (2026-11-26): the flag routed the save
          // around the server relay (openTab to the tikcdn URL), so the
          // browser saved the CDN's filename (ssstik.io_....mp4) instead
          // of the original title. The relay names the file correctly.
          note: '',
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
async function resolveKuaishouShort(url, timeoutMs = 5000) {
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
async function kuaishouCookies(timeoutMs = 6000) {
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
async function kuaishouInfo(url, timeoutMs = 4000) {
  let id = kuaishouPhotoId(url);
  if (!id) {
    id = await resolveKuaishouShort(url);
    if (!id) return null;
  }
  // Kuaishou's edge intermittently HANGS the video page from datacenter
  // IPs (2026-11-24: two back-to-back 12 s stalls in one probe, while a
  // later fetch with the same cookies answered in 2 s) — a slow first
  // attempt used to burn the whole browser budget (12 s page cap, 2
  // attempts, a fresh cookie mint each time). Fail fast instead: mint the
  // cookie set ONCE (a page without the full kpf/kpn/clientid/did set
  // never carries this video's photo — verified: APOLLO present but
  // VisionVideoDetailPhoto absent), reuse it across attempts, cap each
  // page fetch at 4 s, 3 attempts with 2 s pauses. Worst case ~22 s
  // (inside the 25 s /api/info cap); a normal hit is mint (~1-3 s) +
  // page (~2-3 s) = 3-6 s, inside the browser's 10 s per-origin budget.
  // A parallel race was tested and does NOT help: the second concurrent
  // fetch errors (TypeError) while the first succeeds in ~2 s.
  const cookies = await kuaishouCookies();
  if (!cookies) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 2000));
    const out = await kuaishouInfoOnce(id, cookies, timeoutMs);
    if (out) return out;
  }
  return null;
}
async function kuaishouInfoOnce(id, cookies, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html = '';
  try {
    const r = await fetch('https://www.kuaishou.com/short-video/' + id, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': KUAISHOU_UA, 'Referer': 'https://www.kuaishou.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: cookies,
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
      title: j.title || 'Zhihu video',
      thumbnail: (v.thumbnail || v.cover_url || j.image_url || j.image_cover || '') ,
      duration: Math.round(Number(v.duration) || 0),
      uploader: (j.author && j.author.name) || '',
      previewUrl: formats[0].url,
      formats,
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---- Sohu (direct lane, no login) --------------------------------------
// Sohu PASSES through yt-dlp locally but FAILS live on Render: its
// yt-dlp extractor takes ~20 s per run while the browser aborts each
// origin at 10 s, so the visitor only ever sees "Taking too long"
// (live: 15.6-21.3 s — 200s, just too slow). This lane replicates the
// extractor's own HTTP flow in-process (yt-dlp 2026.10.26
// extractor/sohu.py), which is ~3x faster. No login anywhere, no token
// needed. Verified 2026-11-24 (see PART-A-REPORT.md in
// platform-tests/merged-deploy/_part-a/).
async function fetchTimed(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// ---- Sohu ---------------------------------------------------------------
// yt-dlp's extractor, in-process: the page gives var vid; my.tv videos
// use videonew.do, tv.sohu.com videos use hot.vrs.sohu.com (which is
// currently 429-ing from datacenter IPs — a 429 fails fast, no retry;
// the frontend retries the next region). Per-quality vrs + allot
// fetches run in parallel; the page fetch runs in parallel only for
// the title (fallback: data.tvName). Multi-part videos (totalBlocks>1)
// have no single file and return null, matching the old behaviour.
const SOHU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SOHU_LABELS = { nor: 'Normal', high: 'High', super: 'Super', ori: 'Original', h2644k: '4K', h2654k: '4K (H.265)' };
const SOHU_ORDER = ['h2654k', 'h2644k', 'ori', 'super', 'high', 'nor'];
function sohuVidFromUrl(u) {
  try {
    const p = new URL(u);
    const mytv = p.hostname.toLowerCase().startsWith('my.');
    const vm = p.pathname.match(/\/v\/([A-Za-z0-9+/=]+)\.html/i);
    if (vm) {
      const dec = Buffer.from(vm[1], 'base64').toString('utf8');
      const m = dec.match(/(\d+)\.shtml$/);
      if (!m) return null;
      return { vid: m[1], mytv: !/^\d+\/n\d+\.shtml$/.test(dec) };
    }
    const m = p.pathname.match(/\/n?(\d+)\.shtml$/);
    if (!m) return null;
    return { vid: m[1], mytv };
  } catch { return null; }
}
async function sohuVrs(vid, mytv, timeoutMs) {
  const base = mytv ? 'https://my.tv.sohu.com/play/videonew.do?vid=' : 'https://hot.vrs.sohu.com/vrs_flash.action?vid=';
  const r = await fetchTimed(base + vid, { headers: { 'User-Agent': SOHU_UA } }, timeoutMs);
  if (r.status === 429) { const e = new Error('Sohu is rate-limiting us right now.'); e.rateLimited = true; throw e; }
  if (!r.ok) return null;
  return r.json();
}
async function sohuAllot(allot, clip, su, timeoutMs) {
  let videoUrl = 'newflv.sohu.ccgslb.net';
  let cdnId = null;
  for (let retry = 0; retry < 6 && videoUrl.includes('newflv.sohu.ccgslb.net'); retry++) {
    const params = new URLSearchParams({ prot: '9', file: clip, new: su, prod: 'h5n', rb: '1' });
    if (cdnId) params.set('idc', cdnId);
    const r = await fetchTimed('http://' + allot + '/?' + params.toString(), { headers: { 'User-Agent': SOHU_UA } }, timeoutMs);
    if (r.status === 429) { const e = new Error('Sohu is rate-limiting us right now.'); e.rateLimited = true; throw e; }
    if (!r.ok) return null;
    const j = await r.json();
    videoUrl = j.url || '';
    cdnId = j.nid || null;
  }
  return videoUrl.includes('newflv.sohu.ccgslb.net') ? null : videoUrl;
}
async function sohuInfo(url, timeoutMs = 8000) {
  const v = sohuVidFromUrl(url);
  if (!v) return { unsupported: true };
  // Title in parallel with the data calls (the page fetch is slow first-hit).
  const titleP = (async () => {
    try {
      const r = await fetchTimed(url, { headers: { 'User-Agent': SOHU_UA } }, 8000);
      if (!r.ok) return '';
      const html = await r.text();
      const t = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) || [])[1] || '';
      return decodeEntities(t).replace(/ - 高清正版在线观看 - 搜狐视频$/, '').replace(/ - 搜狐视频$/, '').trim();
    } catch { return ''; }
  })();
  let base;
  try { base = await sohuVrs(v.vid, v.mytv, timeoutMs); }
  catch (e) { if (e && e.rateLimited) return null; throw e; }
  if (!base) return null;
  if (base.play !== 1) {
    if (base.status === 12) return null;
    const e = new Error('This video is only available in Mainland China.');
    e.geoBlocked = true;
    throw e;
  }
  const data = base.data || {};
  if (Number(data.totalBlocks) !== 1) return null; // multi-part: no single file
  const title = (await titleP) || String(data.tvName || '') || 'Sohu video';
  const jobs = [];
  for (const q of SOHU_ORDER) {
    const qvid = data[q + 'Vid'];
    if (!qvid) continue;
    jobs.push((async () => {
      let qresp = base;
      if (String(qvid) !== v.vid) {
        try { qresp = await sohuVrs(String(qvid), v.mytv, timeoutMs); } catch (e) { if (e && e.rateLimited) return null; throw e; }
        if (!qresp) return null;
      }
      const qdata = qresp.data || {};
      const clip = (qdata.clipsURL && qdata.clipsURL[0]) || (qdata.mp4PlayUrl && qdata.mp4PlayUrl[0]) || '';
      const su = (qdata.su && qdata.su[0]) || '';
      if (!clip || !su) return null;
      const allot = qresp.allot || base.allot;
      if (!allot) return null;
      let fileUrl;
      try { fileUrl = await sohuAllot(allot, clip, su, timeoutMs); } catch (e) { if (e && e.rateLimited) return null; throw e; }
      if (!fileUrl) return null;
      fileUrl = fileUrl.replace(/^http:\/\/(video\d+\.vod\.tv\.itc\.cn\/)/, 'https://$1');
      return {
        id: q, label: SOHU_LABELS[q] || q,
        ext: 'mp4', hasAudio: true, url: fileUrl,
        filesize: Number((qdata.clipsBytes && qdata.clipsBytes[0]) || 0),
        note: 'With sound', kind: 'progressive',
      };
    })());
  }
  const formats = (await Promise.all(jobs)).filter(Boolean);
  if (!formats.length) return null;
  const order = Object.fromEntries(SOHU_ORDER.map((q, i) => [q, i]));
  formats.sort((a, b) => order[a.id] - order[b.id]);
  return {
    title,
    thumbnail: data.coverImg || '',
    duration: Math.round(Number((data.clipsDuration && data.clipsDuration[0]) || data.totalDuration || 0)),
    uploader: (base.wm_data && base.wm_data.wm_username) || '',
    previewUrl: formats[0].url,
    formats,
  };
}


// ---- SEO: per-platform landing pages --------------------------------------
// Visible brand stays neutral ("Save Video"). Keywords live in the <title>,
// meta description, URL slug, intro text and FAQ — never in the logo or
// the hero heading.
const PLATFORMS = {
  youtube: {
    name: 'YouTube',
    keyword: 'YouTube video downloader',
    title: 'YouTube Video Downloader — Save in 360p | Save Video',
    description: 'YouTube video downloader: paste a YouTube link, preview the video and save it in 360p with sound, or as audio. Free, no account, works on phone and PC.',
    h1: 'YouTube Video Downloader',
    intro: 'A free online YouTube video downloader that keeps it simple: paste a YouTube link, see the video preview with every available quality, and save the one you want — download YouTube videos without any software. No account, no software to install, and it works on your phone, tablet and PC.',
    example: 'https://www.youtube.com/watch?v=2ptQ0Z1deuA',
    about: "<h2>What YouTube is, and what you can save from it</h2>\n<p>YouTube is the largest video library in the world. Music videos, lectures, documentaries, repair tutorials, sermons, children's shows, sports highlights and entire university courses all live there, and most people watch it every day without thinking about it. Saving a YouTube video means keeping a copy you can watch without an internet connection — on a flight, in a village with a weak signal, or in a classroom where the Wi-Fi drops halfway through a lesson.</p>\n<p>This page is a YouTube video downloader: paste the link of a public YouTube video and you can preview it, then save it as a video file with sound, or save just the audio. There is no account to create and no software to install. It works on your phone, tablet and computer, in any modern browser.</p>\n<p>Before you use it, read the next section carefully, because it states plainly what this page can and cannot do right now. A downloader that over-promises and under-delivers wastes your time; this page would rather tell you the truth up front.</p>\n<h2>What quality will I get? Read this first</h2>\n<p>Right now, YouTube videos saved from this site come in one video quality: 360p with sound, saved as an MP4 file. That is the honest limit of the service as it runs today. The preview on this page plays with sound, and the saved file is the same 360p picture you previewed — clear enough to follow a tutorial, a talk or a song on a phone screen, and small enough to download quickly even on a slow connection, but it is not a sharp large-screen picture and it is not presented as one.</p>\n<p>There is also an audio-only option, for when you only want the sound — a lecture, a sermon, a song, a podcast-style video. The audio file is served in the format YouTube provides, such as WebM or M4A. The audio file is served in the format YouTube provides, such as WebM or M4A.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>360p video</td><td>An MP4 video with sound, at 360p resolution</td><td>Watching on a phone, offline viewing, slow connections</td></tr>\n<tr><td>Audio-only</td><td>Just the sound, in the audio format YouTube provides</td><td>Lectures, talks, songs and podcasts where the picture does not matter</td></tr>\n</table>\n<p>Long videos take longer than short ones: a video of an hour or more can take a couple of minutes before the file is ready, and very long videos sometimes fail outright. If a long video fails, try again once, and if it still fails, the video is longer than this service can handle today. Short and medium-length videos — the great majority of what people save — work normally.</p>\n<h2>How to download a YouTube video on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved file ends up in the Files app.</p>\n<ol>\n<li>Open the YouTube app and find the video you want.</li>\n<li>Tap Share under the video, then tap Copy link.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, pick the 360p video option, or the audio-only option if you only want the sound.</li>\n<li>Tap Download. Safari saves the file to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the file to play it. From there you can move the video into Photos, send it in a message, or AirDrop it. If tapping a link keeps opening the YouTube app instead of Safari, copy the link inside the app first and paste it into Safari yourself.</p>\n<h2>How to download a YouTube video on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>In the YouTube app, open the video, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Choose the 360p video option or the audio-only option, and let Chrome download the file.</li>\n<li>Find it in the Files app under Downloads, or in your gallery app.</li>\n</ol>\n<p>The video file is a standard MP4, so any gallery or video player can open it. The audio file plays in any music app. On a slow mobile connection the 360p file is actually an advantage: it is small, so it finishes downloading instead of stalling halfway.</p>\n<h2>How to download a YouTube video on PC</h2>\n<p>On a computer, YouTube runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open youtube.com in your browser and open the video.</li>\n<li>Copy the address from the address bar — it looks like youtube.com/watch?v= followed by a short code — or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Choose the 360p video option or the audio-only option and save the file to your Downloads folder.</li>\n</ol>\n<p>Shorts links work the same way as ordinary video links: a link that looks like youtube.com/shorts/ followed by a code is a normal YouTube video, and it saves in the same 360p quality. The MP4 plays in any media player on Windows or Mac.</p>\n<h2>What you cannot download from YouTube</h2>\n<p>Some YouTube content has no downloadable file here, and it is better to say so than to let you try and fail. Private videos cannot be read, because only the people the uploader invited can see them at all. Deleted videos are gone. Age-restricted videos cannot be read without signing in, and this page never asks you to sign in. Videos that YouTube restricts to a particular country will not load for a visitor outside that country. Paid content — rented or purchased films, and members-only videos — cannot be saved. A live stream cannot be saved while it is live; only a finished video that the channel left up afterwards can be downloaded. And as noted above, very long videos sometimes fail, because fetching a file that large takes longer than the service can sustain.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Make sure you copied the link of the video itself — youtube.com/watch?v= followed by a code, youtu.be followed by a code, or a youtube.com/shorts/ link. A link to a channel, a playlist, a search page or the YouTube homepage points at a page, not a video, and there is nothing to save. If you pasted a playlist link by mistake, open the video itself and copy its own link instead. If the preview loads but the download fails, the video is probably private, deleted, age-restricted, or very long — try a shorter video from the same channel to see whether the service is working. If the download finishes but the file has no sound, check that you picked the video option rather than the audio option by mistake, and that your device is not on silent. If your phone keeps opening the YouTube app when you tap a link, copy the link inside the app and paste it into your browser by hand.</p>\n<h2>Why YouTube here is 360p, in plain language</h2>\n<p>It is fair to ask why a site that offers sharper files for other platforms can only offer 360p for YouTube, so here is the honest answer. This site runs on a small rented server, and YouTube is the hardest platform in the world to fetch video from: its video files are large, its pages are heavily protected, and fetching a sharper file takes far more time and server power than this small server can give to every visitor. The 360p file is the one this server can fetch reliably, quickly, and for everyone who asks. A bigger server could do more — and that is a real option for the future — but promising sharper files today, on the server this site has today, would be a promise the site could not keep. So the page says 360p, and it means it.</p>\n<p>That limit is also why long videos struggle here. A ten-minute video is a small file; a two-hour lecture is a large one, and fetching it can take longer than the server allows for a single request. If a long video fails, it is not your link and it is not your phone — it is the size of the job. Short and medium-length videos are the ones this page handles well, and they are the great majority of what people save: a song, a tutorial, a talk, a recipe, a children's video. For those, 360p on a phone screen is perfectly watchable, and the file is small enough to download on a slow connection without stalling.</p>\n<h2>Getting the most out of the audio-only option</h2>\n<p>The audio-only option deserves a second look, because for a large share of YouTube it is the better choice. Lectures, sermons, talks, interviews, podcasts, audiobooks and songs are all videos where the picture adds almost nothing — a static image, a talking head, a slideshow. Saving just the sound gives you a much smaller file that downloads faster, takes less space, and plays in any music app while your phone screen is off. It is also the option that works most reliably for long videos, because an audio file is a fraction of the size of the video. If you are saving a talk to listen to on a walk or a drive, pick audio-only first and only save the video if you actually need the picture.</p>\n<h2>Is it free, and do I need a YouTube account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on YouTube. You never log in, and the uploader is never told you saved their video. One thing to remember before sharing a saved video anywhere: the video belongs to the person who made it. Keep it for personal viewing, and credit the creator if you post it somewhere else. And remember the quality limit on this page: 360p video with sound, plus an audio-only file. If you need a sharper copy of a video, the honest answer is that this page cannot provide it today.</p>",
    faq: [
      ["Is the YouTube video downloader free?", "Yes, completely free — no account, no software to install, no payment. You only need the link of a public YouTube video."],
      ["What quality can I save a YouTube video in?", "Right now, YouTube videos saved here come in one video quality: 360p with sound, as an MP4 file. That is the honest limit of the service as it runs today — this page does not offer higher video qualities for YouTube at present."],
      ["Can I download a YouTube video in high quality?", "Not from this page today. YouTube videos here are saved at 360p with sound only. The preview plays with sound and the saved file matches the preview. If you need a sharper copy, this page cannot provide it at present."],
      ["Can I download a YouTube video as audio?", "Yes. There is an audio-only option that saves just the sound — useful for lectures, talks, songs and podcasts. The audio file is served in the format YouTube provides, such as WebM or M4A."],
      ["How do I download a YouTube video on iPhone?", "In the YouTube app tap Share, then Copy link. Open Safari, paste the link here and tap Get video. Pick the 360p video option and the MP4 saves to the Files app under Downloads, where you can play it or move it into Photos."],
      ["How do I download a YouTube video on Android?", "Copy the video link in the YouTube app, paste it here in Chrome and tap Get video. Choose the 360p video option or the audio-only option and the file downloads to your Downloads folder."],
      ["Can I download YouTube Shorts?", "Yes. A Shorts link works the same way as an ordinary video link — paste it here and save it in the same 360p quality with sound. Shorts are short, so they download quickly."],
      ["Can I save private YouTube videos?", "No. Private videos can only be seen by people the uploader invited, so they cannot be read or saved. The same applies to deleted videos and age-restricted videos, which cannot be read without signing in."],
      ["Why does a long YouTube video fail to download?", "Long videos take longer to fetch, and very long videos sometimes fail outright. Short and medium-length videos work normally. If a long video fails, try again once — if it still fails, the video is longer than this service can handle today."],
      ["Do I need a YouTube account?", "No. Just paste the public video link — no login is needed on either side, and the uploader is never told you saved their video."],
      ["Why does my YouTube link not work?", "Check that you copied the link of the video itself — a watch link, a short youtu.be link, or a Shorts link. A channel, playlist or search link has no single video in it. The video may also be private, deleted or age-restricted."],
      ["Where does a saved YouTube video go on my phone?", "On iPhone the 360p MP4 — or the audio-only file, if that is what you picked — goes to the Files app under Downloads. On Android it goes to the Downloads folder. The video plays in any gallery app and the audio file plays in any music app."]

    ],
  },
  tiktok: {
    name: 'TikTok',
    keyword: 'TikTok video downloader',
    title: 'TikTok Video Downloader — Without Watermark | Save Video',
    description: 'TikTok video downloader: paste a TikTok link and save the video without watermark in HD, plus the audio as MP3. Free, no account, works on phone and PC.',
    h1: 'TikTok Video Downloader',
    intro: 'A free TikTok video downloader: paste a TikTok link, preview the clip, and save it without watermark in HD — or save just the sound. No account, no app to install.',
    example: 'https://www.tiktok.com/@adorablemonkey168/video/7371259606376467754',
    about: "<h2>What TikTok is, and what you can save from it</h2>\n<p>TikTok is the short vertical-video app where a fifteen-second clip can travel further than a television advert. Dance trends, comedy sketches, cooking demos, news clips, product reviews, football highlights, language lessons and small-business adverts all live side by side, and most of them are watched on a phone, on the move, with the sound on. Because the videos are short, people save the ones they want to watch again, share in a group chat, or keep for reference — a recipe, a workout, a repair tutorial — instead of scrolling back through an endless feed to find them a second time.</p>\n<p>This page is a TikTok video downloader: paste the link of a public TikTok video and you can preview it here, then save it as an MP4 file with sound, or save just the sound as an MP3. You do not need a TikTok account, you do not need to install an app, and there is no sign-up. The file you get is the video as TikTok serves it. That matters for one honest reason: the quality you are offered always depends on the original upload. A video shot on an old phone will never become a crisp high-resolution file by being saved, and no downloader can add detail that was never in the upload.</p>\n<p>Most TikTok links work here, including the short share links that look like vm.tiktok.com followed by a jumble of letters, and links to videos inside a series. If the video is public, the link is the only thing you need. Copy it from the TikTok app with the Share button, or from the address bar if you are watching TikTok in a browser.</p>\n<h2>How to download a TikTok video on iPhone</h2>\n<p>Downloading a TikTok video on an iPhone takes about a minute, and it all happens in Safari — there is nothing to install from the App Store.</p>\n<ol>\n<li>Open the TikTok app and find the video you want to keep.</li>\n<li>Tap the Share arrow on the right side of the screen, then tap Copy link. The link is now on your clipboard.</li>\n<li>Open Safari and come to this page.</li>\n<li>Tap the box at the top of the page, paste the link, and tap Get video.</li>\n<li>Wait for the preview and the list of qualities to appear, then tap the quality you want — Best if you want the sharpest file, or Audio if you only want the sound.</li>\n<li>Safari will ask where to save the file. Choose Downloads, or just tap Download, and the video lands in the Files app under Downloads.</li>\n</ol>\n<p>To watch it, open the Files app, tap Browse, then Downloads, and tap the video. It plays in the built-in player, and from there you can move it to Photos, send it in iMessage or WhatsApp, or AirDrop it to a Mac. One iPhone quirk is worth knowing: if tapping the link opens the TikTok app instead of Safari, long-press the link and choose Open in Safari, or paste the link into Safari yourself after copying it.</p>\n<h2>How to download a TikTok video on Android</h2>\n<p>On Android the same job runs in Chrome, and the saved file goes to your Downloads folder where any gallery or video app can find it.</p>\n<ol>\n<li>Open TikTok, find the video, tap Share, then tap Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, pick a quality from the list. Best gives you the sharpest picture TikTok offers for that clip; SD gives you a smaller file that is easier to forward.</li>\n<li>Chrome downloads the file and shows it at the bottom of the screen. Tap Open to play it, or find it later in the Files app under Downloads.</li>\n</ol>\n<p>Android phones vary a little by brand — Samsung, Xiaomi, Oppo and Vivo all put downloads in slightly different places — but the file is always an ordinary MP4 in the Downloads folder, so your gallery app, VLC, or any video player can open it. If Chrome asks for permission to store files, allow it once and it will not ask again.</p>\n<h2>How to download a TikTok video on PC</h2>\n<p>On a Windows PC or a Mac the steps are the same, and the keyboard makes copying links slightly faster.</p>\n<ol>\n<li>Open TikTok in your browser and open the video you want.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste the link into the box on this page and click Get video.</li>\n<li>Choose a quality and save the file. It goes to your Downloads folder unless your browser is set to ask each time.</li>\n</ol>\n<p>On a computer the larger file sizes do not matter much, so Best is usually the sensible choice. The MP4 plays in the Movies app on Windows, in QuickTime on a Mac, and in VLC on either. If you plan to edit the clip — trimming it, adding captions, or using it in a presentation — save the Best quality and edit that, because every re-save of a compressed file loses a little sharpness.</p>\n<h2>What quality will I get?</h2>\n<p>TikTok videos are offered in the qualities TikTok itself serves. The list you see after pasting a link is the real list for that video, not a promise made in advance.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>Best</td><td>The highest-quality MP4 TikTok offers for that video, with sound</td><td>Keeping, watching again, or editing</td></tr>\n<tr><td>HD</td><td>A high-definition MP4 with sound, when the upload supports it</td><td>Watching on a bigger screen</td></tr>\n<tr><td>SD</td><td>A smaller MP4 with sound that takes less space and less data</td><td>Forwarding on a slow connection</td></tr>\n<tr><td>Audio</td><td>Just the sound, saved as an MP3</td><td>Songs, speeches, voiceovers and sounds you want to reuse</td></tr>\n</table>\n<p>MP4 is the video format: picture and sound together in one file that plays on practically every phone, tablet and computer made in the last ten years. MP3 is the audio-only format: no picture, a much smaller file, and the right choice when only the sound matters.</p>\n<h2>Can I download a TikTok video without watermark?</h2>\n<p>Yes, often — and this is where an honest answer matters more than a cheerful one. When TikTok provides a clean version of a video, that is the version you are offered here, and the file you save has no watermark on it. When only the watermarked version exists, that is what is offered, and the saved file carries the same watermark you see when you watch it in the app. This tool does not strip watermarks from videos, and it does not add a watermark of its own. If a creator has watermarked their work, the respectful thing is to keep their name visible when you share it, and to credit them.</p>\n<h2>What you cannot download from TikTok</h2>\n<p>Some TikTok content has no downloadable file, and no tool can conjure one. Videos on private accounts cannot be read, because only the account owner's approved followers can see them at all. Videos that have been deleted, or removed by TikTok, are gone. A live stream cannot be saved while it is live — only a finished video with a link can be downloaded, and a live replay is only available if the creator saved it as a video afterwards. Drafts exist only on the creator's own phone and have no public link. Photo slideshows have no single video file: they are a set of still images with music over them, so there is no MP4 to offer. And a video that TikTok restricts to a particular country will not load for a visitor outside that country, which means it cannot be read from here either.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Almost every failed download comes down to the link. Make sure you copied the link of the video itself, not the link of a profile, a search page, or a hashtag — a profile link points at a person, not a clip, and there is no video to save. If you pasted a link and nothing loads, try copying it again: the Share menu sometimes needs a second tap before the link is actually on the clipboard. If the page says the video cannot be read, the video is probably private, deleted, or restricted, and trying a different browser will not change that. If the download starts but the file is tiny or silent, check that you picked a video quality rather than the audio option by mistake. And if your phone opens the TikTok app every time you tap a link, copy the link inside the app first, then switch to your browser yourself instead of tapping the link.</p>\n<h2>Is it free, and do I need an account?</h2>\n<p>Yes, it is free, and no, you do not need an account anywhere. There is no sign-up on this site and no login to TikTok. The only thing that ever costs anything is your own mobile data if you download a large file away from Wi-Fi, so on a limited data plan it is worth waiting until you are on Wi-Fi, or picking SD instead of Best. Only save videos you have the right to keep: a creator's work belongs to them, so keep saved clips for personal viewing and credit the creator if you share them anywhere.</p>",
    faq: [
      ["Is the TikTok video downloader free?", "Yes, completely free — no account, no app install, and no payment. The only cost is your own mobile data if you download over a mobile connection instead of Wi-Fi."],
      ["How do I download a TikTok video without watermark?", "Copy the video link in the TikTok app, paste it here and tap Get Video. When TikTok provides a clean version of the video, you are offered that clean file without a watermark. If only the watermarked version exists, that is what is offered — this tool does not strip watermarks from videos."],
      ["How do I download a TikTok video on iPhone?", "In the TikTok app tap Share, then Copy link. Open Safari, come to this page, paste the link and tap Get video. Pick Best or HD, and the MP4 saves to the Files app under Downloads, where you can watch it or move it to Photos."],
      ["How do I download a TikTok video on Android?", "Copy the link from the TikTok app, paste it here in Chrome and tap Get video. Choose Best, HD or SD and the MP4 downloads to your Downloads folder, ready to open in your gallery or any video player."],
      ["Can I download TikTok videos in HD?", "Yes, when the original upload supports it. After you paste a link you will see the real qualities for that video — Best, HD and SD with sound. A video uploaded in low quality cannot be made sharper by downloading it."],
      ["Can I save just the sound from a TikTok as MP3?", "Yes. After pasting the link, pick the Audio option and the sound is saved as an MP3 file — useful for songs, speeches and voiceovers. The MP3 has no picture and a much smaller file size than the video."],
      ["Do I need a TikTok account to download a video?", "No. You only need the link of a public video. There is no login here and no login to TikTok, and the creator is never notified that you saved their video."],
      ["Why does the video I saved still have a watermark?", "Because for that video TikTok only provides the watermarked version. When a clean version is available you get it; when it is not, the file carries the same watermark you see in the app. Nothing here removes a watermark from a video."],
      ["Can I download a private TikTok video?", "No. Videos on private accounts can only be seen by approved followers, so they cannot be read or saved. The same applies to deleted videos and videos TikTok has removed."],
      ["Can I download TikTok live streams or drafts?", "No. A live stream has no finished file while it is live, and drafts live only on the creator's own phone with no public link. Only a finished, public video with a link can be saved."],
      ["The link does not work — what should I check?", "First check you copied a video link, not a profile, search or hashtag link. Copy it again from the Share menu, paste it fresh, and make sure the video is still public and not deleted. A short vm.tiktok.com link works the same as a full one."],
      ["Where does the video go on my phone after I save it?", "On iPhone it goes to the Files app under Downloads; on Android it goes to the Downloads folder, visible in the Files app or your gallery. On both, it is an ordinary MP4 you can move, share or AirDrop."]

    ],
  },
  douyin: {
    name: 'Douyin',
    keyword: 'Douyin video downloader',
    title: 'Douyin Video Downloader — Without Watermark | Save Video',
    description: 'Douyin video downloader: paste a Douyin video link, preview it and save it without watermark as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Douyin Video Downloader',
    intro: 'A free Douyin video downloader: paste the video link, preview the clip, and save it without watermark as MP4 with sound. Works with douyin.com video links, iesdouyin.com share links and short v.douyin.com links. No account, no app to install.',
    example: 'https://www.douyin.com/video/7334514828465147176',
    about: "<h2>What Douyin is</h2>\n<p>Douyin is the Chinese version of TikTok — the app TikTok was built from — and inside China it is bigger than TikTok is anywhere else. Its videos are short, vertical and endless: street food, travel, comedy, dance, live commerce, rural life, city life, and a constant stream of trends that never leave China. Douyin and TikTok share a parent company, but they are separate apps with separate accounts and separate videos: a video on Douyin does not appear on TikTok, and a TikTok link will not open a Douyin video.</p>\n<p>This page is a Douyin video downloader: paste the link of a public Douyin video and you can preview it, then save it without watermark as an MP4 with sound — usually 720p or 1080p. No account is needed and nothing has to be installed. Douyin links come in several shapes: douyin.com/video links, iesdouyin.com share links, and short v.douyin.com links, and all of them work here. Private videos cannot be read, and neither can videos restricted to viewers in China.</p>\n<h2>How to save a Douyin video</h2>\n<p>Open the video in the Douyin app, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Douyin video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Douyin video."],
      ["Are Douyin videos saved without watermark?", "Yes. The video file comes without the Douyin watermark on it — what you save is the clean video as uploaded."],
      ["Which Douyin links work here?", "Video links work: douyin.com/video links, iesdouyin.com share links and short v.douyin.com links. A profile link points at a creator, not a video, so copy the link of the video itself."],
      ["What quality do Douyin videos save in?", "Douyin serves the video as an MP4 with sound, in the quality it was uploaded — usually 720p or 1080p. The clips are short, so the file downloads quickly."],
      ["How do I download a Douyin video on my phone?", "Copy the video link in the Douyin app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Why does my Douyin link not load?", "Check you copied a video link rather than a profile link, and check the video is still public and not deleted. Some Douyin videos are restricted to viewers in China and will not load from outside the country."]

    ],
  },
  facebook: {
    name: 'Facebook',
    keyword: 'Facebook video downloader',
    title: 'Facebook Video Downloader — Save Reels in HD | Save Video',
    description: 'Facebook video downloader: paste a Facebook video or reel link, preview it and save it in HD or SD with sound. Free, no account, works on phone and PC.',
    h1: 'Facebook Video Downloader',
    intro: 'A free Facebook video downloader for videos and reels: paste the link, preview the clip, and save it in HD or SD with sound. No account needed.',
    example: 'https://web.facebook.com/reel/1126999509654190',
    about: "<h2>What Facebook is, and what you can save from it</h2>\n<p>Facebook is where video reaches the widest and oldest audience of any social network. Family videos, local news clips, church and community recordings, cooking demonstrations, marketplace listings with a video, and above all reels — short vertical clips that Facebook now pushes as hard as any other format. A Facebook video is often the only copy of a moment that matters to a family: a grandchild's recital, a wedding dance, a local match. Saving it means it survives even if the person who posted it later deletes their account or the post disappears in a feed that never stops moving.</p>\n<p>This page is a Facebook video downloader for videos and reels. Paste the link of a public Facebook video or reel and you can preview it, then save it in HD or SD with sound as an MP4. There is no account to create and no app to install. The file matches the original upload: a video posted in high quality saves sharply, while an old phone recording saves exactly as it looks in the app. Downloading cannot add sharpness that was never filmed.</p>\n<p>Facebook links come in several shapes — facebook.com, fb.watch, and the short share links the app produces — and all of them point at the same video once they are pasted here. Reels have their own links too, usually containing /reel/ followed by a number, and they save the same way as any other Facebook video.</p>\n<h2>How to download a Facebook video on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved video ends up in the Files app.</p>\n<ol>\n<li>Open the Facebook app and find the video or reel you want.</li>\n<li>Tap Share under the video, then tap Copy link. For a reel, tap Share on the right side of the screen and choose Copy link.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, pick HD for the sharpest file or SD for a smaller one, then tap Download.</li>\n<li>Safari saves the MP4 to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the video to play it. From there you can move it into Photos, send it in a message, or AirDrop it to a family member's phone. If tapping a link keeps opening the Facebook app instead of Safari, copy the link inside the app first and paste it into Safari yourself.</p>\n<h2>How to download a Facebook video on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>In the Facebook app, open the video or reel, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Pick HD or SD from the list and let Chrome download the MP4.</li>\n<li>Find it in the Files app under Downloads, or in your gallery app.</li>\n</ol>\n<p>The file is a standard MP4 with sound, so any gallery or video player can open it. If Chrome asks for permission to store files, allow it once. On a slow mobile connection pick SD so the download finishes instead of stalling halfway.</p>\n<h2>How to download a Facebook video on PC</h2>\n<p>On a computer, Facebook runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open facebook.com in your browser and open the video or reel.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Choose HD or SD and save the MP4 to your Downloads folder.</li>\n</ol>\n<p>On a PC the HD file is usually the right choice, since storage is rarely a problem. The MP4 plays in any media player, and if you want to keep a family video for years, save the HD version and keep a backup copy somewhere safe.</p>\n<h2>What quality will I get?</h2>\n<p>Public Facebook videos usually offer HD and SD with sound, plus an audio-only option. The list you see after pasting a link is the real list for that video.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>HD</td><td>A high-definition MP4 with sound, when the video was uploaded in high quality</td><td>Keeping family videos and watching on a bigger screen</td></tr>\n<tr><td>SD</td><td>A smaller MP4 with sound that takes less space and less data</td><td>Forwarding on a slow connection</td></tr>\n<tr><td>Audio</td><td>Just the sound from the video</td><td>Songs, speeches and talks where the picture does not matter</td></tr>\n</table>\n<p>MP4 is the video format — picture and sound together in one file that plays on any modern phone, tablet or computer. Reels save the same way as longer videos: the reel is a short vertical MP4, and the file you get keeps its vertical shape.</p>\n<h2>Can I save Facebook reels?</h2>\n<p>Yes. A reel is a public Facebook video like any other, and its link works here the same way. Copy the reel link from the Share menu, paste it here, and pick a quality. Reels are short, so even the HD file is small and downloads quickly. The same rules apply: the reel must be public, and if the person who posted it deletes it, the link stops working.</p>\n<h2>What you cannot download from Facebook</h2>\n<p>Facebook keeps a lot of video behind its own walls, and no downloader can reach through them. Videos shared only with friends, or only with a custom list, cannot be read — only public videos can be. Videos inside private groups are private by definition, and videos on a locked profile are the same. A video that has been deleted is gone, and a live broadcast cannot be saved while it is live; only a finished video with a link can be downloaded, and only if the broadcaster left it up afterwards. Stories disappear after twenty-four hours and are not video posts. And if a video is actually a link to YouTube or another site, the file lives there — paste the original link on that site's page instead.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Facebook produces several kinds of link, and only the link of the video itself works: a link to a profile, a page, a group or a feed points at a collection of posts, not a clip. Make sure the link opens the video when you tap it in a browser. If it opens the Facebook app instead, copy the link inside the app and paste it into your browser by hand. If the preview loads but no quality appears, the video is probably friends-only, deleted, or inside a private group. If the download finishes but the video is silent, check that you picked a video quality rather than the audio option, and that your phone is not on silent. A video with a title that looks like an error message is usually a page Facebook itself blocked — try the link again, and if it still fails, the video itself cannot be read.</p>\n<h2>Saving videos from pages, groups and friends</h2>\n<p>Facebook video does not all live in the same place, and where a video lives decides whether it can be saved. Videos on public pages — a news outlet, a restaurant, a football club, a local council — are public by design, and their links work here without any trouble. Videos on a public profile work the same way. Videos inside a public group are trickier: the group may be public, but the video may still be visible only to members, and if it is, it cannot be read from here. Videos inside a private group are private by definition, and videos shared only with friends are visible only to those friends. If a link fails, ask yourself where the video lives before you try a different browser — a different browser will not open a door Facebook has locked.</p>\n<p>Facebook also mixes video with other things in ways that confuse the link. A post can carry a video and a link to an outside site at the same time, and the link you copy may be the outside link rather than the video. A photo album can contain a video among the photos, and the album link points at the album, not the video. In both cases, open the video itself — tap it so it plays full-screen — and copy the link from there. The link of a playing video is the link of the video, and it is the one this page needs.</p>\n<h2>Watch Parties, live videos and premieres</h2>\n<p>Facebook has three kinds of video that look downloadable but are not, and it is worth knowing them apart. A live video cannot be saved while it is live, because there is no finished file yet — only a stream. If the broadcaster leaves the recording up afterwards, that recording is an ordinary video and it saves normally. A premiere is a video released at a scheduled time: before the premiere it is a countdown, not a video, and after the premiere it becomes an ordinary video. A Watch Party is a shared viewing session, not a video at all — the video being watched is an ordinary post somewhere else, and that post's link is the one to copy. In every case the rule is the same: wait until the video exists as a finished, public post, then save that post.</p>\n<h2>Is it free, and do I need a Facebook account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on Facebook. You never log in, and the person who posted the video is not told you saved it. Only save videos you have the right to keep, and ask the person who posted it before sharing a family video anywhere else. On a limited data plan, download on Wi-Fi or pick SD, because an HD video of a few minutes is a large file.</p>",
    faq: [
      ["Is the Facebook video downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public Facebook video or reel."],
      ["How do I download a Facebook video?", "Copy the video link in the Facebook app, paste it here and tap Get video. When the preview appears, pick HD or SD and the Facebook video downloads as an MP4 with sound. This Facebook downloader, also called an FB video downloader, is free and works on any phone or PC."],
      ["How do I download Facebook videos on Android?", "In the Facebook app tap Share, then Copy link. Open Chrome, paste the link here and tap Get video. Choose HD or SD and the MP4 downloads to your Downloads folder, ready to open in your gallery."],
      ["How do I download Facebook videos on iPhone?", "Copy the video link in the Facebook app, open Safari, paste the link here and tap Get video. Pick HD or SD and the MP4 saves to the Files app under Downloads, where you can move it into Photos."],
      ["Can I save Facebook reels?", "Yes. Paste the reel link and you will see the same quality options as for any Facebook video — HD and SD with sound, plus audio-only. Reels are short, so even the HD file downloads quickly."],
      ["What qualities can I save a Facebook video in?", "Public Facebook videos usually offer HD and SD with sound, plus an audio-only option. The list you see after pasting a link is the real list for that video — a video uploaded in low quality has no HD version."],
      ["Do I need a Facebook account to download a video?", "No. Only the public video link is needed. There is no login here and no login to Facebook, and the person who posted the video is never told."],
      ["Can I save private Facebook videos?", "No. Videos shared only with friends, inside private groups, or on a locked profile cannot be read. Only public videos can be saved, and deleted videos are gone."],
      ["Why does my Facebook link not work?", "Check that you copied the link of the video itself, not a profile, page, group or feed link. If the link opens the Facebook app instead of a browser, copy it inside the app and paste it into your browser by hand. The video may also be friends-only, deleted, or inside a private group."],
      ["Can I download Facebook live videos?", "Not while they are live. Only a finished video that the broadcaster left up afterwards can be saved, and only if it is public. A live broadcast has no finished file to offer while it is streaming."],
      ["Can I save just the audio from a Facebook video?", "Yes. After pasting the link, choose the Audio option and only the sound is saved — useful for songs, speeches and talks where the picture does not matter."],
      ["Where does a saved Facebook video go on my phone?", "On iPhone it goes to the Files app under Downloads; open Files, tap Browse, then Downloads to find it. On Android it goes to the Downloads folder, visible in Files or your gallery. The file is an ordinary MP4 with sound, so you can move it, share it or AirDrop it."]

    ],
  },
  instagram: {
    name: 'Instagram',
    keyword: 'Instagram video downloader',
    title: 'Instagram Video Downloader — Save Reels in HD | Save Video',
    description: 'Instagram video downloader: paste an Instagram reel or video link, preview it and save it in HD with sound. Free, no account, works on phone and PC.',
    h1: 'Instagram Video Downloader',
    intro: 'A free Instagram video downloader (also called an IG downloader or Insta downloader) for reels and videos: paste the link, preview the clip, and save it in HD with sound as an MP4. No account, no app to install.',
    example: 'https://www.instagram.com/reel/',
    about: "<h2>What Instagram is, and what you can save from it</h2>\n<p>Instagram started as a photo app and has become a video app in all but name. Reels — short vertical videos, usually under ninety seconds — now dominate the feed, alongside longer videos posted to the grid, and the two behave differently enough that it is worth knowing which one you are saving. A reel is built to be discovered: it is pushed to people who do not follow the creator, it carries trending audio, and it is the format most people mean when they say \"download Instagram reels\". A grid video is usually longer and calmer — a tutorial, a talk, a vlog — and it is watched by people who already follow the account. Both are ordinary public posts with a link, and both can be saved here the same way.</p>\n<p>This page is an Instagram video downloader, also called an IG downloader or Insta downloader. Paste the link of a public reel or video and you can preview it, then save it as an MP4 with sound — the download Instagram reels option people search for, in the quality Instagram serves. There is no account to create and no app to install. The file you get matches the original upload: a reel shot in crisp light on a new phone saves sharply, while an old re-uploaded clip saves exactly as soft as it looks in the app. No downloader can add sharpness that was never filmed.</p>\n<p>Reels are the main reason people come here. A dance, a recipe, a travel clip, a funny skit, a small business showing its product — reels are made to be shared, and saving one means you can watch it offline on a flight, send it to a friend who is not on Instagram, or keep a tutorial without scrolling through a saved collection that you will never open again.</p>\n<h2>How to download Instagram reels on iPhone</h2>\n<p>On an iPhone the whole job runs in Safari, and the saved reel ends up in the Files app.</p>\n<ol>\n<li>Open Instagram and find the reel or video you want.</li>\n<li>Tap the Share arrow (the paper plane), then tap Copy link. If you are watching a reel in full screen, the share icon is on the right edge.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, choose a quality. The HD option is the best match for a reel that was uploaded in high quality.</li>\n<li>Tap Download. Safari saves the MP4 to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the video to play it. From there you can save it into Photos, send it in a message, or AirDrop it. If tapping a link keeps opening the Instagram app instead of Safari, copy the link inside Instagram first and then switch to Safari yourself — pasting the link directly is more reliable than tapping it.</p>\n<h2>How to download Instagram reels on Android</h2>\n<p>On Android, Chrome does the same job, and the file lands in your Downloads folder.</p>\n<ol>\n<li>In Instagram, open the reel or video, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Pick a quality from the list and let Chrome download the MP4.</li>\n<li>Find it in the Files app under Downloads, or in your gallery app.</li>\n</ol>\n<p>Different Android brands name their file apps differently, but the file is always a standard MP4 in Downloads, so any gallery or video player can open it. On a slow mobile connection, pick a smaller quality so the download finishes instead of stalling halfway.</p>\n<h2>How to download an Instagram video on PC</h2>\n<p>On a computer, Instagram runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open instagram.com in your browser and open the reel or video.</li>\n<li>Copy the address from the address bar — it looks like instagram.com/reel/ followed by a short code.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Choose a quality and save the MP4 to your Downloads folder.</li>\n</ol>\n<p>On a PC the Best or HD file is the sensible pick, since storage and data are rarely a problem. The MP4 plays in any media player, and if you want to use the clip in an edit or a presentation, save the highest quality first — every extra compression step costs sharpness.</p>\n<h2>What quality will I get?</h2>\n<p>Instagram reels and videos are offered in the qualities Instagram serves for that post. The list you see after pasting a link is the real list for that reel, not a guess.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>HD</td><td>A high-definition MP4 with sound, when the reel was uploaded in high quality</td><td>Watching again, sharing, or editing</td></tr>\n<tr><td>Standard</td><td>The regular MP4 Instagram serves, with sound</td><td>Quick saves and forwarding</td></tr>\n<tr><td>Audio</td><td>Just the sound from the reel or video</td><td>Music, voiceovers and trending audio you want to keep</td></tr>\n</table>\n<p>MP4 is the video format — picture and sound in one file that plays on any modern phone or computer. Picking Audio gives you only the sound, in a much smaller file, which is the right choice when the picture does not matter.</p>\n<h2>Download Instagram reels: what works and what does not</h2>\n<p>Public reels and public grid videos work. That covers the overwhelming majority of what people want to save. A reel from a public creator, a brand, a news account or a meme page will load here with its link alone. What does not work is anything Instagram keeps behind a login wall: posts from private accounts, which only approved followers can see, and posts that have been deleted. Stories are a separate case — a story disappears after twenty-four hours, and this page is built for reels and video posts, not for stories, so a story link is not the right link to paste here. A carousel post that mixes photos and video also has no single video file when the video is only one slide among photos.</p>\n<h2>Common problems, and what to check first</h2>\n<p>The most common failure is pasting the wrong link. Instagram has several kinds of link, and only the link of the reel or video itself works: a profile link points at an account, an explore link points at a page of many posts, and a link copied from a story points at something that will vanish within a day. Make sure the link contains /reel/ or /p/ followed by a short code. If the preview loads but no quality appears, the post may have been deleted since you copied the link, or the account may have switched to private. If the download finishes but the video has no sound, check that you picked a video quality rather than the audio-only option — and check your phone is not on silent. If Instagram keeps opening the app when you tap a link, copy the link inside the app and paste it into your browser by hand.</p>\n<h2>Reels versus grid videos: which link should you copy?</h2>\n<p>Instagram has two kinds of video post, and the link you copy decides whether the download works. A reel is the short vertical video in the Reels tab and the Reels feed — it always has a link containing /reel/ followed by a short code, and it is the format this page handles best. A grid video is a longer video posted to an account's profile grid — its link contains /p/ followed by a short code, and it saves the same way. Both are public posts with a link, and both work here. What does not work is a link copied from the Explore page, which points at a whole page of posts, or a link copied from a profile, which points at an account. If the link you pasted does not load, open the reel or video itself first, tap Share, and copy the link from there — the link Instagram gives you inside the post is always the right one.</p>\n<p>It is also worth knowing how reels differ from stories when you are trying to save something. A story is a temporary post that disappears after a day, and Instagram never gives it a lasting video link. A reel is permanent until its creator deletes it, and its link keeps working as long as the reel is up. If a friend sent you a reel in a message, open it from the message and copy its link — the link is the same as if you had found the reel yourself. And if a reel you saved yesterday suddenly fails today, the creator probably deleted it or switched their account to private; nothing on this page can bring back a video that no longer exists on Instagram.</p>\n<h2>What people actually do with a saved reel</h2>\n<p>Most saved reels are never watched again on the phone that saved them — they are forwarded. A recipe goes to a family group, a workout goes to a friend, a funny clip goes to a sibling, a product demo goes to a colleague who is thinking of buying. That is why the MP4 format matters: unlike a link, which needs Instagram and an account to open, an MP4 plays in any chat app, on any phone, even for someone who has never installed Instagram. A saved reel also works offline — on a flight, on a train with no signal, or in a house where the Wi-Fi drops every evening. If you save reels to use them in your own videos, remember that the reel belongs to its creator: use short clips, credit them, and never re-upload someone else's reel as if it were your own work.</p>\n<h2>Is it free, and do I need an Instagram account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on Instagram. You never log in, and the creator is not told that you saved their reel. One thing to remember before sharing a saved reel anywhere: the video belongs to the person who made it. Keep it for personal viewing, and credit the creator if you post it somewhere else. If you are on a limited mobile data plan, download on Wi-Fi or pick a smaller quality, because a minute of HD video is a large file.</p>",
    faq: [
      ["Is the Instagram video downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public reel or video, and the only cost is your own mobile data if you download away from Wi-Fi."],
      ["How do I download Instagram reels?", "Open the reel in Instagram, tap Share, then Copy link. Paste the link here and tap Get video. When the preview appears, pick a quality and the reel saves as an MP4 with sound — this is the download Instagram reels option, and it works for public reels in HD."],
      ["How do I download Instagram reels on iPhone?", "Copy the reel link in the Instagram app, open Safari, paste the link here and tap Get video. Choose HD and the MP4 saves to the Files app under Downloads, where you can play it or move it into Photos."],
      ["How do I download Instagram reels on Android?", "Copy the reel link, paste it here in Chrome and tap Get video. Pick a quality and the MP4 downloads to your Downloads folder, ready to open in your gallery or any video player."],
      ["Can I download Instagram reels in HD?", "Yes, when the reel was uploaded in high quality. After you paste a link you will see the real qualities for that reel, including HD with sound. A reel uploaded in low quality cannot be made sharper by downloading it."],
      ["Can I save an Instagram video as MP4?", "Yes. Every Instagram reels download MP4 keeps picture and sound together in one file, in the quality Instagram serves. The MP4 plays on any modern phone, tablet or computer without extra software."],
      ["Do I need an Instagram account to download a reel?", "No. Only the public post link is needed — no login here and no login to Instagram. The creator is never notified that you saved their reel."],
      ["Can I save private Instagram posts?", "No. Posts from private accounts can only be seen by approved followers, so they cannot be read or saved. The same applies to deleted posts."],
      ["Can I download Instagram stories?", "This page is built for reels and video posts, not stories. A story disappears after twenty-four hours and has no lasting video-post link, so paste the link of a reel or grid video instead."],
      ["Why does my Instagram link not work?", "Check that you copied the link of the reel or video itself — it should contain /reel/ or /p/ followed by a short code. A profile link, an explore link or a story link will not load a video. The post may also have been deleted or made private since you copied it."],
      ["Can I save just the audio from an Instagram reel?", "Yes. After pasting the link, choose the Audio option and only the sound is saved — handy for music, voiceovers and trending audio you want to keep without the picture."],
      ["Where does the saved reel go on my phone?", "On iPhone the reel lands in the Files app under Downloads, and from there you can move it into Photos. On Android it lands in the Downloads folder, where your gallery app will show it. Either way it is a normal MP4, so you can forward it in any chat app without Instagram."]

    ],
  },
  twitter: {
    name: 'X (Twitter)',
    keyword: 'Twitter video downloader',
    title: 'Twitter Video Downloader — Save X Videos in HD | Save Video',
    description: 'Twitter video downloader: paste an X (Twitter) video link, preview it and save it in HD with sound. Free, no account, works on phone and PC.',
    h1: 'Twitter Video Downloader',
    intro: 'A free X video downloader (Twitter video downloader) for X videos: paste the post link, preview the clip, and save it in HD with sound. No account needed.',
    example: 'https://x.com/Eminem/status/943590594491772928',
    about: "<h2>What X is, and what you can save from it</h2>\n<p>X, still called Twitter by most of its users, is where video travels fastest. A clip posted in the morning can be quoted, reposted and argued about by lunchtime, and by the evening it has spread far beyond the account that posted it. The videos are short — sports goals, press-conference moments, funny clips, news footage, product teasers — and they sit inside a post alongside text, so they are easy to scroll past and hard to find again a week later. That is why people save them: to keep a moment they want to show someone, to watch it offline, or to keep a copy before the post is deleted.</p>\n<p>This page is an X video downloader, also known as a Twitter video downloader. Paste the link of a public post that carries a video and you can preview it, then save it as an MP4 with sound. There is no account, no sign-up and no app to install. The file you get is the video as X serves it, in the qualities the post actually has — usually 720p, 360p and 180p. A video uploaded in low resolution will save in low resolution; downloading cannot add detail that was never there.</p>\n<p>X links come in two shapes that mean the same thing: x.com and the older twitter.com. Both work here. A post link looks like x.com/username/status/ followed by a long number — that number is the post itself, and it is the part that matters. Copy it from the Share menu in the app, or from the address bar in a browser.</p>\n<h2>How to download an X video on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved clip ends up in the Files app.</p>\n<ol>\n<li>Open the X app and find the post with the video.</li>\n<li>Tap the Share icon under the post, then tap Copy link.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, pick a quality — 720p is the sharpest X usually offers — and tap Download.</li>\n<li>Safari saves the MP4 to the Files app under Downloads.</li>\n</ol>\n<p>To watch it, open Files, tap Browse, then Downloads, and tap the video. You can move it into Photos, send it in a message, or AirDrop it. If tapping a link opens the X app instead of Safari, copy the link inside the app first and paste it into Safari yourself.</p>\n<h2>How to download an X video on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>In the X app, open the post, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Choose a quality from the list and let Chrome download the MP4.</li>\n<li>Find it in the Files app under Downloads, or in your gallery.</li>\n</ol>\n<p>The file is a standard MP4, so any gallery or video player can open it. On a slow connection pick 360p or 180p so the download finishes instead of stalling.</p>\n<h2>How to download an X video on PC</h2>\n<p>On a computer, X runs in the browser, which makes links easy to copy.</p>\n<ol>\n<li>Open x.com or twitter.com in your browser and open the post.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Pick a quality and save the MP4 to your Downloads folder.</li>\n</ol>\n<p>On a PC, 720p is usually the right choice — the file is small by modern standards and the picture is as sharp as X offers. The MP4 plays in any media player, and if you want to use the clip in a presentation or an edit, save the highest quality first.</p>\n<h2>What quality will I get?</h2>\n<p>X videos are served as direct MP4 files, and the list you see after pasting a link is the real list for that post.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>720p</td><td>The sharpest MP4 X usually offers, with sound</td><td>Keeping, watching again, or sharing</td></tr>\n<tr><td>360p</td><td>A medium MP4 with sound, half the size or less</td><td>Forwarding on a slow connection</td></tr>\n<tr><td>180p</td><td>The smallest MP4, with sound</td><td>Saving space or data</td></tr>\n<tr><td>Audio</td><td>Just the sound from the video</td><td>Speeches, interviews and audio clips</td></tr>\n</table>\n<p>MP4 is the video format: picture and sound together in one file that plays on any modern device. Short animated GIF posts on X are stored as short MP4 videos by X itself, so they save the same way as any other video.</p>\n<h2>X video downloader: what works and what does not</h2>\n<p>Public posts with a video work — that is the core of the site, and it covers sports clips, news footage, comedy, and everything else people post publicly. What does not work is anything X keeps behind a login wall: posts from protected (private) accounts, which only approved followers can see, and posts that have been deleted. A Spaces audio session is not a video and has no video file, and a live broadcast cannot be saved while it is live. If a post shows a video that is actually embedded from YouTube or another site, the file lives on that other site, so paste the original link there instead — the X link alone has no video file to offer in that case.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Make sure you copied the link of the post itself — it should contain /status/ followed by a long number. A link to a profile, a timeline, a search, or a list points at a page, not a video, and there is nothing to save. If the link is right and nothing loads, the post may have been deleted, or the account may have switched to protected. If the preview loads but a quality is missing, that quality simply does not exist for that video — X does not create a 720p file for a video that was uploaded at 360p. If your phone keeps opening the X app when you tap a link, copy the link inside the app and paste it into your browser by hand.</p>\n<h2>Why X videos disappear — and why saving them matters</h2>\n<p>Posts on X vanish faster than on any other platform. An account is suspended, a user deletes a post after a backlash, a clip is taken down after a complaint, a news account clears its timeline — and the video goes with it. Journalists, researchers and ordinary users have all learned the same lesson: if a video matters, keep a copy while it is still there, because a bookmark is not a copy. A bookmark points at a post; if the post goes, the bookmark points at nothing. A saved MP4, on the other hand, sits in your Downloads folder whether or not the post survives.</p>\n<p>That is the main reason people save X videos, and it shapes how you should use this page. Save the video when you first see it, not when you need it a week later. Check the file plays before you close the page — a download that stalled halfway is worse than no download, because it looks like a saved file until you try to watch it. And keep the original post link somewhere, in a note or a message to yourself, so you can credit the poster if you ever share the clip. X is a public conversation, and the people in it deserve to be named when their words or footage travel.</p>\n<h2>Saving videos from replies, quote posts and threads</h2>\n<p>Videos on X do not only live in top-level posts. A video can sit inside a reply to someone else's post, inside a quote post that adds a comment above the original, or partway down a thread where one person posts a series of clips. All of these work the same way, as long as you copy the link of the post that actually carries the video. That is the detail people get wrong: copying the link of the first post in a thread saves nothing if the video is in the third post. Open the post with the video, tap Share, and copy its link — the link should contain /status/ followed by a long number, and that number is the post the video belongs to. Quote posts are a special case: the quote itself is a new post, and its link points at the comment, not at the video. Open the original post from inside the quote and copy that link instead.</p>\n<h2>Is it free, and do I need an X account?</h2>\n<p>Yes, it is free, and no account is needed on either side — no sign-up here, no login to X, and the poster is never told you saved their video. Only save videos you have the right to keep, and credit the creator if you share a saved clip anywhere else. On a limited data plan, download on Wi-Fi or pick 360p: even a short 720p clip is several megabytes.</p>",
    faq: [
      ["Is the Twitter video downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public post that carries a video."],
      ["How do I download an X video?", "Copy the post link in the X app, paste it here and tap Get video. When the preview appears, pick a quality — usually 720p, 360p or 180p — and the X video downloads as an MP4 with sound. This X video downloader is free and works on any phone or PC."],
      ["How do I save a Twitter video to my phone?", "Copy the post link in the X app, open this page in your phone browser, paste the link and tap Get video. Pick a quality and the Twitter video to MP4 download saves straight to your phone, with sound — on iPhone to the Files app, on Android to Downloads."],
      ["How do I download an X video on iPhone?", "In the X app tap Share, then Copy link. Open Safari, paste the link here and tap Get video. Choose 720p for the sharpest file and it saves to the Files app under Downloads."],
      ["How do I download an X video on Android?", "Copy the post link, paste it here in Chrome and tap Get video. Pick 720p, 360p or 180p and the MP4 downloads to your Downloads folder, ready to open in your gallery."],
      ["What qualities can I save an X video in?", "X videos are offered as direct files, usually 720p, 360p and 180p, with sound. The list you see after pasting a link is the real list for that post — a video uploaded at 360p has no 720p version."],
      ["Do I need an X account to download a video?", "No. Only the public post link is needed. There is no login here and no login to X, and the poster is never notified."],
      ["Can I save private X videos?", "No. Posts from protected accounts can only be seen by approved followers, so they cannot be read or saved. The same applies to deleted posts."],
      ["Can I download a Twitter GIF?", "Yes, in effect. X stores its short animated GIFs as tiny MP4 videos, so a GIF post saves the same way as any other video — as a short MP4 file with the motion in it."],
      ["Why does my X link not work?", "Check that you copied the link of the post itself — it should contain /status/ followed by a long number. A profile, timeline or search link has no video in it. The post may also have been deleted or the account switched to protected."],
      ["Can I save just the audio from an X video?", "Yes. After pasting the link, choose the Audio option and only the sound is saved — useful for speeches, interviews and press-conference clips."],
      ["Does it work with both x.com and twitter.com links?", "Yes. Both shapes of link point at the same post, and both work here. Copy whichever one your app or browser gives you."]

    ],
  },
  bluesky: {
    name: 'Bluesky',
    keyword: 'Bluesky video downloader',
    title: 'Bluesky Video Downloader — Save Videos in HD | Save Video',
    description: 'Bluesky video downloader: paste a Bluesky post link, preview the video and save the original file with sound. Free, no account, works on phone and PC.',
    h1: 'Bluesky Video Downloader',
    intro: 'A free Bluesky video downloader: paste the post link, preview the clip, and save the original video file with sound. No account, no app to install.',
    example: 'https://bsky.app/profile/livvywivvyy.bsky.social/post/3myw2cqwb2k22',
    about: "<h2>What Bluesky is</h2>\n<p>Bluesky is the decentralised social network that grew out of Twitter's old guard — a familiar timeline of short posts, but built on the AT Protocol, which means no single company owns the network and users can move between servers with their identity intact. Video arrived late on Bluesky and is still a small part of the feed: short clips attached to posts, usually a minute or less, of the same kind people post on X — news moments, funny clips, sports highlights, art in progress. Because Bluesky is young and its video catalogue is small, a Bluesky video link usually arrives from someone sharing a specific post rather than from browsing a feed.</p>\n<p>This page is a Bluesky video downloader: paste the link of a public Bluesky post that carries a video and you can preview it, then save the original video file with sound. No account is needed and nothing has to be installed. A Bluesky link looks like bsky.app/profile/ followed by a handle and /post/ and a short code. You get the file exactly as the author uploaded it, because Bluesky serves the original file. Posts from accounts that have made their posts private, or posts that have been deleted, cannot be read.</p>\n<h2>How to save a Bluesky video</h2>\n<p>Open the post on Bluesky, copy its link from the Share menu or the address bar, then paste the link into the box on this page and tap Get video. On a phone the file saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard video file with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Bluesky video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Bluesky post that carries a video."],
      ["Which Bluesky links work here?", "Public post links work: bsky.app/profile/ links with /post/ and a short code at the end. A profile link points at an account, not a post, so open the post itself and copy its own link."],
      ["What quality do Bluesky videos save in?", "Bluesky serves the original video file as posted, with sound. You get the file exactly as the author uploaded it — no re-compression by this site."],
      ["How do I download a Bluesky video on my phone?", "Copy the post link in your phone browser, paste it here and tap Get video. The file saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and plays in any video app."],
      ["Can I save private Bluesky posts?", "No. Only public posts can be read. Posts that have been deleted, or posts on accounts that restricted them, cannot be saved."],
      ["Do I need a Bluesky account?", "No. Only the public post link is needed. There is no login here and no login to Bluesky, and the author is never told you saved their video."]

    ],
  },
  tumblr: {
    name: 'Tumblr',
    keyword: 'Tumblr video downloader',
    title: 'Tumblr Video Downloader — Save Videos as MP4 | Save Video',
    description: 'Tumblr video downloader: paste a Tumblr video post link, preview it and save the original MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Tumblr Video Downloader',
    intro: 'A free Tumblr video downloader: paste the post link, preview the clip, and save the original MP4 with sound. Works with native video posts uploaded to Tumblr.',
    example: 'https://high-quality-tiktoks.tumblr.com/post/698923599747235841/she-accidentally-turned-off-her-game-and-politely',
    about: "<h2>What Tumblr is</h2>\n<p>Tumblr is the internet's scrapbook. It has been running since 2007, and its users — mostly artists, writers, fans and teenagers — fill it with images, text, quotes and short videos, reblogging each other's posts into long chains that can run for years. Video on Tumblr is different from video anywhere else: it is usually short, looped, and buried inside a post that is mostly about something else — a reaction clip, a scene from a show, a piece of animation, a pet video. Tumblr's own video player hosts the native video posts, and those are the ones that can be saved here.</p>\n<p>This page is a Tumblr video downloader: paste the link of a public Tumblr post that carries a native video and you can preview it, then save the original MP4 with sound — usually 720p or 1080p. No account is needed and nothing has to be installed. A Tumblr post link looks like a blog name followed by tumblr.com/post/ and a long number. Two things do not work and are worth knowing in advance: GIF posts are images, not videos, so there is no video file to save; and a post that embeds a video from YouTube or another site has no video file on Tumblr at all — the file lives on the other site, so paste that site's link on its own page instead.</p>\n<h2>How to save a Tumblr video</h2>\n<p>Open the post on Tumblr, copy its link from the address bar or the Share menu, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Tumblr video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Tumblr post that carries a native video."],
      ["Which Tumblr posts work here?", "Only posts with a video uploaded to Tumblr itself can be saved. GIF posts are images, not videos, and posts that embed a player from YouTube or another site have no video file on Tumblr — paste the original link on that site's page instead."],
      ["What quality do Tumblr videos save in?", "Tumblr serves the original MP4 as uploaded, with sound — usually 720p or 1080p. You get the file exactly as the author uploaded it, with no re-compression by this site."],
      ["How do I download a Tumblr video on my phone?", "Copy the post link in your phone browser, paste it here and tap Get video. The MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and plays in any video app."],
      ["Why does my Tumblr link not load?", "Check the post actually carries a native video: GIF posts and embedded players from other sites have no Tumblr video file. The post may also be private, deleted, or on a blog that requires a login."],
      ["Do I need a Tumblr account?", "No. Only the public post link is needed. There is no login here and no login to Tumblr, and the author is never told you saved their video."]

    ],
  },
  twitch: {
    name: 'Twitch',
    keyword: 'Twitch clip downloader',
    title: 'Twitch Clip Downloader — Save Twitch Clips | Save Video',
    description: 'Twitch clip downloader: paste a Twitch clip link, preview it and save the clip as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Twitch Clip Downloader',
    intro: 'A free Twitch clip downloader: paste the clip link, preview it, and save the clip as MP4 with sound. Works with public clips from clips.twitch.tv or twitch.tv.',
    example: 'https://clips.twitch.tv/CharmingRudeStorkPhilosoraptor-LfhoaF0fD2wwl-hr',
    about: "<h2>What Twitch is</h2>\n<p>Twitch is the home of live streaming. Gamers play for hours with thousands of people watching and chatting; musicians perform; cooks cook; artists draw; and \"just chatting\" streamers simply talk to their audience. A Twitch channel is a live place first and a library second, and the moments people want to keep are almost always clips — short slices cut out of a stream by a viewer, usually thirty to sixty seconds long, capturing a funny fail, an incredible play, or a reaction that becomes a meme. A clip is the only part of Twitch that has a single file you can save.</p>\n<p>This page is a Twitch clip downloader: paste the link of a public Twitch clip and you can preview it, then save the clip as an MP4 with sound, up to 1080p. No account is needed and nothing has to be installed. A clip link looks like clips.twitch.tv followed by the clip's name, or twitch.tv followed by the channel and /clip/ and the name. That shape is the important part: a link to a channel, a category, or a live stream is not a clip link, and it has no single file behind it.</p>\n<h2>What you cannot save from Twitch</h2>\n<p>Full broadcasts — VODs — cannot be saved here, and this is the limit that matters most on this page. A VOD is delivered as a long segmented stream, not as one file, so there is no single MP4 to offer, and very long videos cannot be downloaded as one file for the same reason. A stream that is live right now cannot be saved while it is live. Subscriber-only VODs and clips cannot be read without the access they require. And a clip that has been deleted, or a clip from a channel that has been banned, is gone. If the moment you want was never clipped, it cannot be downloaded as a clip: a viewer or the streamer has to clip it first.</p>\n<h2>How to save a Twitch clip</h2>\n<p>Open the clip on Twitch, copy its link from the address bar or the Share menu, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save clips you have the right to keep, and credit the streamer if you post a saved clip anywhere else.</p>",
    faq: [
      ["Is the Twitch clip downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Twitch clip."],
      ["Can I save full Twitch broadcasts (VODs)?", "No. Full broadcasts stream only and have no single file to save — only short clips can be saved as MP4. Very long videos cannot be downloaded as one file."],
      ["Which Twitch links work here?", "Clip links work: clips.twitch.tv links, or twitch.tv channel links with /clip/ in them. A channel, category or live-stream link has no clip in it, so open the clip itself and copy its own link."],
      ["What quality do Twitch clips save in?", "Clips are offered up to 1080p with sound, exactly as Twitch serves them. Clips are short, so the file is small and downloads quickly."],
      ["How do I download a Twitch clip on my phone?", "Copy the clip link in your phone browser, paste it here and tap Get video. The MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and plays in any video app."],
      ["Why does my Twitch link not load?", "Check you copied a clip link rather than a channel or VOD link — only clips have a single file. The clip may also be deleted, subscriber-only, or from a banned channel."]

    ],
  },
  pinterest: {
    name: 'Pinterest',
    keyword: 'Pinterest video downloader',
    title: 'Pinterest Video Downloader — Save Pins as MP4 | Save Video',
    description: 'Pinterest video downloader: paste a Pinterest pin link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Pinterest Video Downloader',
    intro: 'A free Pinterest video downloader: paste the pin link, preview the video, and save it as MP4 with sound. Works with public video pins.',
    example: 'https://www.pinterest.com/pin/aao-milo-chalein--874683558918923586/',
    about: "<h2>What Pinterest is</h2>\n<p>Pinterest is a visual discovery engine — a giant pinboard where people collect images and videos of things they want to try, make, buy or visit. Recipes, home decor, wedding ideas, hairstyles, travel spots, DIY projects, workout routines: the ideas are saved as pins, and a growing share of pins are now short videos rather than still images. A Pinterest video is usually a demonstration — a recipe being cooked, a room being painted, a dress being tried on — filmed vertically and meant to be watched once and then tried in real life. Saving it means keeping the demonstration instead of only the idea.</p>\n<p>This page is a Pinterest video downloader: paste the link of a public Pinterest video pin and you can preview it, then save it as an MP4 with sound, in the quality the pin was uploaded. No account is needed and nothing has to be installed. A pin link looks like pinterest.com/pin/ followed by a number, and short pin.it links point at the same pin — both work here. Image pins have no video file, so only a pin that actually plays as a video can be saved. Private boards and secret pins cannot be read.</p>\n<h2>How to save a Pinterest video</h2>\n<p>Open the pin on Pinterest, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep, and credit the creator if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the Pinterest video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Pinterest video pin."],
      ["Which Pinterest links work here?", "Public video pins work: pinterest.com/pin/ links and short pin.it links. Image pins have no video file, so only a pin that actually plays as a video can be saved — open the pin and check it plays first."],
      ["What quality do Pinterest videos save in?", "Pinterest serves the pin video as an MP4 with sound, in the quality the pin was uploaded. Most Pinterest videos are vertical and modest in size, so the file downloads quickly."],
      ["How do I download a Pinterest video on my phone?", "Copy the pin link in the Pinterest app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Can I save videos from private Pinterest boards?", "No. Only public pins can be read. Pins on secret boards, and pins from private accounts, cannot be saved."],
      ["Why does my Pinterest link not load?", "Check the pin is actually a video — an image pin has no video file. Also check you copied a pin link rather than a board or profile link, and that the pin is public and not deleted."]

    ],
  },
  moj: {
    name: 'Moj',
    keyword: 'Moj video downloader',
    title: 'Moj Video Downloader — Save Moj Videos as MP4 | Save Video',
    description: 'Moj video downloader: paste a Moj video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Moj Video Downloader',
    intro: 'A free Moj video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public Moj videos.',
    example: 'https://mojapp.in/@kamyabi/video/4002006172',
    about: "<h2>What Moj is</h2>\n<p>Moj is India's home-grown short-video app, built by ShareChat after TikTok left the country. Its videos are short — usually fifteen to sixty seconds — vertical, and overwhelmingly in Indian languages: Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Punjabi and more. Comedy sketches, dance trends, devotional clips, village life, farming tips, cricket moments and small-business adverts fill the feed, and the creators are often people filming on a basic phone in a small town rather than influencers in a studio. For hundreds of millions of viewers, Moj is simply where short video lives now.</p>\n<p>This page is a Moj video downloader: paste the link of a public Moj video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A Moj link looks like mojapp.in/@username/video/ followed by a number, and that number is the video itself — copy it from the Share menu in the app. Private videos cannot be read, and neither can videos that have been deleted.</p>\n<h2>How to save a Moj video</h2>\n<p>Open the video in the Moj app, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep, and credit the creator if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the Moj video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Moj video."],
      ["Which Moj links work here?", "Public video links work: mojapp.in/@username/video/ links with a number at the end. A profile link points at a creator, not a video, so open the video itself and copy its own link from the Share menu."],
      ["What quality do Moj videos save in?", "Moj serves its videos as MP4 files with sound, in the quality they were uploaded — usually 720p. Moj clips are short, so the file is small and downloads quickly even on a slow connection."],
      ["How do I download a Moj video on my phone?", "Copy the video link in the Moj app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Can I save private Moj videos?", "No. Moj videos on private accounts can only be seen by approved followers, so they cannot be read or saved. Deleted videos are gone too."],
      ["Why does my Moj link not load?", "Check you copied a video link rather than a profile link, and check the video is still public and not deleted. Copy the link again from the Share menu — the first tap sometimes fails to copy it."]

    ],
  },
  sharechat: {
    name: 'ShareChat',
    keyword: 'ShareChat video downloader',
    title: 'ShareChat Video Downloader — Save as MP4 | Save Video',
    description: 'ShareChat video downloader: paste a ShareChat video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'ShareChat Video Downloader',
    intro: 'A free ShareChat video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public ShareChat videos.',
    example: 'https://sharechat.com/video/8r89QKxa',
    about: "<h2>What ShareChat is</h2>\n<p>ShareChat is India's largest social network in Indian languages, and video is its beating heart. Where other networks run mostly in English, ShareChat runs in fifteen languages — Hindi, Bengali, Tamil, Telugu, Malayalam, Marathi, Gujarati, Punjabi, Odia, Assamese and more — and its videos reflect that: devotional songs, comedy in regional dialects, farming advice, local news, festival clips, cricket reactions and family videos, all shared inside language communities that rarely meet on English-language apps. A ShareChat video is often the only copy of a local moment that exists, which is why people save them to keep and to forward in family groups.</p>\n<p>This page is a ShareChat video downloader: paste the link of a public ShareChat video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A ShareChat link looks like sharechat.com/video/ followed by a short code, and that code is the video itself — copy it from the Share menu. ShareChat also carries photos, text posts and audio clips, but only video posts have a video file to save. Private videos cannot be read, and neither can videos that have been deleted.</p>\n<h2>How to save a ShareChat video</h2>\n<p>Open the video in the ShareChat app, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the ShareChat video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public ShareChat video."],
      ["Which ShareChat links work here?", "Public video links work: sharechat.com/video/ links with a short code at the end. Photo posts, text posts and audio clips have no video file, so only a video post can be saved — open it and copy its own link."],
      ["What quality do ShareChat videos save in?", "ShareChat serves its videos as MP4 files with sound, in the quality they were uploaded. ShareChat clips are short, so the file is small and downloads quickly even on a slow connection."],
      ["How do I download a ShareChat video on my phone?", "Copy the video link in the ShareChat app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Can I save private ShareChat videos?", "No. ShareChat videos shared only with a limited audience cannot be read. Only public ShareChat videos can be saved, and deleted ones are gone."],
      ["Why does my ShareChat link not load?", "Check you copied a video link rather than a photo, text or profile link, and check the video is still public and not deleted. Copy the link again from the Share menu if the first tap did not copy it."]

    ],
  },
  linkedin: {
    name: 'LinkedIn',
    keyword: 'LinkedIn video downloader',
    title: 'LinkedIn Video Downloader — Save as MP4 | Save Video',
    description: 'LinkedIn video downloader: paste a LinkedIn post link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'LinkedIn Video Downloader',
    intro: 'A free LinkedIn video downloader: paste the post link, preview the video, and save it as MP4 with sound. Works with public LinkedIn posts that carry a video.',
    example: 'https://www.linkedin.com/posts/andreban_webmcp-agenticweb-ai-activity-7500591659466960897-sKKi',
    about: "<h2>What LinkedIn is</h2>\n<p>LinkedIn is the professional network, and video there is work video: a founder explaining a product, a recruiter talking about a role, a conference talk, a company showing its factory, a coach giving career advice, a researcher presenting results. LinkedIn videos are usually short — one to three minutes — filmed simply, and watched by people who are deciding whether to hire, buy, or follow. Saving one means keeping a talk or a demonstration you want to show a colleague, quote in a meeting, or watch again before an interview.</p>\n<p>This page is a LinkedIn video downloader: paste the link of a public LinkedIn post that carries a native video and you can preview it, then save it as an MP4 with sound — usually 720p or 640p. No account is needed and nothing has to be installed. A LinkedIn post link looks like linkedin.com/posts/ followed by a name and a long code. Two things do not work: a post that only links to a video on YouTube or another site has no video file on LinkedIn, so paste the original link on that site's page instead; and posts inside private groups or on locked profiles cannot be read.</p>\n<h2>How to save a LinkedIn video</h2>\n<p>Open the post on LinkedIn, copy its link from the Share menu or the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep, and credit the author if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the LinkedIn video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public LinkedIn post that carries a video."],
      ["Which LinkedIn posts work here?", "Public posts with a native video work: linkedin.com/posts/ links. A post that only links to a video on YouTube or another site has no video file on LinkedIn — paste the original link on that site's page instead."],
      ["What quality do LinkedIn videos save in?", "LinkedIn serves its videos as MP4 files, usually 720p and 640p with sound. The list you see after pasting a link is the real list for that post."],
      ["How do I download a LinkedIn video on my phone?", "Copy the post link in the LinkedIn app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Can I save videos from private LinkedIn posts?", "No. Only public posts can be read. Posts inside private groups, on locked profiles, or shared only with connections cannot be saved."],
      ["Why does my LinkedIn link not load?", "Check you copied a post link rather than a profile, company page or feed link, and check the post carries a native video rather than a link to another site. The post may also be private or deleted."]

    ],
  },
  snapchat: {
    name: 'Snapchat',
    keyword: 'Snapchat video downloader',
    title: 'Snapchat Video Downloader — Save Spotlight | Save Video',
    description: 'Snapchat video downloader: paste a Snapchat Spotlight link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Snapchat Video Downloader',
    intro: 'A free Snapchat video downloader for Spotlight videos: paste the Spotlight link, preview it, and save it as MP4 with sound. Works with public Spotlight videos.',
    example: 'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZ2xobHJkZ3FqAZSt3AdfAZSt3AdOAAAAAQ',
    about: "<h2>What Snapchat is</h2>\n<p>Snapchat is the camera-first app where most of what is shared disappears. Friends send snaps that vanish after viewing, and stories that vanish after twenty-four hours. The exception is Spotlight: Snapchat's public short-video feed, where anyone can post a funny clip, a trick, a dance or a moment, and anyone can watch it. Spotlight videos are the only Snapchat videos with a lasting public link, and they are the only ones that can be saved here. A Spotlight link looks like snapchat.com/spotlight/ followed by a long code, and that code is the video itself.</p>\n<p>This page is a Snapchat video downloader for Spotlight videos: paste a public Spotlight link and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. Two things do not work, and they follow from how Snapchat is built: a story disappears after twenty-four hours, so an expired story is gone and a story link has no lasting video to save; and a private snap sent to one person was never public at all. Only Spotlight videos — public, lasting, and made to be watched by anyone — can be saved.</p>\n<h2>How to save a Snapchat Spotlight video</h2>\n<p>Open the Spotlight video in Snapchat, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep, and credit the creator if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the Snapchat video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Snapchat Spotlight video."],
      ["Which Snapchat links work here?", "Spotlight video links work: snapchat.com/spotlight/ links with a long code at the end. Stories disappear after twenty-four hours and have no lasting video link, and private snaps were never public, so neither can be saved."],
      ["What quality do Snapchat videos save in?", "Spotlight videos are served as MP4 files with sound, in the quality they were uploaded. Spotlight clips are short, so the file is small and downloads quickly."],
      ["Can I download a Snapchat story?", "No. Stories last only twenty-four hours and then disappear, and this page is built for Spotlight videos, not stories. Paste the link of a Spotlight video instead."],
      ["How do I download a Snapchat video on my phone?", "Copy the Spotlight link in the Snapchat app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Why does my Snapchat link not load?", "Check you copied a Spotlight link rather than a story or chat link — only Spotlight videos have a lasting public link. The video may also have been deleted by its creator."]

    ],
  },
  tencent: {
    name: 'Tencent Video',
    keyword: 'Tencent Video downloader',
    title: 'Tencent Video Downloader — Save as MP4 | Save Video',
    description: 'Tencent Video downloader: paste a Tencent Video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Tencent Video Downloader',
    intro: 'A free Tencent Video downloader: paste the video link, preview it, and save it as MP4 with sound. Works with public Tencent Video videos.',
    example: 'https://v.qq.com/x/page/t0338rg171l.html',
    about: "<h2>What Tencent Video is</h2>\n<p>Tencent Video is one of China's big three streaming platforms, and its catalogue is dominated by drama: Chinese television series, variety shows, films, animation and sports, much of it produced or licensed by Tencent itself. It is the platform where a new drama premieres, where a variety show trends, and where a football match is streamed to millions. The site is entirely in Chinese and aimed at viewers in China, and a large share of its best content sits behind a VIP subscription — those episodes are paid content and cannot be saved. The free, public videos are the ones this page works with.</p>\n<p>This page is a Tencent Video downloader: paste the link of a public Tencent Video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded — usually 480p or lower for free videos. No account is needed and nothing has to be installed. A video page link looks like v.qq.com/x/page/ followed by a code, and that code is the video itself. Cover pages — v.qq.com/x/cover/ links — point at a whole series rather than one episode, and they do not always offer a file to save, so open the episode itself and copy its own link.</p>\n<h2>How to save a Tencent video</h2>\n<p>Open the video on Tencent Video, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Tencent Video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Tencent Video."],
      ["Which Tencent Video links work here?", "Video page links work: v.qq.com/x/page/ links with a code at the end. Cover pages — v.qq.com/x/cover/ links — point at a whole series and do not always offer a file, so open the episode itself and copy its own link."],
      ["What quality do Tencent videos save in?", "Tencent Video serves its videos as MP4 files with sound, in the quality the video was uploaded — usually 480p or lower for free videos. VIP-only videos cannot be saved."],
      ["Can I download VIP-only Tencent dramas?", "No. VIP-only videos are paid content and cannot be saved. Only public, free Tencent videos can be downloaded."],
      ["How do I download a Tencent video on my phone?", "Copy the video page link from the Tencent Video address bar, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads — Files on iPhone, the Downloads folder on Android."],
      ["Why does my Tencent link not load?", "Check you copied a video page link rather than a cover or series link, and check the episode is free and public — VIP-only episodes cannot be read. The video may also be deleted or restricted to viewers in China."]

    ],
  },
  kuaishou: {
    name: 'Kuaishou',
    keyword: 'Kuaishou video downloader',
    title: 'Kuaishou Video Downloader — Save Videos as MP4 | Save Video',
    description: 'Kuaishou video downloader: paste a Kuaishou video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Kuaishou Video Downloader',
    intro: 'A free Kuaishou video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with kuaishou.com short-video links, kwai.com links and v.kuaishou.com short links. No account, no app to install.',
    example: 'https://www.kuaishou.com/short-video/3x7edaa985qmhqy',
    about: "<h2>What Kuaishou is</h2>\n<p>Kuaishou is China's other giant short-video app — the one that grew up outside the big cities, in small towns and villages, while its rival chased the metropolises. Its videos are short and unpolished by design: farmers showing a harvest, cooks in a village kitchen, fishermen mending nets, truck drivers on the road, families celebrating, craftsmen at work. The app's motto is roughly \"see every kind of life\", and its feed really does look like that. Kuaishou is also the parent of Kwai, the version of the same app that runs outside China in Latin America and Southeast Asia, so a link from either app points at the same kind of video.</p>\n<p>This page is a Kuaishou video downloader: paste the link of a public Kuaishou video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded — usually 720p. No account is needed and nothing has to be installed. Kuaishou links come in several shapes: kuaishou.com/short-video links, kwai.com links, and short v.kuaishou.com links, and all of them work here. Private videos cannot be read, and neither can videos that have been deleted. A video that Kuaishou restricts to viewers in China will not load for a visitor outside China.</p>\n<h2>How to save a Kuaishou video</h2>\n<p>Open the video in the Kuaishou app, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Kuaishou video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Kuaishou video."],
      ["Which Kuaishou links work here?", "Short-video links work: kuaishou.com/short-video links, kwai.com links and short v.kuaishou.com links. A profile or feed link has no single video in it, so copy the link of the video itself from the Share menu."],
      ["What quality do Kuaishou videos save in?", "Kuaishou serves its videos as MP4 files with sound, in the quality they were uploaded — usually 720p. The clips are short, so the file is small and downloads quickly."],
      ["Is Kwai the same as Kuaishou?", "Almost. Kwai is the international version of Kuaishou, run by the same company outside China. Kwai video links work on the Kwai page here, and Kuaishou links work on this page — the two apps share the same short-video format."],
      ["How do I download a Kuaishou video on my phone?", "Copy the video link in the Kuaishou app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Why does my Kuaishou link not load?", "Check you copied a video link rather than a profile link, and check the video is still public and not deleted. Some Kuaishou videos are restricted to viewers in China and will not load from outside the country."]

    ],
  },
  haokan: {
    name: 'Haokan',
    keyword: 'Haokan video downloader',
    title: 'Haokan Video Downloader — Save Videos as MP4 | Save Video',
    description: 'Haokan video downloader: paste a Haokan link and save it in SD, HD, 1080p or 2K as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Haokan Video Downloader',
    intro: 'A free Haokan video downloader: paste the video link, preview the clip, and save it as MP4 with sound in SD, HD, Super clear, 1080p or 2K. No account, no app to install.',
    example: 'https://haokan.baidu.com/v?vid=12828130032776245970',
    about: "<h2>What Haokan is</h2>\n<p>Haokan is Baidu's video platform — the video arm of China's biggest search engine — and it is built around longer, calmer video than the short-video apps. Documentaries, history programmes, science explainers, travel films, food shows, car reviews and everyday-life vlogs fill its catalogue, usually running several minutes rather than a few seconds. Because it belongs to Baidu, Haokan videos turn up constantly in Chinese search results, so a link to Haokan often arrives from a search rather than from inside the app. The platform is entirely in Chinese, and its videos are mostly aimed at viewers in China.</p>\n<p>This page is a Haokan video downloader: paste the link of a public Haokan video and you can preview it, then save it as an MP4 with sound. No account is needed and nothing has to be installed. Haokan is unusual in the range of qualities it offers — SD, HD, Super clear, 1080p and even 2K, depending on the video — so the list you see after pasting a link is worth reading before you pick. A Haokan link looks like haokan.baidu.com/v?vid= followed by a long number, and that number is the video itself. Private or deleted videos cannot be read, and videos restricted to viewers in China will not load from outside the country.</p>\n<h2>How to save a Haokan video</h2>\n<p>Open the video on Haokan, copy its link from the address bar, then paste the link into the box on this page and tap Get video. Pick a quality — 1080p is the sharpest most videos offer, and 2K appears for the best uploads — and the MP4 saves to Downloads on a phone or to your Downloads folder on a computer. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Haokan video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Haokan video."],
      ["Which Haokan links work here?", "Video page links work: haokan.baidu.com/v?vid= links with a long number at the end. A search page or a channel page has no single video in it, so open the video itself and copy its own link."],
      ["What qualities do Haokan videos save in?", "Haokan offers SD, HD, Super clear, 1080p and 2K as MP4 files with sound, depending on the video. The list you see after pasting a link is the real list for that video — pick 1080p or 2K for the sharpest file."],
      ["How do I download a Haokan video on my phone?", "Copy the video link from the Haokan address bar, paste it here in your phone browser and tap Get video. Pick a quality — 1080p if the video offers it — and the MP4 saves to Downloads on your phone."],
      ["Can I download a Haokan video in 2K?", "Yes, when the video was uploaded in 2K. After you paste a link you will see the real qualities for that video, and 2K is offered whenever the upload supports it. Most videos top out at 1080p."],
      ["Why does my Haokan link not load?", "Check you copied a video link with a vid number, not a search or channel link. The video may be private or deleted, or restricted to viewers in China — Haokan is a Chinese platform and some videos will not load from outside the country."]

    ],
  },
  pear: {
    name: 'Pear Video',
    keyword: 'Pear Video downloader',
    title: 'Pear Video Downloader — Save Pear Videos as MP4 | Save Video',
    description: 'Pear Video downloader: paste a Pear Video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Pear Video Downloader',
    intro: 'A free Pear Video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with pearvideo.com video links. No account, no app to install.',
    example: 'https://www.pearvideo.com/video_1808207',
    about: "<h2>What Pear Video is</h2>\n<p>Pear Video is a Chinese short-video platform with a newsroom at its heart. Its videos are short — usually one to three minutes — and they are made by a mix of professional journalists and ordinary people filming what is in front of them: a street rescue, a craftsman at work, a village festival, an unusual animal, a local character with a story to tell. The tone is closer to a news clip than to a dance trend, and the catalogue reads like a diary of everyday China. Pear Video's name comes from the idea of a pear: small, everyday, and worth a bite.</p>\n<p>This page is a Pear Video downloader: paste the link of a public Pear Video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A Pear Video link looks like pearvideo.com/video_ followed by a number, and that number is the video itself — copy it from the address bar. Private or deleted videos cannot be read, and videos restricted to viewers in China will not load from outside the country.</p>\n<h2>How to save a Pear Video</h2>\n<p>Open the video on Pear Video, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Pear Video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Pear Video."],
      ["Which Pear Video links work here?", "Video links work: pearvideo.com/video_ links with a number at the end. A homepage or category link has no single video in it, so open the video itself and copy its own link from the address bar."],
      ["What quality do Pear Videos save in?", "Pear Video serves its videos as MP4 files with sound, in the quality they were uploaded. The clips are short, so the file is small and downloads quickly even on a slow connection."],
      ["How do I download a Pear Video on my phone?", "Copy the video link from the Pear Video address bar, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads — Files on iPhone, the Downloads folder on Android — and the clip is short, so it downloads in seconds."],
      ["Can I save private Pear Videos?", "No. Only public Pear Videos can be read. A private or deleted Pear Video cannot be saved."],
      ["Why does my Pear Video link not load?", "Check you copied a video link with a video number, not a homepage or category link. The video may be private or deleted, or restricted to viewers in China."]

    ],
  },
  zhihu: {
    name: 'Zhihu',
    keyword: 'Zhihu video downloader',
    title: 'Zhihu Video Downloader — Save Videos as MP4 | Save Video',
    description: 'Zhihu video downloader: paste a Zhihu video link, preview it and save it in 480p, 720p or 1080p as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Zhihu Video Downloader',
    intro: 'A free Zhihu video downloader: paste the video link, preview the clip, and save it as MP4 with sound in 480p, 720p or 1080p. Works with zhihu.com/zvideo/… links. No account, no app to install.',
    example: 'https://www.zhihu.com/zvideo/1342930761977176064',
    about: "<h2>What Zhihu is</h2>\n<p>Zhihu is China's biggest question-and-answer site — its equivalent of Quora — and video has become one of its main formats. The videos are almost all explanatory: a doctor explaining a symptom, an engineer walking through a bridge, a historian telling a story, a lawyer answering a legal question, a cook demonstrating a technique. They are usually a few minutes long, filmed simply, and watched by people who came with a question rather than to be entertained. That makes Zhihu videos unusually worth saving: a good explanation is the kind of thing you want to watch twice, or send to someone who asked the same question.</p>\n<p>This page is a Zhihu video downloader: paste the link of a public Zhihu video and you can preview it, then save it as an MP4 with sound in 480p, 720p or 1080p, depending on the video. No account is needed and nothing has to be installed. A Zhihu video link looks like zhihu.com/zvideo/ followed by a long number, and that number is the video itself. Answers on Zhihu are often text with a video attached, so make sure you copy the link of the video, not the link of the question page. Private or deleted videos cannot be read.</p>\n<h2>How to save a Zhihu video</h2>\n<p>Open the video on Zhihu, copy its link from the address bar, then paste the link into the box on this page and tap Get video. Pick a quality — 1080p is the sharpest most videos offer — and the MP4 saves to Downloads on a phone or to your Downloads folder on a computer. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Zhihu video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Zhihu video."],
      ["Which Zhihu links work here?", "Video links work: zhihu.com/zvideo/ links with a long number at the end. A question page or an answer page is not a video link — open the video itself and copy its own link from the address bar."],
      ["What qualities do Zhihu videos save in?", "Zhihu offers 480p, 720p and 1080p as MP4 files with sound, depending on the video. The list you see after pasting a link is the real list for that video — pick 1080p for the sharpest file."],
      ["How do I download a Zhihu video on my phone?", "Copy the zvideo link from the Zhihu address bar, paste it here in your phone browser and tap Get video. Pick a quality and the MP4 saves to Downloads — Files on iPhone, the Downloads folder on Android."],
      ["Can I download a Zhihu video in 1080p?", "Yes, when the video was uploaded in 1080p. After you paste a link you will see the real qualities for that video, and 1080p is offered whenever the upload supports it."],
      ["Why does my Zhihu link not load?", "Check you copied a zvideo link rather than a question or answer link — Zhihu pages mix text and video, and only the video's own link works. The video may also be private or deleted."]

    ],
  },
  sohu: {
    name: 'Sohu',
    keyword: 'Sohu video downloader',
    title: 'Sohu Video Downloader — Save Sohu Videos as MP4 | Save Video',
    description: 'Sohu video downloader: paste a Sohu video link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Sohu Video Downloader',
    intro: 'A free Sohu video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with tv.sohu.com video links. No account, no app to install.',
    example: 'https://tv.sohu.com/v/dXMvNDQxNzU2MjE5LzY5NjY5MzkxNC5zaHRtbA==.html',
    about: "<h2>What Sohu is</h2>\n<p>Sohu is one of China's oldest internet companies, and Sohu Video is its streaming arm. Its catalogue leans towards entertainment: television dramas, variety shows, films, news clips and sports highlights, much of it produced or licensed in China. Sohu TV was an early pioneer of online drama in China, and its video pages still carry that flavour — long episodes, studio shows, and celebrity interviews rather than short clips. The site is entirely in Chinese and aimed at viewers in China, so a Sohu link usually arrives from someone sharing an episode or a show segment.</p>\n<p>This page is a Sohu video downloader: paste the link of a public Sohu video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A Sohu video link looks like tv.sohu.com/v/ followed by a long code, and that code is the video itself — copy it from the address bar. Paid dramas and VIP-only episodes cannot be saved, and neither can deleted videos or videos restricted to viewers in China.</p>\n<h2>How to save a Sohu video</h2>\n<p>Open the video on Sohu TV, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Sohu video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Sohu video."],
      ["Which Sohu links work here?", "Video page links work: tv.sohu.com/v/ links with a long code at the end. A channel, drama series page or homepage link has no single video in it, so open the episode itself and copy its own link."],
      ["What quality do Sohu videos save in?", "Sohu offers its videos as MP4 files with sound, in the quality the video was uploaded. Episodes are long, so the file can be large — download on Wi-Fi where you can."],
      ["Can I download VIP-only Sohu dramas?", "No. Paid dramas and VIP-only episodes cannot be saved. Only public, free Sohu videos can be downloaded."],
      ["How do I download a Sohu video on my phone?", "Copy the episode link from the Sohu TV address bar, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads, but episodes are long, so use Wi-Fi — the file can be several hundred megabytes."],
      ["Why does my Sohu link not load?", "Check you copied a video link rather than a series or homepage link, and check the episode is free and public — VIP-only episodes cannot be read. The video may also be deleted or restricted to viewers in China."]

    ],
  },
  vimeo: {
    name: 'Vimeo',
    keyword: 'Vimeo video downloader',
    title: 'Vimeo Video Downloader — Save Videos in HD | Save Video',
    description: 'Vimeo video downloader: paste a Vimeo link, preview the video and save it as MP4 with sound in up to 1080p. Free, no account, works on phone and PC.',
    h1: 'Vimeo Video Downloader',
    intro: 'A free Vimeo video downloader: paste the video link, preview the clip, and save it as MP4 with sound in the quality it was uploaded — up to 1080p. No account, no app to install.',
    example: 'https://vimeo.com/76979871',
    about: "<h2>What Vimeo is, and what you can save from it</h2>\n<p>Vimeo is the quiet professional of video sites. Where other platforms chase viral clips, Vimeo hosts short films, wedding films, documentaries, music videos, animations, showreels, conference talks and advertisements — work made by filmmakers, studios, agencies and schools, usually in high quality and usually meant to be watched properly, not scrolled past. A Vimeo link often arrives in a work context: a client sends a showreel, a teacher shares a documentary, a wedding videographer delivers a film, a band shares a new video. Saving it means keeping a copy you can watch offline or show to someone without relying on a connection.</p>\n<p>This page is a Vimeo video downloader: paste the link of a public Vimeo video and you can preview it, then save it as an MP4 with sound in the quality it was uploaded — up to 1080p. There is no account to create and no app to install. The file you get is the video as Vimeo serves it, which for Vimeo usually means a clean, well-encoded file, because Vimeo's uploaders tend to care about quality.</p>\n<p>Vimeo links look like vimeo.com followed by a number — that number is the video itself. Vimeo also has showcase and channel pages, and links to those pages point at collections, not at a single video, so always copy the link of the video itself.</p>\n<h2>How to download a Vimeo video on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved video ends up in the Files app.</p>\n<ol>\n<li>Open the Vimeo video in your browser or the Vimeo app.</li>\n<li>Tap Share, then Copy link — or copy the address from the address bar if you are in a browser.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, pick a quality. The highest available is usually 1080p.</li>\n<li>Tap Download. Safari saves the MP4 to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the video to play it. From there you can move it into Photos, send it in a message, or AirDrop it to a Mac. Vimeo films are often long, so the file can be large — download on Wi-Fi if you can.</p>\n<h2>How to download a Vimeo video on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>Open the Vimeo video, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Pick a quality from the list and let Chrome download the MP4.</li>\n<li>Find it in the Files app under Downloads, or in your gallery app.</li>\n</ol>\n<p>The file is a standard MP4 with sound, so any gallery or video player can open it. If Chrome asks for permission to store files, allow it once.</p>\n<h2>How to download a Vimeo video on PC</h2>\n<p>On a computer, Vimeo runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open vimeo.com in your browser and open the video.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Choose a quality and save the MP4 to your Downloads folder.</li>\n</ol>\n<p>On a PC the highest available quality — usually 1080p — is the right choice for a film or a showreel, since storage is rarely a problem. The MP4 plays in any media player, and if you want to use the clip in an edit, save the highest quality first.</p>\n<h2>What quality will I get?</h2>\n<p>Vimeo serves its videos as progressive MP4 files with sound, and the list you see after pasting a link is the real list for that video.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>1080p</td><td>The sharpest MP4 Vimeo usually offers, with sound</td><td>Films, showreels and watching on a bigger screen</td></tr>\n<tr><td>720p</td><td>A high-definition MP4 with sound</td><td>General watching and sharing</td></tr>\n<tr><td>540p / 360p / 240p</td><td>Smaller MP4 files with sound</td><td>Slow connections and saving space</td></tr>\n<tr><td>Audio</td><td>Just the sound from the video</td><td>Talks, interviews and music</td></tr>\n</table>\n<p>MP4 is the video format: picture and sound together in one file that plays on any modern device. Not every Vimeo video has a 1080p file — a video uploaded at 720p has no sharper version, and downloading cannot add detail that was never uploaded.</p>\n<h2>What you cannot download from Vimeo</h2>\n<p>Vimeo gives its uploaders strong privacy controls, and those controls are respected here. Private videos cannot be read — only the people the uploader invited can see them. Password-protected videos cannot be read without the password, and this page never asks for one. Videos set to hide from vimeo.com, or restricted to particular websites, cannot be read from here. Videos that have been deleted are gone. A video embedded on another website is still a Vimeo video, but the link you need is the vimeo.com link of the video itself, not the address of the page it is embedded in — copy the video's own link from the player if you can. And Vimeo On Demand titles — films you rent or buy — are paid content and cannot be saved.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Make sure you copied the link of the video itself — vimeo.com followed by a number. A showcase, channel or profile link points at a collection, not a video, and there is nothing to save. If the link is right and nothing loads, the video is probably private, password-protected, or set to hide from vimeo.com. If the preview loads but the highest quality is missing, that quality simply does not exist for that upload. If a download starts but seems to stall, the file may be large — Vimeo films run long — so wait, stay on Wi-Fi, and try again once before assuming it failed.</p>\n<h2>Why filmmakers choose Vimeo</h2>\n<p>Understanding why a video is on Vimeo helps you understand what you are saving. Filmmakers choose Vimeo over the bigger platforms for three reasons: the player is clean, with no recommended videos pulling the viewer away at the end; the encoding is careful, so a film looks the way its maker intended; and the audience is other professionals, not an algorithm. A showreel on Vimeo is a job application. A wedding film on Vimeo is a product a couple paid for. A short film on Vimeo is often a festival entry. That is why Vimeo videos deserve a little more care than a random clip: they are someones finished work, presented in the best light its maker could manage, and saving one means keeping a copy of that work as it was meant to be seen.</p>\n<p>It is also why Vimeo's privacy controls are stronger than most platforms'. A filmmaker can hide a video from vimeo.com while still letting it play on their own website, or protect it with a password and share the password only with a client. Those controls exist so a work-in-progress can be shown to five people and nobody else, and they are respected here: if a video is hidden or password-protected, this page will not read it, and no honest downloader should claim otherwise. If a filmmaker sent you a Vimeo link, it is usually because they want you to watch it — save it for personal viewing, and do not pass it on without asking them.</p>\n<h2>Staff Picks, channels and showcases</h2>\n<p>Vimeo's best-known feature is Staff Picks: a curated shelf of the finest short films, animations, music videos and documentaries on the platform, chosen by Vimeo's own curators. A Staff Pick badge is a real mark of quality in the film world, and the videos on that shelf are among the most-saved on Vimeo — they are short, beautiful, and worth keeping. Channels and showcases are Vimeo's other way of organising video: a channel is a collection built around a theme, and a showcase is a collection built by one user, often a portfolio. Both point at collections, not at single videos, so a channel or showcase link will not load a video here. Open the video itself, copy its own vimeo.com link, and paste that instead — the number after vimeo.com is the video, and it is the only part that matters.</p>\n<h2>Is it free, and do I need a Vimeo account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on Vimeo. You never log in, and the filmmaker is never told you saved their video. Only save videos you have the right to keep: a film, a showreel or a wedding video is someone's work, and keeping it for personal viewing is one thing while posting it somewhere else is another. Credit the creator if you share a saved video anywhere.</p><h2>A note on saving work that is not yours</h2>\n<p>Because Vimeo videos are so often professional work, the usual rule matters more here than anywhere else: save a video for personal viewing, and ask the maker before you share it, re-upload it, or cut it into something of your own. A wedding film belongs to the couple and the videographer. A showreel belongs to the person whose career it represents. A short film belongs to its director and its crew. Keeping a copy to watch again is one thing; presenting someone else's finished work as your own, or posting it where they did not intend it to be seen, is another. If in doubt, write to the creator — Vimeo makes that easy — and ask.</p>",
    faq: [
      ["Is the Vimeo video downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public Vimeo video."],
      ["How do I download a Vimeo video?", "Copy the video link on Vimeo, paste it here and tap Get video. When the preview appears, pick a quality — up to 1080p — and the Vimeo video downloads as an MP4 with sound. This Vimeo video downloader is free and works on any phone or PC."],
      ["How do I download a Vimeo video on iPhone?", "Copy the video link in the Vimeo app or browser, open Safari, paste the link here and tap Get video. Choose the highest quality available and the MP4 saves to the Files app under Downloads."],
      ["How do I download a Vimeo video on Android?", "Copy the video link, paste it here in Chrome and tap Get video. Pick a quality — usually up to 1080p — and the MP4 downloads to your Downloads folder, ready to open in your gallery."],
      ["What qualities can I save a Vimeo video in?", "Vimeo serves its videos as progressive MP4 files with sound, usually from 240p up to 1080p, depending on the upload. The list you see after pasting a link is the real list for that video."],
      ["Can I save a Vimeo video in 1080p?", "Yes, when the video was uploaded in 1080p. After you paste a link you will see the real qualities for that video, and 1080p is offered whenever the upload supports it. A video uploaded at 720p has no 1080p version."],
      ["Do I need a Vimeo account to download a video?", "No. Only the public video link is needed. There is no login here and no login to Vimeo, and the uploader is never notified."],
      ["Can I save private Vimeo videos?", "No. Only public videos can be read. Password-protected or private videos will not work, and neither will videos set to hide from vimeo.com or restricted to particular websites."],
      ["Why does my Vimeo link not work?", "Check that you copied the link of the video itself — vimeo.com followed by a number. A showcase, channel or profile link points at a collection, not a video. The video may also be private, password-protected, deleted, or a paid On Demand title."],
      ["Can I download a Vimeo video embedded on another website?", "Yes, if you can get the video's own vimeo.com link. The address of the page it is embedded in will not work — open the video, copy its vimeo.com link from the player, and paste that here."],
      ["Can I save just the audio from a Vimeo video?", "Yes. After pasting the link, choose the Audio option and only the sound is saved — useful for talks, interviews and music videos."],
      ["Where does a saved Vimeo video go on my phone?", "On iPhone it goes to the Files app under Downloads — Vimeo films can be large, so check you have space before you download. On Android it goes to the Downloads folder, visible in Files or your gallery. The MP4 plays in any media player on either."]

    ],
  },
  streamable: {
    name: 'Streamable',
    keyword: 'Streamable video downloader',
    title: 'Streamable Video Downloader — Save as MP4 | Save Video',
    description: 'Streamable video downloader: paste a Streamable link, preview the video and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Streamable Video Downloader',
    intro: 'A free Streamable video downloader: paste the link, preview the clip, and save it as MP4 with sound. Works with public Streamable video links. No account, no app to install.',
    example: 'https://streamable.com/',
    about: "<h2>What Streamable is</h2>\n<p>Streamable is the simplest video host on the internet: upload a clip, get a link, share it. There is no feed, no followers, no algorithm — just a link that plays a video. That is why Streamable links turn up everywhere: in forum posts, in chat messages, on Reddit, in customer-support threads, in gaming chats where someone wants to show a bug or a funny moment. The clips are usually short — a few seconds to a few minutes — and they are often the only copy of a moment that exists, because the person who uploaded it never posted it anywhere else.</p>\n<p>This page is a Streamable video downloader: paste a public Streamable link and you can preview it, then save it as an MP4 with sound — usually 720p, with a 360p mobile version for smaller files. No account is needed and nothing has to be installed. A Streamable link looks like streamable.com/ followed by a short code, and that code is the video itself. Streamable videos can be deleted by their uploader at any time, and some are set to expire, so a link that worked last week may load nothing today. Private Streamable videos cannot be read.</p>\n<h2>How to save a Streamable video</h2>\n<p>Open the video on Streamable, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the Streamable video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Streamable video."],
      ["Which Streamable links work here?", "Public video links work: streamable.com/ links with a short code at the end. A link to the Streamable homepage has no video in it, so copy the link of the video itself from the address bar."],
      ["What quality do Streamable videos save in?", "Streamable serves its videos as MP4 files with sound, usually 720p and a 360p mobile version. The clips are short, so the file is small and downloads quickly."],
      ["Why did a Streamable link that worked before stop working?", "Streamable videos can be deleted by their uploader at any time, and some are set to expire. A link that loaded last week may point at a video that no longer exists — that is the likeliest cause."],
      ["How do I download a Streamable video on my phone?", "Copy the Streamable link from the address bar, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads — Files on iPhone, the Downloads folder on Android — and plays in any video app."],
      ["Can I save private Streamable videos?", "No. Only public videos can be read. Private, deleted or expired Streamable videos cannot be saved."]

    ],
  },
  kwai: {
    name: 'Kwai',
    keyword: 'Kwai video downloader',
    title: 'Kwai Video Downloader — Save Kwai Videos as MP4 | Save Video',
    description: 'Kwai video downloader: paste a Kwai video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Kwai Video Downloader',
    intro: 'A free Kwai video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Kwai is the international version of Kuaishou, so the same short-video links work here. No account, no app to install.',
    example: 'https://www.kwai.com/',
    about: "<h2>What Kwai is</h2>\n<p>Kwai is the international version of Kuaishou, China's small-town short-video app, and it has found its biggest audiences in Brazil, Indonesia, Mexico and other parts of Latin America and Southeast Asia. The videos are the same kind Kuaishou is known for: short, vertical, and unpolished — everyday life filmed on a phone. Street food, motorbikes, football in a dusty yard, family celebrations, market stalls, dance trends, comedy in local dialects. Kwai's feed is built around ordinary people rather than celebrities, and its viewers are often people watching in a language the big global apps serve badly.</p>\n<p>This page is a Kwai video downloader: paste the link of a public Kwai video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded — usually 720p. No account is needed and nothing has to be installed. A Kwai link looks like kwai.com followed by a video code, and short share links point at the same video — both work here. Private videos cannot be read, and neither can videos that have been deleted.</p>\n<h2>How to save a Kwai video</h2>\n<p>Open the video in the Kwai app, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep, and credit the creator if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the Kwai video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Kwai video."],
      ["Which Kwai links work here?", "Kwai video links work: kwai.com links, including short share links. A profile link points at a creator, not a video, so open the video itself and copy its own link from the Share menu."],
      ["What quality do Kwai videos save in?", "Kwai serves its videos as MP4 files with sound, in the quality they were uploaded — usually 720p. Kwai clips are short, so the file is small and downloads quickly even on a slow connection."],
      ["Is Kwai the same app as Kuaishou?", "Almost. Kwai is the international version of Kuaishou, run by the same company outside China. Kuaishou links work on the Kuaishou page here, and Kwai links work on this page — the two apps share the same short-video format."],
      ["How do I download a Kwai video on my phone?", "Copy the video link in the Kwai app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Can I save private Kwai videos?", "No. Kwai videos on private accounts can only be seen by approved followers, so they cannot be read or saved."]

    ],
  },
  soundcloud: {
    name: 'SoundCloud',
    keyword: 'SoundCloud downloader',
    title: 'SoundCloud Audio Downloader — Save Tracks | Save Video',
    description: 'SoundCloud downloader: paste a SoundCloud track link and save the audio as MP3. Free, no account, works on phone and PC.',
    h1: 'SoundCloud Audio Downloader',
    intro: 'A free SoundCloud downloader: paste the track link and save the audio as MP3. SoundCloud is audio-only, so you get the track sound — not a video file. No account, no app to install.',
    example: 'https://soundcloud.com/',
    about: "<h2>What SoundCloud is, and what you can save from it</h2>\n<p>SoundCloud is the home of music that has not reached the radio yet — and of a lot that never will. Independent rappers, bedroom producers, DJs, podcasters, poets, comedians and small labels all upload there first, because SoundCloud lets anyone put a track up and share it with a link. The result is a catalogue no other service has: demos, remixes, mixtapes, live sets, unreleased versions, and songs in languages and styles the big streaming apps barely cover. People save SoundCloud tracks for the same reasons they save anything else — to listen offline, to keep a song that might be taken down, or to play it somewhere SoundCloud itself does not reach.</p>\n<p>This page is a SoundCloud downloader, and the phrase people search for is soundcloud to mp3. Paste the link of a public SoundCloud track and you can save the audio as an MP3 file. SoundCloud is audio-only, so there is no video here at all — what you get is the track's sound, in a file that plays in any music app on any phone or computer. There is no account to create and no app to install.</p>\n<p>A SoundCloud track link looks like soundcloud.com followed by the artist's name and then the track's name. That shape is the important part: a link to an artist's profile, a playlist, or the SoundCloud homepage points at a page, not a track, so always copy the link of the track itself.</p>\n<h2>How to download a SoundCloud track on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved track ends up in the Files app.</p>\n<ol>\n<li>Open the SoundCloud app and find the track you want.</li>\n<li>Tap Share, then Copy link.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the track appears, tap to save the audio as an MP3.</li>\n<li>Safari saves the file to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the track to play it. From there you can move it into a music app, send it in a message, or AirDrop it to a Mac. If tapping a link keeps opening the SoundCloud app instead of Safari, copy the link inside the app first and paste it into Safari yourself.</p>\n<h2>How to download a SoundCloud track on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>In the SoundCloud app, open the track, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>Save the audio as an MP3.</li>\n<li>Find it in the Files app under Downloads, or in your music app.</li>\n</ol>\n<p>The file is a standard MP3, so any music player can open it — the built-in player, VLC, Poweramp, or anything else you use. If Chrome asks for permission to store files, allow it once.</p>\n<h2>How to download a SoundCloud track on PC</h2>\n<p>On a computer, SoundCloud runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open soundcloud.com in your browser and open the track.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Save the audio as an MP3 to your Downloads folder.</li>\n</ol>\n<p>The MP3 plays in any music app on Windows or Mac, and you can copy it to a USB stick, a car stereo, or a phone. If you are building a playlist of saved tracks, save each track separately — this page works one track at a time.</p>\n<h2>What quality will I get?</h2>\n<p>SoundCloud tracks are saved as audio in the quality SoundCloud streams for that track. There is no video quality to choose, because there is no video.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>MP3 audio</td><td>The track's sound as an MP3 file</td><td>Listening offline, in any music app</td></tr>\n</table>\n<p>MP3 is the audio format: sound only, no picture, a small file that plays everywhere. SoundCloud streams at a modest quality by design — it is a platform for discovering music, not for studio-grade listening — so a saved track sounds like the stream you hear in the app. It will not sound better than the stream, and it will not sound worse. If you need a studio-quality file of a song, the honest answer is to buy it from the artist: a stream-quality MP3 is a copy for listening, not a master.</p>\n<h2>SoundCloud to MP3: what works and what does not</h2>\n<p>Public tracks work — that is the core of the page, and it covers the overwhelming majority of SoundCloud. A track that anyone can open and play can be saved. What does not work is anything SoundCloud keeps behind a wall: private tracks, which only the people the uploader shared them with can hear, and tracks that have been deleted or taken down. A playlist link points at a list, not a track, so it has no single audio file to offer — open the track inside the playlist and copy that track's own link instead. A track that SoundCloud restricts in your country will not play for you, and it cannot be saved from here either. And a track with a download button switched off by the artist is still a public track — the button is the artist's choice inside SoundCloud, and this page works from the public stream, not from that button.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Make sure you copied the link of the track itself — soundcloud.com followed by the artist and the track name. A profile, playlist, search or tag link points at a page, not a track, and there is no audio file to save. If the link is right and nothing loads, the track is probably private, deleted, or taken down. If the download finishes but the file will not play, check that your music app is not set to hide files from the Downloads folder — move the file into your music folder and it should appear. If your phone keeps opening the SoundCloud app when you tap a link, copy the link inside the app and paste it into your browser by hand.</p>\n<h2>How SoundCloud works, and why tracks disappear</h2>\n<p>SoundCloud's catalogue is fragile in a way the big streaming apps are not. An independent artist can delete a track on a whim, a label can issue a takedown, an account can be closed for unpaid fees, and a remix can vanish overnight because it used a sample someone objected to. The track you love today may not exist next month, and there is no warning when it goes. That is the main reason people save SoundCloud tracks: not to avoid paying — SoundCloud is free to listen to — but to keep a song that might not be there tomorrow. If a track matters to you, save it while it is still up, and check the file plays before you close the page.</p>\n<p>SoundCloud also works differently from a streaming app in how it is organised. Artists upload tracks, and listeners find them through reposts, likes, playlists and tags rather than through an algorithm. A repost is not a copy: it is a pointer to the original track, so the link to save is always the link of the track itself, not the link of a repost or a playlist. A track that appears in ten playlists is still one track with one link, and that link is the one on the track's own page. If you found a song in a playlist, open the track, copy its link from the track page, and paste that here.</p>\n<h2>Supporting the artists you save</h2>\n<p>A saved MP3 is a copy for personal listening, and it is worth saying plainly what that means for the people who made the music. SoundCloud artists — especially the independent ones — earn almost nothing from streams, and they keep making music because listeners follow them, share their links, come to their shows, and buy their merchandise or their tracks when they sell them. Saving a track does not pay the artist, and sharing a saved file instead of the artist's link does not help them either. If a track matters to you, do the small things that do help: follow the artist on SoundCloud, share the track's own link rather than the file, and buy their music when they offer it for sale. The music survives on that support, and the artists remember who gave it.</p>\n<h2>Is it free, and do I need a SoundCloud account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on SoundCloud. You never log in, and the artist is never told you saved their track. Only save tracks you have the right to keep, and support the artists you love: a saved MP3 is for personal listening, and if a track matters to you, follow the artist, share their link, or buy their music when they sell it. Music made by independent artists survives on that support.</p>",
    faq: [
      ["Is the SoundCloud downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public SoundCloud track."],
      ["How do I convert SoundCloud to MP3?", "Copy the track link in the SoundCloud app, paste it here and tap Get video. The track saves as an MP3 file — this is the soundcloud to mp3 option, and it works for public tracks with no account and no app to install."],
      ["How do I download a SoundCloud track on iPhone?", "Copy the track link in the SoundCloud app, open Safari, paste the link here and tap Get video. The MP3 saves to the Files app under Downloads, where you can play it or move it into a music app."],
      ["How do I download a SoundCloud track on Android?", "Copy the track link, paste it here in Chrome and tap Get video. The MP3 downloads to your Downloads folder, ready to open in any music player."],
      ["What quality do SoundCloud tracks save in?", "SoundCloud serves its audio in the quality it streams for that track, and you get that same quality as an MP3. SoundCloud streams at a modest quality by design, so a saved track sounds like the stream you hear in the app — not better, not worse."],
      ["Do I need a SoundCloud account to download a track?", "No. Only the public track link is needed. There is no login here and no login to SoundCloud, and the artist is never notified."],
      ["Can I save private SoundCloud tracks?", "No. Private tracks can only be heard by the people the uploader shared them with, so they cannot be read or saved. The same applies to deleted or taken-down tracks."],
      ["Can I download a whole SoundCloud playlist?", "Not in one go. A playlist link points at a list, not a track, so it has no single audio file. Open each track inside the playlist, copy that track's own link, and save the tracks one at a time."],
      ["Why does my SoundCloud link not work?", "Check that you copied the link of the track itself — soundcloud.com followed by the artist and the track name. A profile, playlist, search or tag link has no track in it. The track may also be private, deleted or taken down."],
      ["Can I download a SoundCloud track on PC?", "Yes. Open the track on soundcloud.com, copy its link from the address bar, paste it here and save the MP3 to your Downloads folder. It plays in any music app on Windows or Mac."],
      ["Is SoundCloud audio or video?", "Audio only. SoundCloud hosts music and spoken audio, not video, so what you save is the track's sound as an MP3 — there is no picture and no video file."],
      ["Where does the saved track go on my phone?", "On iPhone it goes to the Files app under Downloads; on Android it goes to the Downloads folder, visible in Files or your music app. On both it is an ordinary MP3 you can move, share or AirDrop."]

    ],
  },
  mixcloud: {
    name: 'Mixcloud',
    keyword: 'Mixcloud downloader',
    title: 'Mixcloud Audio Downloader — Save Mixes | Save Video',
    description: 'Mixcloud downloader: paste a Mixcloud link and save the audio as MP3. Free, no account, works on phone and PC.',
    h1: 'Mixcloud Audio Downloader',
    intro: 'A free Mixcloud downloader for DJ mixes and radio shows: paste the link and save the audio as MP3. Mixcloud is audio-only, so you get the mix sound — not a video file. No account, no app to install.',
    example: 'https://www.mixcloud.com/',
    about: "<h2>What Mixcloud is</h2>\n<p>Mixcloud is the home of the long DJ mix and the radio show. Where other audio sites are built around single songs, Mixcloud is built around sets: a two-hour house mix, a reggae radio show, a podcast series, a live recording from a club night. DJs and radio presenters upload their shows, listeners follow them, and the platform pays the underlying artists through licensing — which is why Mixcloud has survived while other mix sites have not. A Mixcloud show is usually an hour or longer, it is audio only, and it is meant to be listened to from start to finish rather than skipped through.</p>\n<p>This page is a Mixcloud downloader: paste the link of a public Mixcloud show and you can save the audio as an MP3 file. Mixcloud is audio-only, so there is no video here at all — what you get is the show's sound, as one file, in the quality Mixcloud streams. No account is needed and nothing has to be installed. A Mixcloud link looks like mixcloud.com followed by the presenter's name and then the show's name. Because shows are long, the file can be large, so download on Wi-Fi where you can. Private shows cannot be read, and neither can shows that have been taken down.</p>\n<h2>How to save a Mixcloud show</h2>\n<p>Open the show on Mixcloud, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP3 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP3 and plays in any music app. Only save shows you have the right to keep, and support the presenters you love by following them and sharing their links.</p>",
    faq: [
      ["Is the Mixcloud downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Mixcloud show."],
      ["What format do Mixcloud shows save in?", "Mixcloud shows are saved as audio — an MP3 file — since Mixcloud hosts DJ mixes and radio shows, not video. A two-hour mix saves as one long MP3, so download on Wi-Fi where you can."],
      ["What quality do Mixcloud shows save in?", "Mixcloud audio is served at the quality Mixcloud streams, and you get the full mix as one audio file. It is stream quality — fine for listening, not a studio master — and it sounds like the stream you hear in the app."],
      ["Can I download a whole Mixcloud show or just part of it?", "The whole show saves as one file. Mixcloud shows are long by design — an hour or more — so the file is large; give it time on Wi-Fi rather than starting it on mobile data."],
      ["How do I download a Mixcloud show on my phone?", "Copy the show link in your phone browser, paste it here and tap Get video. The MP3 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and plays in any music app."],
      ["Can I save private Mixcloud shows?", "No. Only public shows can be read. Private shows, and shows that have been taken down, cannot be saved."]

    ],
  },
  odysee: {
    name: 'Odysee',
    keyword: 'Odysee video downloader',
    title: 'Odysee Video Downloader — Save Videos as MP4 | Save Video',
    description: 'Odysee video downloader: paste an Odysee video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Odysee Video Downloader',
    intro: 'A free Odysee video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with public Odysee videos. No account, no app to install.',
    example: 'https://odysee.com/',
    about: "<h2>What Odysee is</h2>\n<p>Odysee is a video platform built on LBRY, a decentralised network, which makes it different from every mainstream video site in one important way: there is no single company server holding all the videos. Creators publish to the LBRY network and Odysee is the friendly front door for watching them. The result is a catalogue full of independent creators — tech reviewers, historians, gamers, commentators, educators — many of whom moved there because they wanted looser content rules and a direct relationship with their audience, including tips paid in cryptocurrency. Odysee has no adverts in front of videos, and its channels often carry long, unhurried videos that would not survive on an algorithm-driven feed.</p>\n<p>This page is an Odysee video downloader: paste the link of a public Odysee video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. An Odysee link looks like odysee.com/@channel-name followed by a code, then a colon and the video's title — that long shape is normal, and copying it whole from the address bar is the safest way to get it right. Videos that a creator has made private, or that have been removed from the network, cannot be read.</p>\n<h2>How to save an Odysee video</h2>\n<p>Open the video on Odysee, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep, and credit the creator if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the Odysee video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public Odysee video."],
      ["Which Odysee links work here?", "Public video links work: odysee.com/@channel links with the video title at the end. Copy the whole link from the address bar — the channel code and the colon in the middle are part of it, so do not shorten it by hand."],
      ["What quality do Odysee videos save in?", "Odysee serves its videos as MP4 files with sound, in the quality they were uploaded. Creators upload at many different resolutions, so the list you see after pasting a link is the real list for that video."],
      ["Do I need an Odysee or LBRY account?", "No. Only the public video link is needed. There is no login here and no login to Odysee, and the creator is never told you saved their video."],
      ["How do I download an Odysee video on my phone?", "Copy the full video link from the Odysee address bar, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads — Files on iPhone, the Downloads folder on Android — and because Odysee links are long, copying the whole link matters more than on other sites."],
      ["Why does my Odysee link not load?", "Check you copied the full link, including the channel code and the video title after the colon — a half-copied Odysee link points nowhere. The video may also be private or removed from the network."]

    ],
  },
  bitchute: {
    name: 'BitChute',
    keyword: 'BitChute video downloader',
    title: 'BitChute Video Downloader — Save as MP4 | Save Video',
    description: 'BitChute video downloader: paste a BitChute video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'BitChute Video Downloader',
    intro: 'A free BitChute video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with public BitChute videos. No account, no app to install.',
    example: 'https://www.bitchute.com/',
    about: "<h2>What BitChute is</h2>\n<p>BitChute is an independent video platform that grew by hosting creators who felt unwelcome on the big sites. Its catalogue is mostly long-form: political commentary, documentaries, interviews, history programmes, religious talks, and news analysis, usually uploaded by small channels rather than studios. Videos on BitChute tend to run long — thirty minutes to two hours is normal — and the platform is peer-to-peer under the surface, which means a video is served partly by other viewers rather than only by BitChute's own servers. That is worth knowing when you save something: a popular video loads quickly, while an obscure one can take longer to fetch.</p>\n<p>This page is a BitChute video downloader: paste the link of a public BitChute video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A BitChute link looks like bitchute.com/video followed by a short code, and that code is the video itself — copy it from the address bar rather than typing it. Private or removed videos cannot be read, and because BitChute videos are long, the file can be large: download on Wi-Fi where you can.</p>\n<h2>How to save a BitChute video</h2>\n<p>Open the video on BitChute, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the BitChute video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public BitChute video."],
      ["Which BitChute links work here?", "Public video links work: bitchute.com/video links with a short code at the end. A channel link points at a list of videos, not one video, so open the video itself and copy its own link."],
      ["What quality do BitChute videos save in?", "BitChute serves its videos as MP4 files with sound, in the quality they were uploaded. Most BitChute uploads are standard definition or 720p, so the list you see after pasting a link is the real list for that video."],
      ["Why is a BitChute download slow?", "BitChute videos are usually long — thirty minutes to two hours — so the file is large, and BitChute serves video partly peer-to-peer, so an obscure video can fetch slowly. Stay on Wi-Fi and give it time; a second try often works."],
      ["How do I download a BitChute video on my phone?", "Copy the video link in your phone browser, paste it here and tap Get video. The MP4 saves to Downloads, but because BitChute videos are long, use Wi-Fi — the file can be several hundred megabytes."],
      ["Can I save private BitChute videos?", "No. Only public videos can be read. Private or removed videos cannot be saved, and neither can a video on a channel that has been taken down."]

    ],
  },
  peertube: {
    name: 'PeerTube',
    keyword: 'PeerTube video downloader',
    title: 'PeerTube Video Downloader — Save as MP4 | Save Video',
    description: 'PeerTube video downloader: paste a PeerTube video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'PeerTube Video Downloader',
    intro: 'A free PeerTube video downloader: paste the video link, preview the clip, and save it as MP4 with sound. PeerTube is federated, so videos from any public PeerTube instance work. No account, no app to install.',
    example: 'https://peertube.tv/',
    about: "<h2>What PeerTube is</h2>\n<p>PeerTube is not one website — it is a network of hundreds of small video sites, called instances, that all run the same free software and talk to each other. A university might run an instance for its lectures, a town council for its meetings, a hobby community for its tutorials, and an activist group for its documentaries. Each instance has its own address, its own rules and its own catalogue, and a video lives on the instance that uploaded it. That federation is the whole point: no single company controls PeerTube, and no single shutdown can take it down. It also means the experience varies — one instance is fast and polished, another is a small server in someone's spare room.</p>\n<p>This page is a PeerTube video downloader that works with any public instance: paste the link of a public PeerTube video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. A PeerTube link looks like an ordinary video page on whatever instance hosts it — peertube.tv, or one of the hundreds of others — followed by /w/ and a short code. Copy the link of the video itself, not the link of the instance's homepage. Videos on a private instance, or restricted to logged-in users, cannot be read, and a small instance that is offline cannot serve its videos at all.</p>\n<h2>How to save a PeerTube video</h2>\n<p>Open the video on its PeerTube instance, copy its link from the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the PeerTube video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public PeerTube video, from any public instance."],
      ["Which PeerTube instances work here?", "Any public PeerTube instance — paste a video link from the instance that hosts it, such as peertube.tv or any other public instance. The link should contain /w/ followed by a short code."],
      ["What quality do PeerTube videos save in?", "PeerTube serves its videos as MP4 files with sound, in the quality they were uploaded. Instances transcode uploads into several resolutions, so the list you see after pasting a link is the real list for that video."],
      ["Why does a PeerTube video fail to load?", "The likeliest cause is the instance itself: small instances go offline, run slowly, or restrict videos to logged-in users. Check the video plays in your browser first — if it does not play there, it cannot be saved here either."],
      ["How do I download a PeerTube video on my phone?", "Copy the video link from its PeerTube instance in your phone browser, paste it here and tap Get video. The MP4 saves to Downloads, and if the instance is slow, stay on Wi-Fi — a small community server can take longer to serve the file."],
      ["Do I need a PeerTube account?", "No. Only the public video link is needed. There is no login here and no login to the instance, and the uploader is never told you saved their video."]

    ],
  },
  vk: {
    name: 'VK',
    keyword: 'VK video downloader',
    title: 'VK Video Downloader — Save VK Videos as MP4 | Save Video',
    description: 'VK video downloader: paste a VK video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'VK Video Downloader',
    intro: 'A free VK video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with public VK videos from vk.com and vkvideo.ru. No account, no app to install.',
    example: 'https://vk.com/',
    about: "<h2>What VK is</h2>\n<p>VK, short for VKontakte, is the social network most of Russia and much of Eastern Europe grew up on. It works like a mix of Facebook and YouTube: people keep a profile, join groups, follow musicians and public pages, and watch an enormous library of video — music videos, full films and series uploaded by communities, football highlights, comedy shows, lectures, and clips that circulate for years. VK Video, its dedicated video section at vkvideo.ru, has become the main place many Russian-speaking viewers watch long-form video at all. If the video you want lives anywhere, it is often a VK community or a friend's page that holds the copy.</p>\n<p>This page is a VK video downloader: paste the link of a public VK video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. No account is needed and nothing has to be installed. VK links come in a few shapes — vk.com/video followed by numbers, vkvideo.ru links, and clip links — and all of them work here as long as the video itself is public. Videos inside closed groups, on locked profiles, or restricted by age cannot be read, and neither can videos VK has removed. A video that plays fine for you in the app but fails here is almost always one of those: check whether the post is public before trying a different browser.</p>\n<h2>How to save a VK video</h2>\n<p>Open the video on VK, tap Share and copy its link, then paste the link into the box on this page and tap Get video. On a phone the file saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is an ordinary MP4 with sound, so it plays in any gallery or media player. Only save videos you have the right to keep, and credit the uploader if you share a saved video anywhere else.</p>",
    faq: [
      ["Is the VK video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public VK video, from vk.com or vkvideo.ru."],
      ["Which VK links work here?", "Public video links work: vk.com/video links, vkvideo.ru links and VK clip links. A link to a profile, a group page or a feed has no single video in it, so copy the link of the video itself from its Share menu."],
      ["What quality do VK videos save in?", "VK serves its videos as MP4 files with sound, in the quality they were uploaded — older community uploads are often standard definition, while newer uploads can be high definition. You are offered the qualities that exist for that video."],
      ["Can I download a video from a private VK group?", "No. Videos inside closed groups, on locked profiles, or restricted by age cannot be read. Only public VK videos can be saved, and deleted or removed videos are gone."],
      ["How do I download a VK video on my phone?", "Copy the video link in the VK app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and plays in any video app."],
      ["Why does my VK link not load?", "First check the video is public: open its link in a browser while logged out, and if it asks you to log in, it is not public. Also check you copied a video link rather than a profile or group link, and that the video has not been deleted."]

    ],
  },
  ok: {
    name: 'OK.ru',
    keyword: 'OK.ru video downloader',
    title: 'OK.ru Video Downloader — Save Videos as MP4 | Save Video',
    description: 'OK.ru video downloader: paste an OK.ru video link, preview it and save it as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'OK.ru Video Downloader',
    intro: 'A free OK.ru video downloader: paste the video link, preview the clip, and save it as MP4 with sound. Works with public OK.ru videos. No account, no app to install.',
    example: 'https://ok.ru/',
    about: "<h2>What OK.ru is</h2>\n<p>OK.ru — Odnoklassniki, \"classmates\" in Russian — is the social network of a slightly older Russia. It began as a way for former schoolmates to find each other, and it is still strongest with users over thirty, in Russia and in Russian-speaking communities abroad. Its video section is large and distinctive: Soviet and Russian films, serials, concerts, folk music, fishing and cooking shows, family celebrations, and live streams from local events. A huge amount of OK.ru video is watched by people who never use any other social network, which is why a clip from OK.ru is often the only copy of a family moment or a local performance that exists anywhere.</p>\n<p>This page is an OK.ru video downloader: paste the link of a public OK.ru video and you can preview it, then save it as an MP4 with sound, in the quality it was uploaded. There is no account to create and nothing to install. OK.ru video links look like ok.ru/video followed by a number, and live-stream links carry a different shape — a finished video saves normally, while a stream that is live right now has no finished file yet. Videos on locked profiles, inside closed groups, or restricted by age cannot be read, and deleted videos are gone for good.</p>\n<h2>How to save an OK.ru video</h2>\n<p>Open the video on OK.ru, copy its link from the Share menu or the address bar, then paste the link into the box on this page and tap Get video. On a phone the MP4 saves to Downloads — the Files app on iPhone, the Downloads folder on Android — and on a computer it goes to your Downloads folder. The file is a standard MP4 with sound and plays in any gallery or media player. Only save videos you have the right to keep.</p>",
    faq: [
      ["Is the OK.ru video downloader free?", "Yes — free, with no account and nothing to install. You only need the link of a public OK.ru video."],
      ["Which OK.ru links work here?", "Public video links work: ok.ru/video links with a number at the end. A finished live stream that was left up afterwards saves the same way; a stream that is live right now has no finished file yet."],
      ["What quality do OK.ru videos save in?", "OK.ru serves its videos as MP4 files with sound, in the quality they were uploaded. Much of OK.ru is older footage, so standard definition is common, and newer uploads can be sharper. You get the qualities that exist for that video."],
      ["Can I download a video from a locked OK.ru profile?", "No. Videos on locked profiles or inside closed groups cannot be read, and neither can age-restricted videos. Only public OK.ru videos can be saved."],
      ["How do I download an OK.ru video on my phone?", "Copy the video link in the OK.ru app, paste it here in your phone browser and tap Get video. The MP4 saves to Downloads and plays in your gallery or any video player."],
      ["Why does my OK.ru link not load?", "Check you copied a video link rather than a profile, group or feed link, and check the video is public — if opening it while logged out asks you to log in, it is not public. The video may also have been deleted."]

    ],
  },
  kick: {
    name: 'Kick',
    keyword: 'Kick clip downloader',
    title: 'Kick Clip Downloader — Save Kick Clips as MP4 | Save Video',
    description: 'Kick clip downloader: paste a Kick clip link, preview it and save the clip as MP4 with sound. Free, no account, works on phone and PC.',
    h1: 'Kick Clip Downloader',
    intro: 'A free Kick clip downloader: paste the clip link, preview it, and save the clip as MP4 with sound. Works with public Kick clips. No account, no app to install.',
    example: 'https://kick.com/',
    about: "<h2>What Kick is, and what you can save from it</h2>\n<p>Kick is a live-streaming platform built around gaming, just chatting, and creator-led shows. It looks familiar to anyone who has watched a stream before — a broadcaster live on camera, a chat full of viewers, clips flying around afterwards — but it is younger and smaller than the older streaming sites, and its community is built around creators who moved there for its looser rules and its revenue split. The moments people want to keep from Kick are almost always clips: a funny fail, an incredible play, a reaction, a short argument that becomes a meme. A clip is a short slice cut out of a stream by a viewer, usually thirty to sixty seconds long, and it is the only part of Kick that has a single file you can save.</p>\n<p>This page is a Kick clip downloader: paste the link of a public Kick clip and you can preview it, then save the clip as an MP4 with sound. There is no account to create and no app to install. The clip saves in the quality it was cut at, with the picture and sound together in one file that plays on any modern phone or computer.</p>\n<p>Kick clip links look like kick.com followed by the channel name and then /clips/ followed by the clip's name. That shape is the important part: a link to a channel, a category, or a live stream is not a clip link, and it has no single file behind it.</p>\n<h2>How to download a Kick clip on iPhone</h2>\n<p>On an iPhone the job runs in Safari, and the saved clip ends up in the Files app.</p>\n<ol>\n<li>Open Kick in your browser or the app and find the clip you want.</li>\n<li>Tap Share, then Copy link. If you are on the clips page of a channel, open the clip first so you are copying the clip's own link.</li>\n<li>Open Safari and come to this page.</li>\n<li>Paste the link into the box and tap Get video.</li>\n<li>When the preview appears, tap the clip to save it as an MP4 with sound.</li>\n<li>Safari saves the file to the Files app under Downloads.</li>\n</ol>\n<p>Open the Files app, tap Browse, then Downloads, and tap the clip to play it. From there you can move it into Photos, send it in a message, or AirDrop it. If tapping a link keeps opening the Kick app instead of Safari, copy the link inside the app first and paste it into Safari yourself.</p>\n<h2>How to download a Kick clip on Android</h2>\n<p>On Android the same steps run in Chrome, and the file lands in Downloads.</p>\n<ol>\n<li>In Kick, open the clip, tap Share, then Copy link.</li>\n<li>Open Chrome and come to this page.</li>\n<li>Paste the link and tap Get video.</li>\n<li>When the preview appears, save the clip as an MP4.</li>\n<li>Find it in the Files app under Downloads, or in your gallery app.</li>\n</ol>\n<p>The file is a standard MP4 with sound, so any gallery or video player can open it. Clips are short, so even on a slow mobile connection the download finishes quickly.</p>\n<h2>How to download a Kick clip on PC</h2>\n<p>On a computer, Kick runs in the browser, which makes copying links easy.</p>\n<ol>\n<li>Open kick.com in your browser and open the clip.</li>\n<li>Copy the address from the address bar, or click Share and then Copy link.</li>\n<li>Paste it into the box on this page and click Get video.</li>\n<li>Save the clip as an MP4 to your Downloads folder.</li>\n</ol>\n<p>The MP4 plays in any media player. If you want to use the clip in an edit or a compilation, save it first and edit the saved file — every extra compression step costs sharpness.</p>\n<h2>What quality will I get?</h2>\n<p>Kick clips are offered with sound, in the quality the clip was saved at. The list you see after pasting a link is the real list for that clip.</p>\n<table>\n<tr><th>Option</th><th>What it is</th><th>Best for</th></tr>\n<tr><td>Clip video</td><td>The clip as an MP4 with sound, in the quality it was cut at</td><td>Keeping, sharing, or editing</td></tr>\n<tr><td>Audio</td><td>Just the sound from the clip</td><td>Quotes, reactions and audio moments</td></tr>\n</table>\n<p>MP4 is the video format: picture and sound together in one file that plays on any modern device. Because clips are short, the file is small and easy to forward.</p>\n<h2>Can I save full Kick streams?</h2>\n<p>No, and this is the limit that matters most on this page. A full Kick stream — a VOD — is delivered as a long segmented stream, not as one file, so there is no single MP4 to save. Only short clips cut from a stream can be saved here. If the moment you want was never clipped, it cannot be downloaded as a clip: you would need the streamer, or a viewer, to clip it first. Very long videos cannot be downloaded as one file for the same reason. This is true of live-streaming platforms generally, not just Kick, and no honest downloader will promise otherwise.</p>\n<h2>What else cannot be downloaded from Kick</h2>\n<p>Clips from a channel that has been banned, or clips that have been deleted, are gone — the link will load nothing. A stream that is live right now cannot be saved while it is live. Subscriber-only clips, if a creator restricts them, cannot be read without the access they require. And a link to a channel page, a category page, or the Kick homepage points at a page, not a clip, so there is nothing to save from it.</p>\n<h2>Common problems, and what to check first</h2>\n<p>Most failures come from the link. Make sure you copied the link of the clip itself — it should contain /clips/ followed by the clip's name. A link to a channel or a live stream will not load a clip. If the link is right and nothing loads, the clip may have been deleted, or the channel may have been banned. If the preview loads but the download fails, try again once: Kick's own servers sometimes drop a request, and a second try often works. If your phone keeps opening the Kick app when you tap a link, copy the link inside the app and paste it into your browser by hand.</p>\n<h2>Finding the clip you actually want</h2>\n<p>Kick's clips live in two places, and knowing both saves time. The first is the Clips tab on a channel's page, where the streamer's best clips are collected — usually ranked by views, so the funniest or most dramatic moments sit at the top. The second is the chat itself: when something happens live, viewers clip it within seconds, and the clip link is pasted straight into chat before the streamer has even reacted. If you saw a moment live and want the clip, check the chat first — someone has almost certainly clipped it already. If you are browsing later, the channel's Clips tab is the place to look. Either way, open the clip itself before you copy the link: a link copied from the clips list sometimes points at the list rather than the clip, and the list has no video file.</p>\n<p>Clips also have a short life in one specific sense: a clip is a slice of a stream, and if the streamer deletes the VOD the clip was cut from, the clip can disappear too. That is why saving a clip promptly matters more on Kick than on most platforms. A clip you mean to save \"later\" may not exist later, and no downloader can recover a clip whose source recording is gone. Save it while it is there, check it plays, and then it is yours to keep.</p>\n<h2>Clips, highlights and VODs: what is what</h2>\n<p>Kick's three kinds of recording are easy to confuse, and only one of them can be saved here. A clip is a short slice cut by a viewer, thirty to sixty seconds long, with its own link — that is what this page saves. A highlight is a longer section the streamer marks out afterwards, and it behaves like a small VOD rather than a clip. A VOD is the full recording of a whole stream, hours long, delivered as a segmented stream with no single file. If the link you pasted will not load, check which of the three you have: a VOD or highlight link has no single file to offer, and only a clip link will work. The clip link is the one that contains /clips/ in it, and that detail is the quickest way to tell them apart.</p>\n<h2>Is it free, and do I need a Kick account?</h2>\n<p>Yes, it is free, and no account is needed — not here, and not on Kick. You never log in, and the streamer is never told you saved their clip. Only save clips you have the right to keep, and credit the streamer if you post a saved clip anywhere else — a clip is their work, even when it is only thirty seconds long.</p>",
    faq: [
      ["Is the Kick clip downloader free?", "Yes, completely free — no account, no app install, no payment. You only need the link of a public Kick clip."],
      ["How do I download a Kick clip?", "Copy the clip link on Kick, paste it here and tap Get video. When the preview appears, save the clip as an MP4 with sound. This Kick clip downloader is free and works on any phone or PC."],
      ["How do I download a Kick clip on iPhone?", "Copy the clip link in the Kick app, open Safari, paste the link here and tap Get video. The clip saves as an MP4 to the Files app under Downloads, where you can play it or move it into Photos."],
      ["How do I download a Kick clip on Android?", "Copy the clip link, paste it here in Chrome and tap Get video. The clip downloads as an MP4 to your Downloads folder, ready to open in your gallery."],
      ["Can I save full Kick streams (VODs)?", "No. Full streams are delivered as segmented streams with no single file to save — only short clips can be saved as MP4. If the moment you want was never clipped, it cannot be downloaded as a clip."],
      ["What qualities are Kick clips saved in?", "Kick clips are offered with sound, in the quality the clip was saved at. Clips are short, so the file is small and easy to forward, and it plays on any modern phone or computer."],
      ["Do I need a Kick account to download a clip?", "No. Only the public clip link is needed. There is no login here and no login to Kick, and the streamer is never told you saved their clip."],
      ["Why does my Kick link not work?", "Check that you copied the link of the clip itself — it should contain /clips/ followed by the clip's name. A channel, category or live-stream link has no clip in it. The clip may also have been deleted or the channel banned."],
      ["Can I download a Kick clip while the stream is live?", "Not as a clip of the live moment. A stream has no finished clip file while it is live. Only a clip that a viewer or the streamer already cut from the stream can be saved."],
      ["Can I save just the audio from a Kick clip?", "Yes. After pasting the link, choose the Audio option and only the sound is saved — useful for quotes, reactions and funny audio moments from a stream."],
      ["Where does the saved clip go on my phone?", "On iPhone the clip goes to the Files app under Downloads, and you can move it into Photos from there. On Android it goes to the Downloads folder, where your gallery will show it. Clips are short, so the file is small and easy to forward."],
      ["Can I download a Kick clip on PC?", "Yes. Open the clip on kick.com, copy its link from the address bar, paste it here and save the MP4 to your Downloads folder. It plays in any media player on Windows or Mac."]

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
  if (!p) return null; // unknown slug: caller returns 404, never a 500
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  const url = base + '/' + platform;
  const faqHtml = p.faq.map(([q, a]) =>
    '<details><summary>' + q + '</summary><p>' + a + '</p></details>').join('\n');
  const chips = Object.keys(PLATFORMS).map((k) =>
    '<a class="chip' + (k === platform ? ' active' : '') + '" href="/' + k + '">' + PLATFORMS[k].name + '</a>').join('\n');
  // Footer platform links: generated from the same list, so the footer
  // never goes stale when a platform is added (2026-11-26: it listed
  // only 15 of the 31 platforms).
  const footerLinks = Object.keys(PLATFORMS).map((k) =>
    '<a href="/' + k + '">' + PLATFORMS[k].name + '</a>').join(' · ');
  return landingTemplate
    .replaceAll('{{TITLE}}', p.title)
    .replaceAll('{{DESCRIPTION}}', p.description)
    .replaceAll('{{CANONICAL}}', url)
    .replaceAll('{{H1}}', p.h1)
    .replaceAll('{{INTRO}}', p.intro)
    .replaceAll('{{ABOUT}}', () => (p.about || ''))
    .replaceAll('{{PLATFORM}}', p.name)
    .replaceAll('{{EXAMPLE}}', p.example)
    .replaceAll('{{FAQ_HTML}}', faqHtml)
    .replaceAll('{{FAQ_JSON}}', JSON.stringify(faqJsonLd(p.faq)))
    .replaceAll('{{FOOTER_LINKS}}', footerLinks)
    .replaceAll('{{CHIPS}}', chips);
}

// ---- routes ----------------------------------------------------------------

app.get('/api/config', rateLimit('config', 30, 60000), (req, res) => res.json({ backupOrigins: BACKUP_ORIGINS, backupOrigin: BACKUP_ORIGINS[0] || null }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/stats', (req, res) => {
  statsRollover();
  res.json({ today: VISIT_STATS.today, total: VISIT_STATS.total, date: VISIT_STATS.date });
});

app.get('/robots.txt', (req, res) => {
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: ' + base + '/sitemap.xml\n');
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.get('host') || ''; const base = (host.endsWith('.onrender.com') ? 'https://' : req.protocol + '://') + host;
  const legal = ['privacy.html', 'terms.html', 'about.html', 'contact.html', 'disclaimer.html', 'cookie-policy.html'];
  const urls = ['', ...Object.keys(PLATFORMS), ...legal].map((p) =>
    '  <url><loc>' + base + '/' + p + '</loc><lastmod>2026-11-27</lastmod><changefreq>weekly</changefreq><priority>' + (p === '' ? '1.0' : (legal.indexOf(p) >= 0 ? '0.5' : '0.8')) + '</priority></url>');
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>');
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// RegExp route: the trailing slash is literal here (Express string routes
// treat a trailing slash as optional, which would loop /youtube -> /youtube).
app.get(/^\/(youtube|tiktok|douyin|facebook|instagram|twitter|bluesky|tumblr|twitch|pinterest|moj|sharechat|linkedin|snapchat|tencent|kuaishou|haokan|pear|zhihu|sohu|vimeo|streamable|kwai|soundcloud|mixcloud|odysee|bitchute|peertube|vk|ok|kick)\/$/i, (req, res) => {
  res.redirect(301, '/' + req.params[0].toLowerCase());
});

app.get('/:platform(youtube|tiktok|douyin|facebook|instagram|twitter|bluesky|tumblr|twitch|pinterest|moj|sharechat|linkedin|snapchat|tencent|kuaishou|haokan|pear|zhihu|sohu|vimeo|streamable|kwai|soundcloud|mixcloud|odysee|bitchute|peertube|vk|ok|kick)', (req, res) => {
  const slug = req.params.platform.toLowerCase();
  if (slug !== req.params.platform) return res.redirect(301, '/' + slug);
  const html = renderLanding(slug, req);
  if (!html) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  res.type('text/html').send(html);
});

app.post('/api/meta', rateLimit('meta', 30, 60000), async (req, res) => {
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
  if (!meta) {
    // X (speed fix 2026-11-25): fastMeta can return null (its og
    // scrape finds no title/thumbnail) even when the tweet-page
    // scrape landed with formats — return the scrape as the preview
    // instead of 404ing. The scrape is awaited here with its existing
    // 2.5s cap; it started in parallel with fastMeta above, so this
    // usually costs nothing extra.
    if (scrapeP) {
      const scraped = await Promise.race([scrapeP, new Promise((ok) => setTimeout(() => ok(null), 2500))]);
      if (scraped && Array.isArray(scraped.formats) && scraped.formats.length) {
        return res.json({
          title: scraped.title || 'X video',
          thumbnail: scraped.thumbnail || '',
          uploader: scraped.uploader || '',
          duration: scraped.duration || 0,
          previewUrl: scraped.previewUrl || '',
          formats: scraped.formats,
          clientSide: true,
        });
      }
    }
    return res.status(404).json({ error: 'No preview available yet.' });
  }
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

// Info lookup shared by /api/info and /api/job. /api/info calls it
// with the 25s sync cap; a background job calls it with JOB_RUN_MS
// (5 min), so slow videos — long YouTube, Douyin/Kuaishou,
// Moj/ShareChat, Zhihu — can finish instead of timing out. Returns
// {status, body} exactly like the old inline version and never touches
// res, so a late background finish cannot double-send.
async function lookupInfo(url, timeoutMs, reqStart = Date.now()) {
  // reqStart: request/job start (handler top / job.createdAt). The
  // TikTok 8s cap (sync path only, see the TikTok branch) is measured
  // from here, so it counts the short-link resolve (1.5-6s) as well as
  // the race — the frontend's 10s budget counts all of it.
  // Local copies of the two handler values the body used through the
  // closure (no-cache platform key + Douyin flag).
  const noCacheKey = clientSideKey(url);
  const isDouyin = noCacheKey === 'douyin';
try {
  const infoStart = Date.now();
  // Remaining budget inside the 25s outer cap (1.2s kept for the
  // response itself). Chain lanes below take min(ideal, budgetLeft)
  // and are skipped when under 2.5s remain.
  const budgetLeft = () => timeoutMs - (Date.now() - infoStart) - 1200;
  // YouTube Resolver A prefetch (step 17): a long video's resolve
  // takes 20-24s — longer than the budget left after own failure —
  // so start it alongside the own branch; ytChain awaits it first,
  // and ytdlpInfoWithFallbacks races it as the fast-partial side
  // (ydFastP) on the sync path.
  const ydPrefetch = isYouTube(url) ? ytdownloaderTech(url, 24000).catch(() => null) : null;
  // YT-C prefetch (speed fix 2026-11-25): same treatment as YT-A —
  // invidiousChocInfo is the only full-range mirror, but the chain
  // only runs after own failure with ~0-4s budget left, so the lane
  // never ran. Started here alongside the own branch; ytChain awaits
  // it second. (Not a fast-partial race side: its formats are
  // adaptive-only video+audio, and buildFormats would pair them into
  // 'ch-<v>+ch-audio' ids that chainStreamUrl cannot resolve — the
  // chain's own early return is the correct route for it.)
  const chocPrefetch = isYouTube(url) ? invidiousChocInfo(url, 24000).catch(() => null) : null;
  let result = null;
  // Partial (degraded mirror) YouTube answer: ytdlpInfoWithFallbacks
  // marks its winner with partial: true when the fast first render
  // fires — carried onto the response body below (and onto the /api/job
  // ready response, which reuses this body) so the frontend can
  // upgrade it in place via a background job. Never cached.
  let infoPartial = false;
  // No-stream tracking (TikTok only): tikwm's own code, and whether
  // yt-dlp's verdict was "no video formats found" — see the no-stream
  // comment at the `if (!info)` throw below.
  let tikwmCode = null;
  let tikwmNoInfo = false;
  let ytdlpNoFormats = false;
  // OWN FIRST (standing rule 2026-11-24): our own extraction runs
  // before any third-party resolver. TikTok: SSSTik and tikwm race in
  // PARALLEL and the first success wins (speed fix 2026-11-24) — but on
  // the SYNC path the race is CAPPED at 8s total (grace fix 2026-11-24,
  // see the TikTok branch below): a slow winner after 8s never counts,
  // and no slow fall-through ever runs. Own yt-dlp is OUT of the sync
  // race (speed fix 2026-11-25: it never won and starved the race) and
  // only runs on the job path. Awaiting own first cost 11-13s on a
  // blocked IP and pushed every TikTok answer past the frontend's 10s
  // per-origin budget. On the job path own still wins whenever it
  // answers first. The own attempt is bounded to
  // 13s: measured yt-dlp TikTok timings on this VM are 4.4-12.2s
  // (warm ~4.5s, cold ~12s), so 13s catches a cold start. The 25s
  // cap holds. (Job path: no 8s cap — the job has a 300s budget and
  // a slow winner is still a win there; the grace merge still applies.)
  let tiktokOwn = null;
  let tiktokOwnAttempted = false;
  if (isTikTok(url)) {
    tiktokOwnAttempted = true;
    // CAPPED RACE + GRACE WINDOW (2026-11-24, revised 2026-11-25):
    // own/tikwm/SSSTik start together at t=0 and the first non-null
    // answer wins — but on the SYNC path a win AFTER 8s never counts.
    // Live evidence (22:48 PKT): the same normal link answered 3.2s
    // (SSSTik won) and twice ~18s (a slow leg won after SSSTik was
    // slow that moment) — past the frontend's 10s per-origin budget,
    // so the visitor never saw those answers. The 8s cap takes
    // whatever is ready by then; nothing ready means the honest
    // timeout error below (the frontend retries the next origin).
    // The old freeapi fall-through is gone on the sync path for the
    // same reason: it needs ~11s, so it could only ever push the
    // total to ~18s. On the JOB path the cap does not apply and
    // freeapi still runs (see below).
    // PARALLEL START (2026-11-25): the short-link resolve used to run
    // serially in the /api/info handler BEFORE this race (~1.3s on a
    // short link) — but only tikwm needs the canonical URL (verified
    // 2026-11-25: tikwm hangs on short URLs, 15s timeout, no answer).
    // SSSTik resolves short links itself (verified: POST 200 in 2.6s
    // on the short URL, correct video id) and yt-dlp reaches its
    // verdict on the short URL too (9.5s, inside the 13s cap — the
    // no-stream verdict below still works). So SSSTik + own start at
    // t=0 on the pasted URL while the (cache-backed) resolve runs
    // alongside; tikwm starts on the canonical URL the moment the
    // resolve lands. On a repeat paste the resolve is a cache hit
    // (~0ms) and nothing changes.
    // GRACE WINDOW (2026-11-25, measured): 0 on the sync path, 3s on
    // the job path. The grace waited up to 3s after an SSSTik win for
    // tikwm's HD/SD/audio — but measured locally 2026-11-25 (3/3
    // SSSTik wins) tikwm lands ~5s AFTER SSSTik (2.7s vs 7.9s), so the
    // grace merged 0 times and only ever delayed the answer by the
    // full 3s (5.7s instead of 2.7s). The visitor asked for speed
    // first: the fast win goes out immediately. The merge code below
    // still runs when tikwm already settled with a value, and the job
    // path keeps the 3s grace — the visitor already waited there, and
    // the merged list is worth it. (Spec said ~2s; 2s merged only
    // 4/6 SSSTik wins in Nov — the gap is sometimes 2-3s — so the
    // window was 3s; Series ~7.5s, still <10s. That tuning is now
    // moot on the sync path: the gap is really ~5s, not 2-3s.)
    // Timeout notes (measured 2026-11-24, this VM): tikwm's own
    // processed_time is ~5.5s, so its old 5s cap aborted a working
    // resolver — the race cap is 8s, still inside the 10s budget
    // when it is the only answer. SSSTik's token fetch is ~1.4s
    // cold (~0s warm, 10-min cache, warmed in the background — see
    // ssstikToken below) + ~3s POST, so 7s.
    // Sync path only: applyTikTokCap is true when lookupInfo runs on
    // the 25s sync budget (timeoutMs 25000). The job path (300s
    // budget) skips the cap — a slow winner is still a win there —
    // but keeps the grace merge below. reqStart is the request/job
    // start (handler top / job.createdAt), so the cap counts the
    // short-link resolve too (1.5-6s, measured).
    const TIKTOK_RACE_CAP_MS = 8000;
    const applyTikTokCap = timeoutMs <= 25000;
    // GRACE (2026-11-26, TikTok all-qualities fix): 10s on BOTH paths.
    // The sync grace was 0 (2026-11-25, measured): tikwm landed ~5s
    // after SSSTik, so a 3s grace merged 0 times and only delayed the
    // answer. That is no longer true: tikwm now takes ~10-12s (and the
    // sync cap below aborted it at 8s, so the merge never landed in
    // time either). The user asked for ALL qualities together in the
    // first list, so the sync path now waits for tikwm like the job
    // path does. The wait is self-limiting: it only runs while tikwm
    // is still in flight (twOutcome undefined) — if tikwm already
    // failed, the answer goes out at once with no delay. Series
    // videos (tikwm never answers for them) pay the wait and still
    // return 1 format; that is the cost of completeness here.
    const TIKTOK_GRACE_MS = 10000;
    // Resolve runs alongside the race (see the PARALLEL START note
    // above): SSSTik + own use the pasted URL at once; tikwm waits for
    // the canonical URL because it hangs on short links.
    const resolveP = resolveTikTokShort(url);
    // SYNC PATH: own (yt-dlp) is NOT in the race (speed fix 2026-11-25,
    // measured): it never won (0/4 standalone, 0/4 in-race) and its 3
    // concurrent yt-dlp processes starve the race on this VM's 1.5
    // CPUs, so the 8s cap fired 4/4 with own on and SSSTik answered
    // 3/4 with it off. SSSTik usually wins the race, but the first
    // list now WAITS for tikwm (grace above) so it carries the union
    // (Best + HD/SD/Audio) instead of Best alone; tikwm keeps running
    // in the background for the merge store either way. JOB PATH: own
    // races as before (no cap, no contention with a first list) and
    // supplies the no-stream verdict. tiktokOwnAttempted stays true
    // on both paths so the generic block below never re-runs yt-dlp
    // for TikTok.
    const ownP = applyTikTokCap ? null : withTimeout(ytdlpInfoWithFallbacks(url), 13000, 'own TikTok extraction timed out')
      .then((r) => ({ kind: 'own', value: r }))
      .catch((e) => {
        // Own route failed (blocked IP, private/removed video, or
        // Series — yt-dlp finds no formats for Series). Record the
        // no-formats verdict for the no-stream branch below (the
        // generic block would have recorded it had it run).
        if (isNoFormats(e.detail)) ytdlpNoFormats = true;
        return { kind: 'own', value: null };
      });
    const twP = resolveP.then((canonical) => tikwmInfoDetailed(canonical, 15000))
      .then((tw) => { tikwmCode = tw.code; return { kind: 'tw', value: tw.info }; });
    // Track tikwm's outcome separately so the grace window below can
    // use it even when tikwm settled before SSSTik won — or is still
    // running. Never rejects (tikwmInfoDetailed catches everything).
    let twOutcome;
    const twDoneP = twP.then((cand) => { twOutcome = cand; }).catch(() => {});
    const ssP = ssstikInfo(url, 7000)
      .then((info) => ({ kind: 'ss', value: info }));
    let firstResolve;
    const firstP = new Promise((r) => { firstResolve = r; });
    let settledCount = 0;
    let raceDone = false;
    let capFired = false;
    // Legs in the race: 2 on the sync path (SSSTik + tikwm — own is
    // out, see above), 3 on the job path.
    const legCount = applyTikTokCap ? 2 : 3;
    const consider = (cand) => {
      settledCount++;
      if (raceDone) return;
      if (cand && cand.value) { raceDone = true; firstResolve(cand); }
      else if (settledCount === legCount) { raceDone = true; firstResolve(null); }
    };
    if (ownP) ownP.then(consider);
    twP.then(consider);
    ssP.then(consider);
    // Sync path only: the 8s cap, measured from request arrival
    // (reqStart), not the race start — the short-link resolve above
    // costs 1.5-6s and the frontend budget counts it. Job path: no
    // timer — the race settles on its own legs inside the 300s budget.
    let capTimer = null;
    if (applyTikTokCap) {
      capTimer = setTimeout(() => {
        if (!raceDone) { raceDone = true; capFired = true; firstResolve(null); }
      }, Math.max(0, TIKTOK_RACE_CAP_MS - (Date.now() - reqStart)));
    }
    const winner = await firstP;
    if (capTimer) clearTimeout(capTimer);
    // Progressive merge (2026-11-25): the fast win goes out at once
    // (sync grace is 0), but the other resolver leg keeps running;
    // when it lands, the union (Best + HD/SD/Audio) is stored in the
    // merge store for the frontend to pick up via GET /api/merge.
    // Only the two resolver legs are merged here — own (yt-dlp) has
    // its own answer shape and goes through the generic build when it
    // wins. The store only ever holds MORE formats than the answer
    // already sent, never fewer.
    if (winner && (winner.kind === 'ss' || winner.kind === 'tw')) {
      const mergeParts = {};
      mergeParts[winner.kind] = winner.value;
      const tryStoreMerge = () => {
        const merged = mergeTikTokInfos(mergeParts.ss, mergeParts.tw);
        if (merged && merged.formats.length > (winner.value.formats || []).length) mergeStoreSet(url, merged);
      };
      ssP.then((c) => { if (c && c.value) { mergeParts.ss = c.value; tryStoreMerge(); } }).catch(() => {});
      twP.then((c) => { if (c && c.value) { mergeParts.tw = c.value; tryStoreMerge(); } }).catch(() => {});
    }
    if (winner && winner.kind === 'own') {
      tiktokOwn = winner.value;
    } else if (winner && winner.kind === 'tw') {
      // tikwm answered first — same result as the old tikwm path:
      // fall through to the generic build + cache below.
      tikwmNoInfo = false;
      winner.value.titleOrigin = 'third-party'; // tikwm title — never a filename
      // COLD-LINK FIX (2026-11-26): a thin tikwm answer (<4 formats)
      // means tikwm failed on THIS origin (it returns 4 on SG). Mark
      // it partial so the frontend still starts the upgrade job and
      // the list can grow to Best+HD+SD+Audio instead of sticking at 1.
      if ((winner.value.formats || []).length < 4) winner.value.partial = true;
      result = winner.value;
    } else if (winner && winner.kind === 'ss') {
      // SSSTik answered first (usually Series, or a fast normal) —
      // signed token URL, never cached. Grace window (2026-11-26,
      // TikTok all-qualities fix): 10s on BOTH paths, waiting for
      // tikwm's HD/SD/audio to merge in so the first list carries
      // all 4 formats together. The old sync grace was 0 (the fast
      // win went out at once and the merge arrived progressively) —
      // that is what the user just reported. The wait is capped by
      // the race cap no longer: the 8s cap bounds the RACE, not the
      // grace, and bounding the grace by it (min(0, 8000-elapsed))
      // cut the wait to ~5s, before tikwm lands (~10s). The merge
      // below still applies when tikwm already settled with a value.
      const graceMs = TIKTOK_GRACE_MS;
      if (twOutcome === undefined && graceMs > 0) {
        await Promise.race([twDoneP, new Promise((ok) => setTimeout(ok, graceMs))]);
      }
      if (twOutcome && twOutcome.value) {
        const merged = winner.value;
        merged.formats = [...(merged.formats || []), ...twOutcome.value.formats];
        if ((merged.formats || []).length < 4) merged.partial = true; // still thin — upgrade can add the rest
        merged.titleOrigin = 'third-party'; // SSSTik/tikwm title — never a filename
        // 1s start: cache the signed URL (4 min, inside its ~5 min life)
        // so /api/save 302s at once instead of re-resolving SSSTik.
        rawCacheSet(url, merged, CHAIN_CACHE_TTL_MS);
        return { status: 200, body: merged };
      }
      winner.value.titleOrigin = 'third-party'; // SSSTik title — never a filename
      // COLD-LINK FIX (2026-11-26): SSSTik alone is 1 format — mark
      // it partial so the frontend starts the upgrade job instead of
      // treating Best-only as the complete list.
      winner.value.partial = true;
      rawCacheSet(url, winner.value, CHAIN_CACHE_TTL_MS);
      return { status: 200, body: winner.value };
    } else {
      // All legs failed, or (sync path only) the 8s cap cut the race.
      // Sync path: no slow fallback — freeapi needs ~11s and would push
      // the total to ~18s, past the frontend budget. Cap cut -> honest
      // timeout error now (same text as the 25s outer cap). Fast failure
      // -> fall through: the no-stream / generic error below is the best
      // error, and the verdicts are already recorded.
      // Job path: no cap exists, so a slow freeapi try (~11s) is fine
      // and can still save the job — it only runs when the race failed
      // fast, same as the old code. SSSTik already ran and failed in
      // the race, so there is nothing left to await from it.
      tikwmNoInfo = true;
      if (capFired) {
        return { status: 502, body: { error: 'This link is taking too long to read. Please try again.' } };
      }
      if (!applyTikTokCap) {
        const faBudget = Math.min(11000, budgetLeft());
        if (faBudget >= 3000) result = await freeapiInfo(url, faBudget);
        if (result) { rawCacheSet(url, result, CHAIN_CACHE_TTL_MS); return { status: 200, body: result }; }
      }
    }
    // Fall through to the generic yt-dlp build below when own
    // extraction won the race (tiktokOwn) — it reuses that result
    // instead of running yt-dlp a second time. When a resolver won,
    // `result` is already set and the generic block is skipped.
  }
  if (!result && isDouyin) {
    // Douyin embed-player lane (no login): the server calls Douyin's
    // own aweme detail API and returns the watermark-free CDN file
    // for the visitor's browser to fetch. yt-dlp is NOT used here —
    // its Douyin extractor needs cookies.
    result = await douyinInfo(url);
    // Videofish fallback (verified 2026-11-24, PROBE.md in
    // social-cn-fallbacks/: 6,588,975 B, h264 1280x720 — the same
    // file FreeApi returns, but resolved in ~3s instead of ~32s).
    // Runs only when the own embed lane found nothing. No cache:
    // the CDN URL is handed to the visitor promptly.
    if (!result) result = await videofishInfo(url, 'douyin', Math.min(12000, budgetLeft()));
    if (!result) throw new Error('Could not read this Douyin link. The video may be private, removed, or Douyin is blocking us right now.');
    result.clientSide = true;
    return { status: 200, body: result }; // no cacheSet: signed URLs live ~5 min
  }
  if (!result) {
    // Kuaishou / Haokan / Pear Video / Zhihu / Sohu: each has its own
    // no-login lane (see the functions above). No yt-dlp fall-through:
    // yt-dlp has no extractor for Kuaishou or Haokan, the direct
    // calls are faster than its Zhihu/Pear extractors, and its Sohu
    // extractor is the same slow endpoint the lane replaces (~20 s) —
    // falling through could only burn time against the 25s cap. Fail
    // fast with a clear error instead; the frontend retries the next
    // region. EXCEPTION: a lane returning {unsupported:true} (a URL
    // form the lane does not cover) falls through to yt-dlp below.
    const cnKey = clientSideKey(url);
    if (cnKey === 'kuaishou' || cnKey === 'haokan' || cnKey === 'pear' || cnKey === 'zhihu' || cnKey === 'sohu') {
      const cnName = { kuaishou: 'Kuaishou', haokan: 'Haokan', pear: 'Pear Video', zhihu: 'Zhihu', sohu: 'Sohu' }[cnKey];
      const cnFn = { kuaishou: kuaishouInfo, haokan: haokanInfo, pear: pearInfo, zhihu: zhihuInfo, sohu: sohuInfo }[cnKey];
      result = await cnFn(url);
      if (result && result.unsupported) {
        result = null; // URL form the lane does not cover: try yt-dlp below
      } else {
        if (!result && (cnKey === 'zhihu' || cnKey === 'pear')) {
          // Fallback (per-link, own route): the direct lane found
          // nothing — try yt-dlp's own extractor before giving up.
          // Kuaishou/Haokan have no yt-dlp extractor and Sohu's
          // unsupported forms fall through below, so only Zhihu/Pear
          // get this step. The 25s outer cap bounds the pair.
          result = await ytdlpDirectFallback(url);
        }
        // CN fallback chains (verified 2026-11-24, PROBE.md in
      // social-cn-fallbacks/): Pear -> Videofish (929,777 B, direct
      // CDN mp4); Haokan -> SnapVideoTools (26,144,091 B, 1080p,
      // Baidu signed URL); Kuaishou -> btch (5,130,563 B, direct CDN
      // mp4). FreeApi also works for Kuaishou but resolves in ~32s
      // — over the 25s cap, so it is NOT in the chain (REPORT.md).
      if (!result && cnKey === 'pear') {
        result = await videofishInfo(url, 'pearvideo', Math.min(12000, budgetLeft()));
        if (result) { result.clientSide = true; result.titleOrigin = 'third-party'; return { status: 200, body: result }; }
      }
      if (!result && cnKey === 'haokan') {
        result = await snapHaokan(url, Math.min(12000, budgetLeft()));
        if (result) { result.clientSide = true; result.titleOrigin = 'third-party'; return { status: 200, body: result }; }
      }
      if (!result && cnKey === 'kuaishou') {
        result = await btchKuaishou(url, Math.min(12000, budgetLeft()));
        if (result) { result.clientSide = true; result.titleOrigin = 'third-party'; return { status: 200, body: result }; }
      }
      if (!result) throw new Error('Could not read this ' + cnName + ' link. The video may be private, removed, or ' + cnName + ' is blocking us right now.');
        result.clientSide = true;
        if (cnKey !== 'kuaishou' && cnKey !== 'sohu') cacheSet(url, result); // Kuaishou/Sohu: signed URLs, no cache
        return { status: 200, body: result };
      }
    }
  }
  if (!result) {
    // Pinterest / Moj / ShareChat / Snapchat / Tumblr / X: the direct
    // file is read off the page itself (see scrapeDirectInfo) — scrape
    // first (fast, no yt-dlp). When the page embeds no usable file,
    // ShareChat / Snapchat / Pinterest / X try the bounded yt-dlp
    // fallback below (per-link, own route); Tumblr falls through to
    // the full yt-dlp block below; Moj has no yt-dlp extractor, so it
    // fails with a clear error.
    const scrapeKey = clientSideKey(url);
    if (scrapeKey === 'pinterest' || scrapeKey === 'moj' || scrapeKey === 'sharechat' || scrapeKey === 'snapchat' || scrapeKey === 'tumblr' || scrapeKey === 'x') {
      // Tumblr read API (the platform's own public API, no key):
      // try it before the page scrape.
      if (scrapeKey === 'tumblr') result = await tumblrReadInfo(url, 8000);
      if (!result) result = await scrapeDirectInfo(url);
      // A removed/private post (page answers 404/410): fail fast with
      // a clear message — 404 is terminal, so the frontend does not
      // waste its backup-origin retries on a post no region can read.
      if (result && result.dead) return { status: 404, body: { error: 'This post is no longer available — it was removed or made private.' } };
      // Pinterest: the pin page is challenged/slow from datacenter IPs
      // (live 502) — the widget API above returns the same mp4 as
      // ~6 KB of JSON. yt-dlp is skipped for Pinterest: it only ever
      // returns HLS manifests, which buildDirectFormats drops, so the
      // two 12s rounds were pure waste.
      if (!result && scrapeKey === 'pinterest') {
        result = await pinterestPidgetsInfo(url, Math.min(8000, budgetLeft()));
      }
      // ShareChat / Snapchat / X: when the page embeds no usable file,
      // try yt-dlp once before giving up — it reads og:video and the
      // platform extractors where the scrape cannot. (Per-link
      // fallback, own route.) Moj has no yt-dlp extractor and Tumblr
      // already falls through to the full yt-dlp block below, so
      // neither is listed here.
      if (!result && (scrapeKey === 'sharechat' || scrapeKey === 'snapchat' || scrapeKey === 'x')) {
        result = await ytdlpDirectFallback(url);
      }
      // X chain (verified 2026-11-24, PROBE.md in social-fallbacks/):
      // own scrape + yt-dlp found nothing — try the resolver chain
      // (fxtwitter, vxtwitter, SaveReelsFast, freeapi, curl-x, in
      // that order: fastest first so the 25s cap is not burned by
      // one slow lane). No cache: proxied/signed URLs.
      if (!result && scrapeKey === 'x') {
        result = await xChain(url, budgetLeft);
        if (result) {
          result.clientSide = true;
          result.titleOrigin = 'third-party'; // resolver-chain title — never a filename
          return { status: 200, body: result };
        }
      }
      if (result) {
        result.clientSide = true;
        cacheSet(url, result);
        return { status: 200, body: result };
      }
      // Tumblr falls through to the full yt-dlp block below when the
      // scrape finds nothing (image post or unreadable post). X gets
      // the bounded ytdlpDirectFallback above instead of the full
      // block: its yt-dlp extractor needs the GraphQL API, which
      // blocks datacenter IPs, so the full 20s rounds can never
      // succeed on Render — they only burned time and tripped the
      // 25s outer cap (the live "Finding qualities…" hang). The
      // bounded single attempt above is the most X can usefully get
      // from yt-dlp — the resolver chain above is X's real fallback.
      if (scrapeKey !== 'tumblr') throw new Error('Could not find a video file on this page. The video may be private, removed, or an image post.');
    }
    // Bluesky own lane (AT Protocol XRPC — the platform's own public
    // API, no key): getPostThread + getBlob returns the original
    // file (6,059,979 B, h264 1080x1920 on the probe). Runs BEFORE
    // yt-dlp for Bluesky posts. The getBlob URL is content-addressed
    // (CID), not signed, so the result may be cached.
    if (!result && clientSideKey(url) === 'bluesky') {
      result = await blueskyInfo(url, Math.min(15000, budgetLeft()));
      if (result) { result.clientSide = true; cacheSet(url, result); return { status: 200, body: result }; }
    }
    // Twitch clip own lane (anonymous GQL — the platform's own public
    // API, no key): 1080/720/480/360 signed mp4s (720p 17,474,567 B,
    // 1080p 43,989,736 B on the probe). Runs BEFORE yt-dlp for Twitch
    // clips. No cache: signed URLs. Clips only — VODs fall through
    // to yt-dlp (and its VOD guard).
    if (!result && clientSideKey(url) === 'twitch') {
      result = await twitchClipInfo(url, Math.min(10000, budgetLeft()));
      if (result) { result.clientSide = true; return { status: 200, body: result }; }
    }
    // Vimeo own lane (player config API — the platform's own API,
    // no key): direct progressive mp4s 240-1080p (240p file
    // 9,178,442 B verified). Runs BEFORE yt-dlp. No cache: signed
    // URLs. DRM-only videos have no progressive formats -> null,
    // fall through to yt-dlp (which also refuses them).
    if (!result && clientSideKey(url) === 'vimeo') {
      result = await vimeoInfo(url, Math.min(20000, budgetLeft()));
      if (result) { result.clientSide = true; return { status: 200, body: result }; }
    }
    // Streamable own lane (page HTML — the platform's own page):
    // direct signed mp4s 720p + 360p-mobile (full 720p file
    // 16,244,418 B verified). Runs BEFORE yt-dlp. No cache: signed
    // URLs expire ~24h.
    if (!result && clientSideKey(url) === 'streamable') {
      result = await streamableInfo(url, Math.min(10000, budgetLeft()));
      if (result) { result.clientSide = true; return { status: 200, body: result }; }
    }
    // Kwai own lane (page HTML — the platform's own page, slide-0
    // video player mp4; full file 4,868,564 B verified). Runs
    // BEFORE yt-dlp. No clientSide flag: cross-IP playback was
    // never proven, so the visitor saves through /api/save
    // (kw-video -> kwaiStreamUrl). No cache: signed URL.
    if (!result && clientSideKey(url) === 'kwai') {
      result = await kwaiInfo(url, Math.min(12000, budgetLeft()));
      if (result) return { status: 200, body: result };
    }
    // SoundCloud own lane (yt-dlp api-v2 HLS audio 96k/160k; the
    // freeapi.pro MP3 fallback runs INSIDE the lane, only when own
    // returns nothing on this link — 211.9s file 4,275,624 B
    // verified). Runs BEFORE yt-dlp. No cache: the fallback MP3
    // link may be signed / short-lived. DRM tracks have no formats.
    if (!result && clientSideKey(url) === 'soundcloud') {
      result = await soundcloudInfo(url, Math.min(20000, budgetLeft()));
      if (!result) throw new Error('Could not read this SoundCloud link. The track may be private, removed, or DRM-protected.');
      stripWorldcInternal(result);
      return { status: 200, body: result };
    }
    // Mixcloud own lane (yt-dlp, 64k ONLY — the full 54-min mix at
    // 64k took 20m02s from this VM; 192k would be ~3x that).
    // Runs BEFORE yt-dlp. No cache: the direct URL is a signed
    // "secure" path. The result note warns the visitor saving is slow.
    if (!result && clientSideKey(url) === 'mixcloud') {
      result = await mixcloudInfo(url, Math.min(20000, budgetLeft()));
      if (!result) throw new Error('Could not read this Mixcloud link. The mix may be private, removed, or Mixcloud is blocking us right now.');
      stripWorldcInternal(result);
      return { status: 200, body: result };
    }
    // Odysee own lane (LBRY resolve/get API, no key -> tokenised
    // HLS 144p/360p/720p; first 10s 144p segment 190,632 B
    // verified). Runs BEFORE yt-dlp. No cache: short-lived token.
    // Null (NOT_FOUND claim, non-video) falls through to generic
    // yt-dlp — its lbry extractor works on live claims.
    if (!result && clientSideKey(url) === 'odysee') {
      result = await odyseeInfo(url, Math.min(20000, budgetLeft()));
      if (result) { stripWorldcInternal(result); return { status: 200, body: result }; }
    }
    // BitChute own lane (public media API -> direct mp4; full 1196s
    // file 124,478,566 B verified). Direct fetch, NOT yt-dlp
    // (yt-dlp's call to the same endpoint fails from this VM).
    // Runs BEFORE yt-dlp. No cache: signed seed URL.
    if (!result && clientSideKey(url) === 'bitchute') {
      result = await bitchuteInfo(url, Math.min(15000, budgetLeft()));
      if (!result) throw new Error('Could not read this BitChute link. The video may be private, removed, or BitChute is blocking us right now.');
      stripWorldcInternal(result);
      return { status: 200, body: result };
    }
    // PeerTube own lane (yt-dlp, any instance; this instance is
    // HLS-only — 58,062,792 B file verified via the HLS 360p
    // variant). Runs BEFORE yt-dlp. Cache allowed: stable instance
    // files, no token in the URL. Null falls through to generic
    // yt-dlp (merged pairs are a genuine second route).
    if (!result && clientSideKey(url) === 'peertube') {
      result = await peertubeInfo(url, Math.min(20000, budgetLeft()));
      if (result) { stripWorldcInternal(result); cacheSet(url, result); return { status: 200, body: result }; }
    }
    // VK own lane (yt-dlp — the platform's own extractor path; the
    // watch page 302s to the homepage and vk.com/video 302s to a
    // login wall, so no page scrape exists). Progressive mp4s
    // 144-1080p (full 144p file 46,028,218 B verified). Runs BEFORE
    // the generic yt-dlp block below: that block would return the
    // raw url144 ids with IP-bound direct URLs, which a visitor's
    // browser cannot fetch. No clientSide flag: the visitor saves
    // through /api/save (vk-* -> vkOkStreamUrl). No cache: the
    // file URLs expire in ~3 days.
    if (!result && clientSideKey(url) === 'vk') {
      result = await vkInfo(url, Math.min(23000, budgetLeft()));
      if (result) return { status: 200, body: result };
    }
    // OK.ru own lane (yt-dlp first, page HTML backup only when
    // yt-dlp fails — see chains-vk-ok.js). Progressive mp4s
    // Mobile/Lowest/Low/SD/HD (30 s sd section 880,704 B verified).
    // Runs BEFORE the generic yt-dlp block, for the same reason as
    // VK. No clientSide flag: server-save only (ok-* ->
    // vkOkStreamUrl). No cache: the file URLs expire in ~24 h.
    if (!result && clientSideKey(url) === 'ok') {
      result = await okInfo(url, Math.min(20000, budgetLeft()));
      if (result) return { status: 200, body: result };
    }
    // Kick VOD own lane (yt-dlp -J -> HLS variants 160p/360p/480p/
    // 720p + audio; resolve ~5 s). Runs BEFORE yt-dlp. No cache:
    // signed variant URLs. No clientSide flag: the visitor saves
    // through /api/save, which remuxes the HLS to mp4 (kc- branch).
    if (!result && clientSideKey(url) === 'kick') {
      result = await kickInfo(url, Math.min(20000, budgetLeft()));
      if (result) return { status: 200, body: result };
    }
    let info = null;
    // FB/IG chain already ran to completion (and found nothing) in the
    // sync-path race below — the fallback chain after this block must
    // not re-run it.
    let fbIgChainDone = false;
    if (tiktokOwn) {
      // TikTok own-first: reuse the yt-dlp result the TikTok branch
      // already got — never run yt-dlp a second time for one paste.
      info = tiktokOwn.info;
      rawClientSet(url, tiktokOwn.clientArgs);
      rawProxySet(url, tiktokOwn.viaProxy);
    } else if (!tiktokOwnAttempted) {
      // FAST-QUALITY opts (2026-11-25): the sync path (25s budget) may
      // settle a partial first list; the job path (300s) waits for the
      // full list so the silent upgrade can actually deliver one.
      const fqOpts = { fastPartial: timeoutMs <= 25000, ydPrefetch, chocPrefetch };
      // FAST FIRST (2026-11-25): Facebook/Instagram on the SYNC path
      // race the chain in parallel with own yt-dlp — the chain's
      // fastest lane (xcasper ~3s FB, curl-x ~2-4s IG) is the first
      // list, marked partial:true so the frontend upgrades it silently
      // with the fuller own list. Chains used to run strictly AFTER
      // yt-dlp burned 7-14s, so the fastest lane never started in
      // time. On the JOB path the old order stands (own first, chain
      // fallback): the job is the completeness route.
      const raceFbIgChain = (isFacebook(url) || isInstagram(url)) && timeoutMs <= 25000;
      if (raceFbIgChain) {
        let raceWinnerKind = null;
        const chainP = (isFacebook(url) ? fbChain(url, budgetLeft) : igChain(url, budgetLeft))
          .then((c) => { if (c) raceWinnerKind = 'chain'; return c; })
          .catch(() => null);
        const ownP = (isInstagram(url)
          ? withTimeout(ytdlpInfoWithFallbacks(url, fqOpts), 14000, 'own Instagram extraction timed out')
          : ytdlpInfoWithFallbacks(url, fqOpts))
          .then((r) => { if (r) raceWinnerKind = 'own'; return r; })
          .catch((e) => {
            if (e.geoBlocked || isGeoBlocked(e.detail)) { e.geoBlocked = true; throw e; }
            if (isNoFormats(e.detail)) ytdlpNoFormats = true;
            console.error('info failed:', platformOf(url), scrub(e.detail || e.message));
            return null;
          });
        const first = await firstNonNull([ownP, chainP]);
        if (first && raceWinnerKind === 'chain') {
          if (isInstagram(url)) {
            // INSTAGRAM — ALL QUALITIES TOGETHER (2026-11-26): the
            // chain's first list is thin (curl-x, 1 format "Video")
            // while the own leg returns the full list (Best + 1920p +
            // 1280p + Audio). Cold first list was 1 format on EU
            // (3.4s) and on a fresh local process (3.4s); the own leg
            // returns 4 formats in ~7-10s from Render (live job +
            // SG origin). The user wants all qualities together in
            // the first list, so wait for the own leg (already
            // running, 14s cap) and prefer its full list; fall back
            // to the chain's thin answer only if own fails. Time
            // cost: first list ~7-10s (over the 5s rule) — the full
            // IG list cannot be computed faster from Render; no chain
            // lane returns it (curl-x 1, freeapi times out,
            // instapdown 1). Facebook is NOT changed: the chain's 2
            // formats (xcasper, with audio) ARE the full list and are
            // better than own's video-only hd/sd.
            const own = await ownP.catch(() => null);
            if (own) {
              info = own.info;
              if (own.partial) infoPartial = true;
              rawClientSet(url, own.clientArgs);
              rawProxySet(url, own.viaProxy);
            } else {
              first.titleOrigin = 'third-party';
              first.partial = true;
              return { status: 200, body: first };
            }
          } else {
            // FACEBOOK — ALL QUALITIES TOGETHER (2026-11-26): the
            // chain's first list is thin (xcasper HD+SD, 2 formats)
            // while the own leg returns the fuller list (DASH tiers as
            // merged video+audio pairs + Audio only). The user tested
            // it himself: 2 first, the rest later via the upgrade job
            // (live job on EU/SG returns 6: HD/SD video-only +
            // 2560p/1920p/1280p merged + Audio; main returns 2 because
            // own fails there). So wait for the own leg (already
            // running) and return the UNION: the chain's with-sound
            // single files first, then own's merged pairs + Audio
            // only. Own's video-only HD/SD rows are dropped — the
            // chain's with-sound HD/SD are the same files with sound,
            // so a silent duplicate of a with-sound row must never
            // show. The wait is capped by the remaining sync budget
            // (up to ~20s): own takes 5s on EU but 15-20s on this VM
            // for a 57-min video (two concurrent yt-dlp attempts share
            // 1.5 CPUs), so a 15s cap misses it locally — the union
            // must wait out the full budget. If own fails, times out,
            // or adds nothing, fall back to the chain's thin answer
            // (partial:true) so the upgrade job still runs. Time cost:
            // first list ~8s live (EU's own is fast) but up to ~23s
            // when own is slow — over the 5s rule; the full FB list
            // cannot be computed faster, the DASH tiers only come from
            // own. The union is the full list, so no partial flag (no
            // upgrade job); the fallback keeps partial:true.
            const ownCap = Math.min(20000, Math.max(3000, budgetLeft()));
            const own = await withTimeout(ownP, ownCap, 'own Facebook extraction timed out').catch(() => null);
            if (own && own.info) {
              const ownRows = buildFormats(own.info, { facebookVideoOnly: true });
              const ownExtra = ownRows.filter((f) => {
                if (!f) return false;
                if (!f.hasAudio && (String(f.id || '').toLowerCase() === 'hd' || String(f.id || '').toLowerCase() === 'sd')) return false;
                return true;
              });
              const seen = new Set((first.formats || []).map((f) => String(f && f.id)));
              const union = (first.formats || []).slice();
              for (const f of ownExtra) {
                if (!seen.has(String(f.id))) { seen.add(String(f.id)); union.push(f); }
              }
              if (union.length > (first.formats || []).length) {
                rawClientSet(url, own.clientArgs);
                rawProxySet(url, own.viaProxy);
                first.formats = union;
                first.titleOrigin = 'third-party'; // fbChain title — never a filename
                if (own.partial) first.partial = true;
                else delete first.partial;
                return { status: 200, body: first };
              }
            }
            // Own failed/timed out or added nothing — chain's thin
            // answer, the upgrade job still runs.
            first.titleOrigin = 'third-party'; // fbChain/igChain title — never a filename
            first.partial = true;
            return { status: 200, body: first };
          }
        } else if (first && raceWinnerKind === 'own') {
          info = first.info;
          if (first.partial) infoPartial = true;
          rawClientSet(url, first.clientArgs);
          rawProxySet(url, first.viaProxy);
        } else {
          // Both legs settled with nothing — the chain already ran to
          // completion, so the fallback below must not re-run it.
          fbIgChainDone = true;
        }
      } else {
      try {
        // Instagram: yt-dlp's plain attempt takes ~10-13s; the 14s
        // cap (observed own successes are 10-11s) stops a slow own
        // leg starving the chain — the call 502s even though
        // curl-x/freeapi answer in ~3.5s each. The timeout only
        // rejects the race — the underlying process ends on its own
        // 20s round cap.
        const ownP = isInstagram(url)
          ? withTimeout(ytdlpInfoWithFallbacks(url, fqOpts), 14000, 'own Instagram extraction timed out')
          : ytdlpInfoWithFallbacks(url, fqOpts);
        const res = await ownP;
        info = res.info;
        if (res.partial) infoPartial = true;
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
        // No formats: remember the verdict for the no-stream check
        // below (the outer catch turns it into a noStream 502).
        if (isNoFormats(e.detail)) ytdlpNoFormats = true;
        console.error('info failed:', platformOf(url), scrub(e.detail || e.message));
      }
      }
    }
    // (tiktokOwnAttempted && !tiktokOwn): own extraction already ran
    // and failed in the TikTok branch above, and tikwm + freeapi +
    // SSSTik also found nothing — there is no fifth route. info stays
    // null for the honest error below instead of burning the 25s cap
    // on a repeat run.
    // YT-LONG FIX (2026-11-26): a CHAIN answer (chocFastP winner) is
    // returned as-is, like the ytChain early return below. Its formats
    // carry no vcodec/acodec/height, so buildFormats would collapse
    // all 10 video rows into one "Best quality" row with id
    // "undefined" and pair them into merged ids chainStreamUrl cannot
    // resolve. The formats are already public (ch- ids, saveable via
    // /api/save's chain branch). The preview is the choc video-only
    // stream (playable: ACAO: *, Range) — no relay needed, so no
    // previewStream is set here; the upgrade job adds the YT-A
    // progressive format + the relay.
    if (info && info.chainAnswer) {
      const body = {
        title: stripTitleCounts(info.title) || 'Video',
        titleOrigin: 'third-party',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        uploader: info.uploader || '',
        formats: info.formats,
        partial: true,
      };
      attachChainPreview(body, url);
      rawCacheSet(url, info, CHAIN_CACHE_TTL_MS);
      return { status: 200, body };
    }
    // NO PUBLIC STREAM (TikTok only): every lane agreed the video has
    // no stream to fetch — tikwm returned no video, SSSTik could not
    // resolve it, and yt-dlp's own verdict was "No video formats
    // found" (TikTok's API returned an aweme with no video URL, e.g.
    // a Series episode). This is NOT a timeout: a slow/blocked
    // extraction fails differently (no answer, 403, "IP blocked",
    // "Video unavailable"), and none of those set ytdlpNoFormats —
    // so a normal video, a deleted/private one, or a TikTok outage
    // can never land here. tikwm's definitive code -1 is recorded
    // above (tikwmCode) but is NOT required: its -1 answers take
    // 13-20s while the tikwm call is capped at 6s, so a no-stream
    // video usually shows up as code null (aborted) — the yt-dlp
    // leg is what makes the verdict safe.
    if (!info && isTikTok(url) && tikwmNoInfo && ytdlpNoFormats) {
      const err = new Error('This video has no public download link — TikTok doesn\u2019t publish one for it.');
      err.noStream = true;
      console.error('info no-stream:', platformOf(url), 'tikwm code:', tikwmCode);
      throw err;
    }
    // Facebook / Instagram chains (verified 2026-11-24, PROBE.md in
    // social-fallbacks/): own yt-dlp found nothing — try the resolver
    // chains (FB: xcasper, SaveReelsFast, curl-x, freeapi; IG:
    // curl-x, freeapi, instapdown). On the SYNC path the chain already
    // raced own above and lost (fbIgChainDone) — this only runs on the
    // job path. No cache: signed URLs. These two
    // are NOT client-side-only, so the result goes back without the
    // clientSide flag and /api/save can stream the chain file.
    // Tencent chain (verified 2026-11-24, PROBE.md in
    // social-cn-fallbacks/): own yt-dlp found nothing — try
    // Videofish (119,041,583 B, direct Tencent CDN mp4). No cache.
    if (!info && clientSideKey(url) === 'tencent') {
      const tx = await videofishInfo(url, 'tencent-video', Math.min(12000, budgetLeft()));
      if (tx) { tx.clientSide = true; tx.titleOrigin = 'third-party'; return { status: 200, body: tx }; }
    }
    if (!info && !fbIgChainDone && (isFacebook(url) || isInstagram(url))) {
      const chain = isFacebook(url)
        ? await fbChain(url, budgetLeft)
        : await igChain(url, budgetLeft);
      if (chain) { chain.titleOrigin = 'third-party'; return { status: 200, body: chain }; }
    }
    // LinkedIn chain (verified 2026-11-24, PROBE.md in
    // social-west-fallbacks/): own yt-dlp found nothing — try
    // SaveReelsFast (one 720p file, 4,057,201 B verified). No cache:
    // signed URL.
    if (!info && clientSideKey(url) === 'linkedin') {
      const li = await srfInfo(url, Math.min(20000, budgetLeft()));
      if (li) { li.clientSide = true; li.titleOrigin = 'third-party'; return { status: 200, body: li }; }
    }
    // YouTube chain (verified 2026-11-24, PROBE.md in yt-fallbacks/
    // and yt-fallbacks-b/): own yt-dlp + mirrors found nothing — try
    // the resolver chain (ytdownloader.tech, y2mate/eta, Invidious
    // choc proxy, cobalt rue, in that order). Result cached 4 min (signed URL life ~5 min).
    // Budget reality: after full own failure on a blocked IP the
    // remaining budget is ~0-4s, so these lanes fire mainly when own
    // fails FAST (see REPORT.md).
    if (!info && isYouTube(url)) {
      let yt = await ytChain(url, budgetLeft, ydPrefetch, chocPrefetch);
      // YT-A RESILIENCE (2026-11-26, cold-link fix): when the chain
      // returns a THIN list on the JOB path (no sync cap — timeoutMs
      // is the 300s job budget), YT-A may be rate-limiting right now
      // and recover after ~60s (documented 2026-11-26). Wait once and
      // re-resolve YT-A; if the fresh resolve is fuller, use the
      // union. Bounded (one retry, job path only) — a thin list that
      // does not recover is still returned, marked partial.
      if (yt && chainListIsThin(yt.formats) && timeoutMs > 60000 && budgetLeft() > 90000) {
        await new Promise((ok) => setTimeout(ok, 60000));
        try {
          const fresh = await ytdownloaderTech(url, 20000);
          if (fresh && Array.isArray(fresh.formats) && fresh.formats.length > (yt.formats || []).length) {
            yt = mergeChainAnswers([yt, fresh]);
          }
        } catch {}
      }
      if (yt) {
        yt.titleOrigin = 'third-party';
        attachChainPreview(yt, url);
        // A thin union (e.g. YT-A alone, 1 format) is partial so the
        // frontend still starts the silent upgrade job.
        if (chainListIsThin(yt.formats)) yt.partial = true;
        rawCacheSet(url, yt, CHAIN_CACHE_TTL_MS);
        return { status: 200, body: yt };
      }
    }
    if (!info) throw new Error('Could not read this link. The video may be private, removed, or the site is blocking us.');
    // Twitch VOD guard: full broadcasts are hours long and stream-only
    // (HLS playlists, no single file) — only short clips can be saved.
    // Refuse them plainly instead of offering a download that cannot
    // ever complete as one file.
    if (scrapeKey === 'twitch' && (info.duration || 0) > 7200) {
      return { status: 404, body: { error: 'This is a full Twitch broadcast (' + Math.round(info.duration / 3600) + 'h long). Broadcasts stream only and cannot be saved as one file — only short Twitch clips can be saved.' } };
    }
    // Sohu reaches here through yt-dlp's own extractor when its lane
    // returns {unsupported:true} (a URL form the lane does not cover).
    // The extractor reads the page's vid, then hot.vrs.sohu.com
    // (429s after ~6–8 rapid calls from one IP — one info call per
    // paste keeps us under it) and the allot endpoint for a direct
    // mp4; some Sohu videos are licensed to Mainland China only and
    // fail per-video as geo-blocked.
    rawCacheSet(url, info);
    if (isClientSideOnly(url)) {
      // Direct files only — the visitor's browser downloads them itself.
      // No merged pairs, no server save: a video with no direct file
      // is reported as such instead of being listed.
      const formats = buildDirectFormats(info);
      if (!formats.length) return { status: 404, body: { error: 'This video has no direct file to save. It only streams, so the browser cannot download it as one file.' } };
      result = {
        title: stripTitleCounts(info.title) || 'Video',
        titleOrigin: info.titleOrigin || 'original',
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
      const formats = buildFormats(info, { noSeparateAudio: isTikTok(url), facebookVideoOnly: isFacebook(url) });
      if (!formats.length) return { status: 404, body: { error: 'No playable versions were found for this link.' } };
      result = {
        title: stripTitleCounts(info.title) || 'Video',
        titleOrigin: info.titleOrigin || 'original',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        uploader: info.uploader || info.channel || '',
        previewUrl: previewUrl(info),
        formats,
      };
    }
  }
  // PREVIEW SOUND (2026-11-25): previewUrl(info) picks from the RAW
  // format list, which can be a video-only DASH variant (Instagram
  // m367, YouTube itag 315) while the public quality list already holds
  // a with-sound file (Instagram Best m86, YouTube itag 18). Prefer the
  // highest public format that is a real file with sound (a url, a
  // video — not the Audio-only row — and hasAudio); fall back to the
  // raw pick when none exists. This never overrides a working preview
  // with a worse one — it only swaps a silent preview for a file that
  // actually carries sound. (Chain-lane answers return early above and
  // keep their own previewUrl.)
  if (result && Array.isArray(result.formats)) {
    const heightOf = (f) => {
      const m = String(f.label || '').match(/(\d{3,4})p/);
      return m ? parseInt(m[1], 10) : 0;
    };
    const withSound = result.formats
      .filter((f) => f && f.url && f.hasAudio && f.label !== 'Audio only' &&
        ['mp4', 'webm'].includes(String(f.ext || 'mp4').toLowerCase()))
      .sort((a, b) => (heightOf(b) - heightOf(a)) || ((b.filesize || 0) - (a.filesize || 0)))[0];
    if (withSound) result.previewUrl = withSound.url;
  }
  // FAST FIRST RENDER (speed fix 2026-11-25): a degraded/partial
  // YouTube answer carries top-level partial: true in the /api/info
  // body (and in the /api/job ready body, which reuses it) so the
  // frontend can recognise it and upgrade it silently.
  if (infoPartial && result) result.partial = true;
  // YT-LONG FIX (2026-11-26): when the preview URL is unplayable
  // cross-origin (YT-A proxy / googlevideo), attach the same-origin
  // relay so the frontend's preview player can actually play it.
  if (result) attachPreviewStream(result, url);
  // Sohu: signed URLs (see above) — never store the result.
  // A degraded YouTube result (android-only, e.g. just format 18)
  // must NOT be cached for 10 minutes either: it would show every
  // visitor one quality long after the egress recovers and a fuller
  // list is available. A degraded list has no merged video+audio
  // pair (no '+' in any id) and no audio-only row — a full list
  // always has both. Skipping the cache just means the next paste
  // re-runs the lookup and can get the full list.
  const ytDegraded = isYouTube(url) && Array.isArray(result && result.formats) &&
    !result.formats.some((f) => String(f.id || '').includes('+')) &&
    !result.formats.some((f) => f.label === 'Audio only');
  // COLD-LINK FIX (2026-11-26): a thin TikTok answer (partial, <4
  // formats) must not be locked in for 10 minutes — the next paste
  // would re-serve the 1-format list instead of re-running the lookup
  // (which can now reach a woken SG and return all 4).
  const ttThin = isTikTok(url) && result && result.partial;
  if (noCacheKey !== 'sohu' && !ytDegraded && !infoPartial && !ttThin) cacheSet(url, result);
  return { status: 200, body: result };
} catch (e) {
  if (e.geoBlocked) {
    console.error('info geo-blocked:', platformOf(url), scrub(e.detail || ''));
    return { status: 502, body: { error: 'This video is blocked in this region.', geoBlocked: true } };
  }
  // No public stream: the frontend shows this verbatim instead of the
  // timeout message — the video is not slow, it has no link to fetch.
  if (e.noStream) {
    return { status: 502, body: { error: e.message, noStream: true } };
  }
  console.error('info failed:', scrub(e.message));
  return { status: 502, body: { error: 'Could not read this link. Please try another one.' } };
}
}
app.post('/api/info', rateLimit('info', 30, 60000), async (req, res) => {
  // Request-start clock (grace fix 2026-11-24): the TikTok 8s cap is
  // measured from HERE, not from the race start — the short-link
  // resolve below alone costs 1.5-6s, and the frontend's 10s budget
  // counts all of it. Without this, a slow resolve + full race could
  // answer at ~10s, past the budget the cap exists to respect.
  const reqStart = Date.now();
  let url = String(req.body && req.body.url || '').trim();
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Please paste a valid video link from TikTok, Douyin, Facebook, Instagram, YouTube, X, Bluesky, Tumblr, Twitch, Pinterest, Moj, ShareChat, LinkedIn, Snapchat, Tencent Video, Kuaishou, Haokan, Pear Video, Zhihu, Sohu, Vimeo, Streamable, Kwai, SoundCloud, Mixcloud, Odysee, BitChute, PeerTube, VK, OK.ru or Kick.' });
  }
  // TikTok short links: NO serial resolve here any more (2026-11-25).
  // The resolve used to block the whole lookup (~1.3s on a short
  // link) before any extraction started. It now runs inside
  // lookupInfo's TikTok branch, in parallel with the race (SSSTik +
  // own start at t=0 on the pasted URL; tikwm starts on the canonical
  // URL when the resolve lands). The cache lookup below keys on the
  // pasted URL — harmless for TikTok, whose signed-URL results are
  // never cached anyway (own-wins cache under the pasted URL).
  // Douyin: signed CDN URLs live ~5 min, shorter than the 10-min info
  // cache — never serve a cached Douyin result, and never store one.
  // Kuaishou: same treatment — its signed CDN URLs have no visible
  // expiry, so they are resolved fresh on every request.
  // Sohu's sig token is minted per request — likewise resolved fresh
  // on every request. VK file URLs expire in ~3 days and OK.ru's in
  // ~24 h — likewise resolved fresh on every request.
  const isDouyin = clientSideKey(url) === 'douyin';
  const noCacheKey = clientSideKey(url);
  const cached = (isDouyin || noCacheKey === 'kuaishou' || noCacheKey === 'sohu' || noCacheKey === 'vk' || noCacheKey === 'ok') ? null : cacheGet(url);
  if (cached) return res.json(cleanBodyTitle(cached));
  // Hard 25s overall cap: whatever the extraction path does (tikwm,
  // page scrape, yt-dlp fallback rounds), /api/info ALWAYS answers
  // within 25s — success, a clear 404/502 from the lookup, or the
  // timeout 502 below. The lookup itself returns {status, body} and
  // never touches res, so a late background finish cannot double-send.
  // (Per-attempt timeouts inside are unchanged; this is only the outer cap.)
  try {
    const out = await withTimeout(lookupInfo(url, 25000, reqStart), 25000, 'Info lookup timed out. Please try again.');
    return res.status(out.status).json(cleanBodyTitle(out.body));
  } catch (e) {
    console.error('info timed out:', platformOf(url));
    // YouTube-specific timeout message (2026-11-25): the generic
    // "taking too long" text hid that the slow leg was YouTube. Other
    // platforms keep the generic text.
    if (isYouTube(url)) return res.status(502).json({ error: 'YouTube is slow to respond from our server right now - please try again' });
    return res.status(502).json({ error: 'This link is taking too long to read. Please try again.' });
  }
});

// ---- Progressive TikTok merge (GET /api/merge?url=...) --------------------
// After a fast Best-only answer, the other resolver leg may still land
// with HD/SD/Audio — the race stores the union in the merge store (see
// lookupInfo). The frontend polls this light endpoint for up to ~12s
// and swaps the fuller list in when it appears. 404 means "nothing
// extra yet" (not an error) — the visitor keeps the qualities already
// shown. No lookup runs here, so it is cheap; own bucket (30/min).
app.get('/api/merge', rateLimit('merge', 30, 60000), async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Please paste a valid video link.' });
  const merged = mergeStoreGet(url);
  if (!merged) return res.status(404).json({ error: 'No extra qualities yet.' });
  return res.json(merged);
});

// ---- Background jobs: slow videos (POST /api/job, GET /api/job/:id) ----
// Some videos can never finish inside /api/info's 25s cap: long YouTube
// videos (resolver flow ~28s, convert 120s+), Douyin/Kuaishou (~32s
// resolve), Moj/ShareChat (~30-60s jobs), Zhihu (session-cookie jobs).
// For those, the frontend starts a background job and polls it: the
// lookup runs through the same lookupInfo() with a long budget instead
// of the 25s sync cap, and the fast path is untouched — videos that
// answer fast never touch jobs. Jobs live in memory only (free tier, no
// DB) and expire after JOB_TTL_MS; job ids are 128-bit random hex,
// unguessable, and there is no listing endpoint, so one visitor's job is
// invisible to another. A job that finishes also warms the info cache
// (via lookupInfo's own cacheSet), so a later sync paste may hit it.
// NOTE: on the free tier the process sleeps after ~15 min idle — a job
// running when the process sleeps is lost and its poll starts 404ing;
// the frontend then shows the plain "taking too long" message.
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS) || 10 * 60 * 1000;
const JOB_RUN_MS = Number(process.env.JOB_RUN_MS) || 300000;
const JOB_MAX_PER_IP = Number(process.env.JOB_MAX_PER_IP) || 3;
const JOB_MAX_TOTAL = Number(process.env.JOB_MAX_TOTAL) || 200;
const jobs = new Map(); // id -> {id, url, ip, status, step, createdAt, startedAt, finishedAt, result, error, geoBlocked, noStream}

// Expected wall time per platform (measured): used ONLY for the progress
// percentage shown while polling — the job itself runs until lookupInfo
// returns or JOB_RUN_MS hits, whichever comes first.
const JOB_EXPECTED_MS = { youtube: 60000, douyin: 35000, kuaishou: 35000, moj: 65000, sharechat: 35000, zhihu: 50000 };
function jobExpectedMs(url) {
  const key = clientSideKey(url);
  if (key && JOB_EXPECTED_MS[key]) return JOB_EXPECTED_MS[key];
  if (isYouTube(url)) return 60000;
  return 40000;
}
function jobStep(url) {
  const key = clientSideKey(url);
  // NOTE: clientSideKey has no 'youtube' entry (YouTube is the default
  // own lane), so the YouTube case is checked with isYouTube, not key.
  if (isYouTube(url)) return 'Reading the long video…';
  if (key === 'douyin' || key === 'kuaishou') return 'Reading the video…';
  if (key === 'moj' || key === 'sharechat') return 'Waiting for the video file…';
  if (key === 'zhihu') return 'Reading the video…';
  return 'Reading the link…';
}
function jobProgress(job) {
  if (job.status === 'ready') return 100;
  const elapsed = Date.now() - job.startedAt;
  return Math.min(95, Math.floor((elapsed / jobExpectedMs(job.url)) * 100));
}
function jobPublic(job) {
  const out = {
    id: job.id,
    status: job.status,
    progress: jobProgress(job),
    step: job.step,
    createdAt: job.createdAt,
  };
  // The progress is elapsed-based and caps at 95% while the lookup still
  // runs — say so plainly once it saturates, instead of sitting at 95%
  // with the original step for minutes.
  if (job.status === 'pending' && out.progress >= 95) out.step = 'Almost there — finishing up…';
  if (job.status === 'ready' && job.result) { Object.assign(out, job.result); cleanBodyTitle(out); }
  if (job.status === 'failed') {
    out.error = job.error || 'Could not read this link. Please try another one.';
    if (job.geoBlocked) out.geoBlocked = true;
    if (job.noStream) out.noStream = true;
  }
  return out;
}

async function runJob(job) {
  try {
    let url = job.url;
    if (isTikTok(url)) url = await resolveTikTokShort(url);
    const out = await withTimeout(lookupInfo(url, JOB_RUN_MS, job.createdAt), JOB_RUN_MS, 'Background lookup timed out.');
    if (!jobs.has(job.id)) return; // deleted/cancelled while running
    if (out.status === 200) {
      job.status = 'ready';
      job.result = out.body;
    } else {
      job.status = 'failed';
      job.error = (out.body && out.body.error) || 'Could not read this link. Please try another one.';
      if (out.body && out.body.geoBlocked) job.geoBlocked = true;
      if (out.body && out.body.noStream) job.noStream = true;
    }
  } catch (e) {
    if (!jobs.has(job.id)) return;
    job.status = 'failed';
    job.error = 'This link is taking too long to read. Please try again.';
    console.error('job failed:', scrub(e.message));
  } finally {
    if (jobs.has(job.id)) job.finishedAt = Date.now();
  }
}

// Expire old jobs (finished or not) so the in-memory map never grows
// without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60000).unref();

app.post('/api/job', rateLimit('job-create', 10, 60000), async (req, res) => {
  const url = String(req.body && req.body.url || '').trim();
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Please paste a valid video link.' });
  }
  const ip = req.ip || 'unknown';
  const key = clientSideKey(url);
  // Same no-cache platforms as /api/info: their signed URLs expire
  // faster than the info cache, so a cached result must never be served.
  const noCache = key === 'douyin' || key === 'kuaishou' || key === 'sohu' || key === 'vk' || key === 'ok';
  if (!noCache) {
    const cached = cacheGet(url);
    if (cached) {
      const id = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      jobs.set(id, { id, url, ip, status: 'ready', step: 'Ready', createdAt: now, startedAt: now, finishedAt: now, result: cached, error: null });
      return res.status(202).json({ jobId: id, status: 'ready', progress: 100, step: 'Ready' });
    }
  }
  // Same URL already running for this IP: return the existing job instead
  // of starting a duplicate lookup.
  for (const j of jobs.values()) {
    if (j.ip === ip && j.status === 'pending' && j.url === url) {
      return res.status(202).json({ jobId: j.id, status: 'pending', progress: jobProgress(j), step: j.step });
    }
  }
  let active = 0;
  for (const j of jobs.values()) if (j.ip === ip && j.status === 'pending') active++;
  if (active >= JOB_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many background downloads at once. Please wait for one to finish.' });
  }
  if (jobs.size >= JOB_MAX_TOTAL) {
    return res.status(429).json({ error: 'Too many background downloads right now. Please try again in a moment.' });
  }
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const job = { id, url, ip, status: 'pending', step: jobStep(url), createdAt: now, startedAt: now, finishedAt: null, result: null, error: null };
  jobs.set(id, job);
  runJob(job); // background — never awaited; the 202 below answers at once
  return res.status(202).json({ jobId: id, status: 'pending', progress: 0, step: job.step });
});

app.get('/api/job/:id', rateLimit('job-get', 30, 60000), (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return res.status(404).json({ error: 'Job not found.' });
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json(jobPublic(job));
});

app.delete('/api/job/:id', rateLimit('job-delete', 30, 60000), (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return res.status(404).json({ error: 'Job not found.' });
  if (!jobs.has(id)) return res.status(404).json({ error: 'Job not found.' });
  jobs.delete(id); // frees the per-IP slot; a running lookup's result is discarded
  return res.json({ deleted: true });
});

// Short honest note shown under a client-side-only platform's qualities:
// Twitch only saves clips.
function clientSideNote(url, info) {
  const key = clientSideKey(url);
  if (key === 'twitch') return 'Twitch clips only — full broadcasts stream only and cannot be saved as one file.';
  if (key === 'tumblr') return 'Only posts with a video uploaded here can be saved — GIFs and embedded players have no video file.';
  if (key === 'pear') return '';
  return '';
}

app.get('/api/save', rateLimit('save', 10, 60000), async (req, res) => {
  const url = String(req.query.url || '').trim();
  const formatId = String(req.query.formatId || '').trim();
  // Filename title (user rules 2026-11-25/26): the ORIGINAL title — the
  // frontend's fileTitle when it is a real video title, else the
  // /api/info title cached for this link, else "video-<id>" so two
  // different videos never share "video.mp4". Counts are stripped and
  // a repeated title is collapsed to one copy (see saveTitle).
  const title = saveTitle(req, url);
  // PREVIEW RELAY (YT-long fix 2026-11-26): preview=1 streams the
  // file as inline video (no redirect, no Content-Disposition) so a
  // <video> element can play a URL that is unplayable cross-origin
  // (YT-A proxy / googlevideo). This is the inline PREVIEW only —
  // the Save button never sends preview=1, so downloads (and the
  // 302-vs-filename decision) are unchanged.
  const isPreview = req.query.preview === '1';
  // Headers for this request: preview headers when preview=1, else
  // the normal download headers. One place, so no branch can forget.
  const sendHeaders = (ext, contentType) => {
    if (isPreview) setPreviewHeaders(res, contentType);
    else setDownloadHeaders(res, title, ext, contentType);
  };
  if (!url || !(await validateUserUrl(url))) {
    return res.status(400).json({ error: 'Invalid link.' });
  }
  // Client-side-only platforms never download through the server: their
  // files are fetched by the visitor's own browser. A save request for
  // one is refused here so no code path can silently stream it.
  if (isClientSideOnly(url)) {
    return res.status(400).json({ error: 'This video saves straight from your browser — use the Save button on the page.' });
  }
  // 1-SECOND START (2026-11-25): when /api/info already resolved this
  // link, its raw formats carry direct file URLs. If the requested
  // format's URL is a public CDN file the visitor's browser can fetch
  // itself, redirect at once — no resolver, no yt-dlp, no fetch. The
  // browser's download starts the moment the 302 lands. googlevideo
  // URLs are never redirected (IP-bound — see isRedirectSafeUrl) and
  // fall through to the stream paths below. NOTE: a redirect hands the
  // browser the CDN's own filename, not the video title — the title
  // filename only survives on server-streamed downloads (see REPORT).
  // A preview NEVER redirects (the redirect target is exactly the
  // unplayable URL) — it streams through the server below instead.
  if (!formatId.includes('+') && !isPreview) {
    const rawForSave = rawCacheGet(url);
    const saveFmt = rawForSave && Array.isArray(rawForSave.formats)
      ? rawForSave.formats.find((f) => f && (String(f.format_id) === formatId || String(f.id) === formatId) && f.url)
        || ((formatId === 'best' || formatId === 'ssstik-best')
          ? rawForSave.formats.find((f) => f && f.url) : null)
      : null;
    if (saveFmt && isRedirectSafeUrl(saveFmt.url)) {
      // ORIGINAL TITLE (2026-11-26, user decision — title name wins over
      // the fast 302): a bare 302 hands the browser the CDN's filename
      // (ssstik.io_....mp4, video.mp4, Instagram.mp4), so the title
      // filename is lost. Stream the file through the server instead,
      // with Content-Disposition carrying the original title (same
      // streamThrough the preview relay uses). Cost: the download starts
      // when the server's fetch answers (~0.5–3s TTFB) instead of
      // instantly, and the bytes pass through the server. If the relay
      // cannot fetch, fall back to the 302 so the file still downloads
      // (with the CDN's name).
      const rExt = String(saveFmt.ext || 'mp4').toLowerCase();
      const rType = rExt === 'mp3' ? 'audio/mpeg' : rExt === 'm4a' ? 'audio/mp4' : rExt === 'webm' ? 'video/webm' : 'video/mp4';
      let relayed = false;
      try { relayed = await streamThrough(res, saveFmt.url, title, rExt, rType, false, relayUa(formatId)); } catch (e) { console.error('title relay failed:', scrub(e.message)); }
      if (relayed) return;
      // COLD-LINK FIX (2026-11-26): the cached URL for TikTok Best
      // (SSSTik, ~5 min life) and for YT-A qualities (yd-, which
      // YT-A can withdraw when it degrades to 360p-only) may be
      // expired/dead. A 302 to it hands the browser the CDN's own
      // filename (ssstik.io_....mp4) or YT-A's error JSON. Fall
      // through to the fresh-resolve branches below instead of
      // redirecting — they re-resolve and relay with the title.
      if (formatId === 'best' || formatId === 'ssstik-best' || formatId.startsWith('yd-')) { /* fall through to a fresh resolve */ }
      else if (!res.headersSent) return res.redirect(302, saveFmt.url);
      else return;
    }
  }
  // PREVIEW RELAY (single formats): stream the CACHED format URL
  // straight through with video headers — no re-resolve (the YT-A
  // resolve alone costs ~20s for a long video) and no 302. When the
  // cache has no such URL the normal branches below re-resolve it
  // (chain branch for yd-/ch- ids, direct stream / yt-dlp for the
  // rest) — with preview headers via sendHeaders.
  if (isPreview && !formatId.includes('+')) {
    const rawP = rawCacheGet(url);
    const pFmt = rawP && Array.isArray(rawP.formats)
      ? rawP.formats.find((f) => f && (String(f.format_id) === formatId || String(f.id) === formatId) && f.url)
      : null;
    if (pFmt) {
      const pExt = String(pFmt.ext || 'mp4').toLowerCase();
      const pType = pExt === 'mp3' ? 'audio/mpeg' : pExt === 'm4a' ? 'audio/mp4' : pExt === 'webm' ? 'video/webm' : 'video/mp4';
      try {
        if (await streamThrough(res, pFmt.url, title, pExt, pType, true)) return;
      } catch (e) {
        console.error('preview stream failed:', scrub(e.message));
      }
    }
  }
  // Series / SSSTik Best (ids 'best' and 'ssstik-best' — the live site
  // has served both across origins since the id was renamed): resolve
  // the direct link, then relay it through the server with the original
  // title filename instead of redirecting to tikcdn (which names it
  // ssstik.io_....mp4). tikcdn DOES answer a server fetch (proven
  // 2026-11-26: HTTP 200, full file, plain UA — the old "browsers only,
  // server gets 204" note was stale). Fall back to the 302 if the relay
  // cannot fetch, so the file still downloads.
  if (formatId === 'best' || formatId === 'ssstik-best') {
    const ssi = await ssstikInfo(url, 10000);
    const file = ssi && Array.isArray(ssi.formats) && ssi.formats[0] && ssi.formats[0].url;
    if (!file) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    try {
      if (await streamThrough(res, file, title, 'mp4', 'video/mp4', false)) return;
    } catch (e) { console.error('best relay failed:', scrub(e.message)); }
    if (!res.headersSent) return res.redirect(302, file);
    return;
  }
  if (!formatId || !/^[A-Za-z0-9+._-]{1,64}$/.test(formatId)) {
    return res.status(400).json({ error: 'Invalid quality choice.' });
  }

  // TikTok direct streams from tikwm (streamed through, never redirected).
  if (formatId.startsWith('tt-')) {
    const streamUrl = await tikwmStreamUrl(url, formatId);
    if (!streamUrl) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const ext = formatId === 'tt-audio' ? 'mp3' : 'mp4';
    try {
      const r = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } });
      if (!r.ok || !r.body) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      sendHeaders(ext, ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
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
  if (formatId.startsWith('yt-')) {
    let streamUrl = await mirrorStreamUrl(url, formatId);
    // PIPED PROXY DEAD (2026-11-26): a resolved Piped proxy URL 403s
    // for everyone (IP-bound googlevideo signature). Do not fetch it
    // and do not 302 to it — use the chain's YT-A file for the same
    // quality instead (same itag, working file). When the chain has
    // no such quality either, the clear 502 below stands.
    if (streamUrl && isPipedProxyUrl(streamUrl)) {
      const itag = formatId.slice(3);
      const chainId = formatId.endsWith('-audio') ? 'yd-audio' : ('yd-' + (YT_PROG_ITAG_HEIGHT[itag] || 360));
      try { streamUrl = await chainStreamUrl(url, chainId); } catch { streamUrl = null; }
    }
    if (!streamUrl) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const ext = formatId.endsWith('-audio') ? 'm4a' : 'mp4';
    try {
      const r = await fetch(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok || !r.body) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      sendHeaders(ext, ext === 'm4a' ? 'audio/mp4' : 'video/mp4');
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

  // Chain fallback streams (TikTok freeapi, Facebook xcasper /
  // SaveReelsFast / curl-x / freeapi, Instagram instapdown / curl-x /
  // freeapi): resolve the direct file URL and stream it through, never
  // redirected. NOTE: an Instagram photo via this path gets a .mp4
  // extension (the id carries no ext) — the browser direct path uses
  // the right .jpg; only the server fallback is affected.
  if (formatId.startsWith('fa-') || formatId.startsWith('xc-') || formatId.startsWith('sr-') || formatId.startsWith('cx-') || formatId.startsWith('ip-') || formatId.startsWith('yd-') || formatId.startsWith('ym-') || formatId.startsWith('ch-') || formatId.startsWith('cb-') || formatId.startsWith('kw-') || formatId.startsWith('bc-') || formatId === 'sc-mp3' || formatId.startsWith('vk-') || formatId.startsWith('ok-')) {
    const streamUrl = await chainStreamUrl(url, formatId);
    // COLD-LINK FIX (2026-11-26): a fresh resolve that no longer
    // contains this YT-A quality means YT-A withdrew it (it is
    // currently 360p-only) — say so plainly instead of redirecting
    // the visitor to YT-A's error JSON.
    if (!streamUrl) return res.status(502).json({ error: formatId.startsWith('yd-') ? 'That quality is not available for this video right now. Please try 360p instead.' : 'This clip is not available right now. Please try again.' });
    const ext = formatId === 'fa-audio' || formatId === 'sr-audio' || formatId === 'sc-mp3' ? 'mp3' : formatId === 'ch-audio' || formatId === 'yd-audio' ? 'm4a' : 'mp4';
    // VK / OK.ru (step 15h): full Chrome UA — the bare UA gets a 400.
    const saveUa = (formatId.startsWith('vk-') || formatId.startsWith('ok-'))
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      : 'Mozilla/5.0';
    try {
      const r = await fetch(streamUrl, { headers: { 'User-Agent': saveUa } });
      if (!r.ok || !r.body) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      sendHeaders(ext, ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'video/mp4');
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
        if (await streamThrough(res, fmt.url, title, ext2, ctype, isPreview)) return;
      } catch (e) {
        console.error('direct stream failed:', scrub(e.message));
      }
      // fall through to the yt-dlp save below
    }
  }

  // World-C HLS lanes (sc-/mc-/od-/pt-): the format URL is an HLS
  // manifest, not a file — a plain stream-through would hand the
  // visitor a playlist. Resolve fresh and let yt-dlp fetch + remux
  // the segments, streaming stdout like the single-format save below.
  // sc-mp3 never reaches here (the chain branch above returns first).
  if (formatId.startsWith('sc-') || formatId.startsWith('mc-') || formatId.startsWith('od-') || formatId.startsWith('pt-')) {
    const spec = await worldcSaveSpec(url, formatId);
    if (!spec) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const wargs = spec.mode === 'm3u8'
      ? ['--no-playlist', '--no-warnings', '--socket-timeout', '15', ...saveProxyArgs, '-o', '-', spec.m3u8Url]
      : ['-f', spec.ytdlpFormatId, '--no-playlist', '--no-warnings', '--socket-timeout', '15', ...(rawClientGet(url) || []), ...saveProxyArgs, '-o', '-', url];
    const child = spawn(YTDLP, wargs, { timeout: 900000 });
    let sent = false;
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' }); });
    child.stdout.on('data', (chunk) => {
      if (!sent) { sendHeaders(spec.ext, spec.ctype); sent = true; }
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
    return;
  }

  // Kick VOD remux (step 16): kc-* formats are HLS playlists,
  // not files — a plain stream-through would hand the visitor a
  // playlist. Re-resolve the variant fresh, remux HLS->mp4 with
  // ffmpeg -c copy to a temp file, stream it, then delete it.
  if (formatId.startsWith('kc-')) {
    const variant = await kickVariantUrl(url, formatId);
    if (!variant) return res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
    const dur = Number(variant.duration) || 0;
    const quality = formatId.slice(3);
    if (dur > KICK_REMUX_MAX_DURATION_S) return res.status(400).json({ error: 'This clip is too long to save this way. Please try a shorter clip.' });
    if (quality === '720p' && dur > 300) return res.status(400).json({ error: 'This clip is too long for this quality. Please pick 480p or lower.' });
    const tmpPath = path.join(os.tmpdir(), 'kick-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    try { fs.writeFileSync(tmpPath, Buffer.alloc(0), { mode: 0o600 }); } catch {}
    const ff = spawn(KICK_FFMPEG, ['-y', '-i', variant.url, '-c', 'copy', '-movflags', 'faststart', tmpPath], { timeout: KICK_REMUX_TIMEOUT_MS });
    let ffErr = '';
    ff.stderr.on('data', (d) => { if (ffErr.length < 2000) ffErr += d.toString(); });
    ff.on('error', () => { try { fs.unlinkSync(tmpPath); } catch {} if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' }); });
    ff.on('close', (code) => {
      if (code !== 0) { console.error('kick remux failed:', code, scrub(ffErr.slice(-500))); try { fs.unlinkSync(tmpPath); } catch {} if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' }); return; }
      sendHeaders('mp4', 'video/mp4');
      const stream = fs.createReadStream(tmpPath);
      stream.on('error', () => { try { fs.unlinkSync(tmpPath); } catch {} if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' }); });
      stream.on('end', () => { try { fs.unlinkSync(tmpPath); } catch {} });
      stream.pipe(res);
    });
    return;
  }

  const merged = formatId.includes('+');
  const ext = 'mp4';

  if (merged) {
    // 1-SECOND START (2026-11-25): stream the merge progressively when
    // both direct stream URLs are in the raw cache (the normal flow —
    // the visitor just got them from /api/info). The temp-file merge
    // below stays as the fallback for cold/direct save links.
    const [vidId, audId] = formatId.split('+');
    const rawM = rawCacheGet(url);
    const vFmt = rawM && Array.isArray(rawM.formats) ? rawM.formats.find((f) => f && String(f.format_id) === vidId && f.url) : null;
    const aFmt = rawM && Array.isArray(rawM.formats) ? rawM.formats.find((f) => f && String(f.format_id) === audId && f.url) : null;
    if (vFmt && aFmt) {
      const streamed = await tryStreamMerged(res, title, vFmt.url, aFmt.url, saveProxyArgs, isPreview);
      if (streamed) return;
    }
    // Merged video+audio cannot be streamed to stdout as MP4 (ffmpeg falls
    // back to an MPEG-TS stream on a pipe), so merge to a temp file, stream
    // the file, and delete it immediately — no buildup on disk.
    const tmp = path.join(os.tmpdir(), 'mediahub-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    // Merged-pair save with no recorded winning client: the Android
    // fallback (ytdlpExtraArgs) only offers format 18, so a merged pair
    // like 133+140 fails with "Requested format is not available" —
    // measured 2026-11-24. The advertised pairs come from the default /
    // tv clients, so fall back to the default web client (no extra
    // args) for merged pairs; plain ids keep the Android fallback.
    const args = ['-f', formatId, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
      '--socket-timeout', '15', ...(rawClientGet(url) || []), ...saveProxyArgs, '-o', tmp, url];
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
      sendHeaders(ext, 'video/mp4');
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
    '--socket-timeout', '15', ...(rawClientGet(url) || ytdlpExtraArgs(url)), ...saveProxyArgs, '-o', '-', url];
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
      sendHeaders(singleExt, singleType);
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
