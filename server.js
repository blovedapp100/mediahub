// MediaHub server — paste a link, preview the clip, pick a quality, save it.
// No user data is stored. URLs are never written to logs.
// Info responses are cached in memory (10 min, keyed by a hash of the link).
const express = require('express');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

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

// Strip any URL out of a string before it is logged.
function scrub(s) { return String(s || '').replace(/https?:\/\/\S+/g, '[link]'); }

function safeTitle(t, fallback) {
  let s = String(t || fallback || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback || 'video';
}

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

async function tikwmInfo(url) {
  const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    if (j && j.code === 0 && j.data && j.data.play) {
      const d = j.data;
      const formats = [];
      if (d.hdplay) formats.push({ id: 'tikwm-hd', label: 'HD', ext: 'mp4', hasAudio: true, filesize: 0, note: 'Best quality' });
      formats.push({ id: 'tikwm-sd', label: 'SD', ext: 'mp4', hasAudio: true, filesize: 0, note: '' });
      if (d.music) formats.push({ id: 'tikwm-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only' });
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

// ---- yt-dlp ----------------------------------------------------------------

function ytdlpJson(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15', url],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('Could not read this link. The video may be private, removed, or the site is blocking us.'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Could not read this link.')); }
      });
  });
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

function buildFormats(info) {
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
        filesize: prog.filesize || prog.filesize_approx || 0,
        note: 'With sound',
      });
    } else if (vo && bestAudio) {
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
      filesize: f.filesize || f.filesize_approx || 0,
      note: 'With sound',
    });
  }
  if (bestAudio) {
    out.push({
      id: String(bestAudio.format_id),
      label: 'Audio only',
      ext: bestAudio.ext || 'm4a',
      hasAudio: true,
      filesize: bestAudio.filesize || bestAudio.filesize_approx || 0,
      note: 'Sound only',
    });
  }
  if (out.length === 0) {
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
      result = await tikwmInfo(url);
      // fall through to yt-dlp when tikwm has nothing
    }
    if (!result) {
      const info = await ytdlpJson(url);
      const formats = buildFormats(info);
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
      res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="' + title.replace(/"/g, '') + '.' + ext + '"');
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

  const merged = formatId.includes('+');
  const ext = 'mp4';

  if (merged) {
    // Merged video+audio cannot be streamed to stdout as MP4 (ffmpeg falls
    // back to an MPEG-TS stream on a pipe), so merge to a temp file, stream
    // the file, and delete it immediately — no buildup on disk.
    const tmp = path.join(os.tmpdir(), 'mediahub-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    const args = ['-f', formatId, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings',
      '--socket-timeout', '15', '-o', tmp, url];
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
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="' + title.replace(/"/g, '') + '.' + ext + '"');
      const stream = fs.createReadStream(tmp);
      stream.on('error', () => { fs.unlink(tmp, () => {}); try { res.end(); } catch {} });
      stream.on('end', () => fs.unlink(tmp, () => {}));
      stream.pipe(res);
    });
    return;
  }

  // Single format: stream stdout straight to the client, nothing on disk.
  const args = ['-f', formatId, '--no-playlist', '--no-warnings',
    '--socket-timeout', '15', '-o', '-', url];
  const child = spawn(YTDLP, args, { timeout: 900000 });
  let sent = false;
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });
  child.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
  });
  child.on('spawn', () => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + title.replace(/"/g, '') + '.' + ext + '"');
    sent = true;
    child.stdout.pipe(res);
  });
  child.on('close', (code) => {
    if (code !== 0) {
      console.error('save exited non-zero:', code, scrub(stderr.slice(-500)));
      if (!sent && !res.headersSent) res.status(502).json({ error: 'This clip is not available right now. Please try again.' });
      else if (sent) { try { res.end(); } catch {} }
    }
  });
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('MediaHub listening on port ' + PORT));
