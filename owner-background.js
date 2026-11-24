// Save Video Cookie Sync — PRIVATE, owner-only.
// Every 15 minutes this sends the OWNER's own logged-in cookies for
// YouTube / TikTok / Facebook / Instagram / Douyin / Reddit / Xigua /
// Weibo / Xiaohongshu / Zhihu / iQIYI to his Save Video servers, so
// downloads keep working without anyone touching the server. The extension
// runs only in the owner's browser: it never reads or sends any other
// person's cookies, and it talks to no site except the 15 Save Video
// origins below. This committed file carries NO secret: it holds the
// __SYNC_SECRET__ placeholder, and the server replaces it with the real
// shared secret (from COOKIE_SYNC_SECRET) when it builds the download,
// so no secret ever lands in the repo. The cookies are encrypted (AES-256-GCM, key from the
// shared secret, fresh IV per request) before they leave the browser, and
// are posted to the hidden sync path below — never in the clear.
// SITE-OPEN GATE: cookies leave this browser ONLY while the Save Video
// website is open in a tab (see siteOpen() / syncAll() below). The moment
// a site tab finishes loading, the extension syncs at once instead of
// waiting for the 15-minute alarm.
const SECRET = '__SYNC_SECRET__';
const ORIGINS = [
  'https://savevideoapp.onrender.com',
  'https://save-video-mo6m.onrender.com',
  'https://savevideo-eu.onrender.com',
  'https://savevideo-ohio.onrender.com',
  'https://savevideo-sg.onrender.com',
  'https://savevideo-va.onrender.com',
  'https://savevideo-eu2.onrender.com',
  'https://savevideo-ohio2.onrender.com',
  'https://savevideo-sg2.onrender.com',
  'https://savevideo-va2.onrender.com',
  'https://mediahub-shwe.onrender.com',
  'https://mediahub-eu.onrender.com',
  'https://mediahub-ohio.onrender.com',
  'https://mediahub-sg.onrender.com',
  'https://mediahub-va.onrender.com',
];
// Hidden sync path: the extension posts encrypted cookies here, not to the
// guessable /api/cookies path (which stays live on the server as an alias
// for old extension versions).
const SYNC_PATH = '/api/sync-7db99ff0fb3baef0756fa410';
// Login domains per platform. YouTube's login spans youtube.com AND
// google.com, so both are read for that platform.
const PLATFORMS = {
  youtube: ['.youtube.com', '.google.com'],
  tiktok: ['.tiktok.com'],
  facebook: ['.facebook.com'],
  instagram: ['.instagram.com'],
  douyin: ['.douyin.com', '.iesdouyin.com'],
  reddit: ['.reddit.com'],
  xigua: ['.ixigua.com', '.xigua.com'],
  weibo: ['.weibo.com', '.m.weibo.cn'],
  xiaohongshu: ['.xiaohongshu.com'],
  zhihu: ['.zhihu.com'],
  iqiyi: ['.iqiyi.com'],
};

// One Netscape cookies.txt line per cookie:
// domain, host-only flag, path, secure flag, expiry, name, value.
// host-only is TRUE when the domain has no leading dot, FALSE otherwise;
// session cookies (no expiry) get 0.
function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    // Netscape flag: TRUE when the domain starts with '.' (cookie is valid
    // for all subdomains). The old line had this INVERTED — '.youtube.com
    // FALSE' is rejected by yt-dlp's MozillaCookieJar ("invalid Netscape
    // format"), so synced cookies silently did nothing. Fixed 2026-11-24.
    const subdomainFlag = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([c.domain, subdomainFlag, c.path || '/', secure, String(expiry), c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// Second lock: encrypt the cookies text with AES-256-GCM before it leaves
// the browser. The key is SHA-256 of the same shared SECRET (no second
// secret to manage), cached for the service worker's lifetime; a fresh
// random 12-byte IV is used per request. WebCrypto's AES-GCM output is
// ciphertext with the 16-byte auth tag appended, which is what the server
// splits off and verifies. If encryption is unavailable the sync fails
// for that platform — plaintext is never sent.
let syncKeyPromise = null;
function getSyncKey() {
  if (!syncKeyPromise) {
    syncKeyPromise = (async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET));
      return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt']);
    })();
  }
  return syncKeyPromise;
}
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function encryptCookies(text) {
  const key = await getSyncKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { iv: b64(iv), data: b64(ct) };
}

async function syncPlatform(platform, domains) {
  let all = [];
  for (const d of domains) {
    try {
      const list = await chrome.cookies.getAll({ domain: d });
      all = all.concat(list);
    } catch (e) {
      // A single domain failing must not block the rest.
    }
  }
  const seen = new Set();
  all = all.filter((c) => {
    const k = c.domain + '|' + c.path + '|' + c.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!all.length) return { platform, count: 0, skipped: true, origins: {} };
  const text = toNetscape(all);
  let enc;
  try {
    enc = await encryptCookies(text);
  } catch (e) {
    // Encryption unavailable — fail closed, never send plaintext.
    return { platform, count: all.length, origins: Object.fromEntries(ORIGINS.map((o) => [o, 'error'])) };
  }
  const origins = {};
  await Promise.all(ORIGINS.map(async (origin) => {
    try {
      const r = await fetch(origin + SYNC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MediaHub-Secret': SECRET },
        body: JSON.stringify({ platform, iv: enc.iv, data: enc.data }),
      });
      origins[origin] = r.ok ? 'ok' : 'http' + r.status;
    } catch (e) {
      origins[origin] = 'error';
    }
  }));
  return { platform, count: all.length, origins };
}

// Site-open gate. A URL belongs to the site when its origin is one of the
// 15 ORIGINS above — no second list to drift out of sync.
const SITE_ORIGINS = new Set(ORIGINS);
function isSiteUrl(url) {
  try {
    return SITE_ORIGINS.has(new URL(url).origin);
  } catch (e) {
    return false;
  }
}
// True when any Save Video tab is open right now. Fails closed: if the
// tab query itself errors, the answer is "not open" and nothing syncs.
async function siteOpen() {
  try {
    const tabs = await chrome.tabs.query({ url: ORIGINS.map((o) => o + '/*') });
    return Array.isArray(tabs) && tabs.length > 0;
  } catch (e) {
    return false;
  }
}

async function syncAll(reason) {
  const now = new Date().toISOString();
  if (!(await siteOpen())) {
    // Gated: the website is not open — read no cookies, send nothing.
    // Record the gated state (not a sync) so the popup can show it.
    const gate = { gated: true, lastGateCheck: now };
    await chrome.storage.local.set({ gate });
    return { gated: true, reason: reason || 'alarm', lastGateCheck: now };
  }
  const out = { lastSync: now, reason: reason || 'alarm', platforms: {} };
  for (const [platform, domains] of Object.entries(PLATFORMS)) {
    try {
      out.platforms[platform] = await syncPlatform(platform, domains);
    } catch (e) {
      out.platforms[platform] = { platform, count: 0, error: String((e && e.message) || e) };
    }
  }
  await chrome.storage.local.set({ lastSync: out, gate: { gated: false, lastGateCheck: now } });
  return out;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mh-cookie-sync', { periodInMinutes: 15 });
  syncAll('installed');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('mh-cookie-sync', { periodInMinutes: 15 });
  syncAll('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mh-cookie-sync') syncAll('alarm');
});

// Sync the moment the website opens: when a Save Video tab finishes
// loading, sync at once instead of waiting for the 15-minute alarm. The
// gate in syncAll() passes by definition here. One page load can fire
// several 'complete' updates for the same tab+URL, so dedupe them (same
// tab+URL ignored within 60 seconds).
let lastSiteOpen = { key: '', at: 0 };
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || changeInfo.status !== 'complete') return;
  const url = (tab && tab.url) || '';
  if (!isSiteUrl(url)) return;
  const key = tabId + '|' + url;
  if (key === lastSiteOpen.key && Date.now() - lastSiteOpen.at < 60000) return;
  lastSiteOpen = { key, at: Date.now() };
  syncAll('site-opened');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'sync-now') {
    syncAll('manual').then(sendResponse);
    return true;
  }
});
