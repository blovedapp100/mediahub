// Save Video frontend — no frameworks, no heavy libs.
(function () {
  'use strict';

  // ---- theme (dark / light) ------------------------------------------------
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('mh-theme'); } catch (e) {}
  if (saved === 'dark' || saved === 'light') {
    root.setAttribute('data-theme', saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    root.setAttribute('data-theme', 'dark');
  }
  var toggle = document.getElementById('themeToggle');
  function syncToggle() {
    if (!toggle) return;
    toggle.textContent = root.getAttribute('data-theme') === 'dark' ? '☀ Light' : '☾ Dark';
    toggle.setAttribute('aria-label', 'Switch colour theme');
  }
  if (toggle) {
    syncToggle();
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('mh-theme', next); } catch (e) {}
      syncToggle();
    });
  }


  // ---- extension install button (header, no popup) ----------------------
  // The companion extension marks the page (data-mh-ext="1") when it is
  // installed, so the button only ever shows when it is NOT installed.
  // It is a plain button on the site itself — never a popup.
  var extBtn = document.getElementById('extInstallBtn');
  var extSteps = document.getElementById('extSteps');
  var extStepsClose = document.getElementById('extStepsClose');
  function extInstalled() {
    return document.documentElement.getAttribute('data-mh-ext') === '1';
  }
  function syncExtBtn() {
    if (!extBtn) return;
    extBtn.style.display = extInstalled() ? 'none' : '';
  }
  if (extBtn) {
    syncExtBtn();
    setTimeout(syncExtBtn, 1200); // the marker may land just after this script
    extBtn.addEventListener('click', function () {
      // Download the extension file, then show the install steps inline.
      var a = document.createElement('a');
      a.href = '/SaveVideo-Extension-v1.8.zip';
      a.download = 'SaveVideo-Extension-v1.8.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (extSteps) {
        extSteps.hidden = false;
        extSteps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }
  if (extStepsClose && extSteps) {
    extStepsClose.addEventListener('click', function () { extSteps.hidden = true; });
  }


  // ---- elements ------------------------------------------------------------
  var form = document.getElementById('form');
  var urlInput = document.getElementById('url');
  var pasteBtn = document.getElementById('paste');
  var goBtn = document.getElementById('go');
  var msg = document.getElementById('msg');
  var detect = document.getElementById('detect');
  var progress = document.getElementById('progress');
  var result = document.getElementById('result');
  var playerWrap = document.getElementById('player');
  var videoEl = document.getElementById('previewVideo');
  var thumbImg = document.getElementById('thumb');
  var titleEl = document.getElementById('title');
  var uploaderEl = document.getElementById('uploader');
  var durationEl = document.getElementById('duration');
  var formatsEl = document.getElementById('formats');
  var noteEl = document.getElementById('platformNote');
  // ---- modern preview player (Plyr, bundled locally in vendor/plyr) ----
  // The preview plays through Plyr instead of the browser's bare
  // controls: modern UI, seek bar, speed, picture-in-picture,
  // fullscreen. One Plyr instance is created for the page and kept for
  // its life — a new preview is just a new src on the same element, so
  // a stale player can never sit under a new search. When Plyr cannot
  // load, the plain <video controls> stay in place.
  var previewPlyr = null;      // the one Plyr instance, or null
  var previewSized = false;    // true once the current video was measured
  var previewResizeTimer = null;

  // Size the player box from a ratio (video or thumbnail — the thumbnail
  // has the same ratio as the video and loads much faster, so the box is
  // right from the preview instead of jumping when the stream's metadata
  // finally arrives). The box is as wide as the layout allows and at most
  // ~70vh tall, so a vertical clip fills the phone's width instead of
  // sitting in a narrow strip; the video is always shown whole — never
  // cropped, never stretched — whatever its shape: 9:16, 16:9, 1:1, 4:5.
  // The video's own ratio ALWAYS wins: a cover thumbnail can be a
  // different crop from the video frame (TikTok cover 9:16, frame 3:4),
  // so sizing from the thumbnail alone letterboxes the video. The
  // thumbnail only sizes the box until the stream's metadata arrives;
  // once the video has sized the box, the thumbnail never overrides it.
  var previewVideoSized = false; // true once the stream's metadata sized the box
  function sizePreviewPlayerFromRatio(ratio, fromVideo) {
    if (!ratio || !playerWrap) return;
    if (!fromVideo && previewVideoSized) return; // the video's ratio already won
    var availW = playerWrap.parentElement ? playerWrap.parentElement.clientWidth : 0;
    var isPhone = window.innerWidth <= 600;
    var maxH = Math.round(window.innerHeight * 0.70);
    var w = Math.min(availW, maxH * ratio);
    if (!isPhone) w = Math.min(w, availW * 0.55); // keep room for the meta column
    if (w < 200) w = 200; // Plyr's own minimum width
    playerWrap.style.width = Math.round(w) + 'px';
    // aspect-ratio, not an explicit height: the height follows the width,
    // so the box keeps the right shape even if the layout width settles
    // later (a stale pixel height is what cropped the X preview).
    playerWrap.style.aspectRatio = String(ratio);
    if (fromVideo) previewVideoSized = true;
    previewSized = true;
  }

  function sizePreviewPlayer() {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return;
    sizePreviewPlayerFromRatio(videoEl.videoWidth / videoEl.videoHeight, true);
  }

  // Size from the thumbnail: it loads in under a second and carries the
  // video's own ratio, so the box is correct from the preview onward and
  // never jumps when the stream's metadata arrives (the metadata re-size
  // then lands on the same numbers). No-op until the thumbnail has a
  // natural size.
  function sizeFromThumb() {
    if (!thumbImg || !thumbImg.naturalWidth || !thumbImg.naturalHeight) return;
    sizePreviewPlayerFromRatio(thumbImg.naturalWidth / thumbImg.naturalHeight);
  }

  function setupPreviewPlayer() {
    if (previewPlyr || !videoEl || typeof Plyr === 'undefined') return;
    try {
      previewPlyr = new Plyr(videoEl, {
        controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
        settings: ['speed'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        ratio: null, // read the clip's own ratio from its metadata
        // Icons come from the bundled sprite, NOT Plyr's CDN: the
        // default iconUrl (cdn.plyr.io) fires a cross-origin XHR on
        // every init, which throws an uncaught error when that CDN is
        // unreachable — and the task forbids external CDN dependencies.
        iconUrl: '/vendor/plyr/plyr.svg',
        fullscreen: { enabled: true, fallback: true, iosNative: true },
        keyboard: { focused: true, global: false },
        tooltips: { controls: true, seek: true },
        seekTime: 10,
        hideControls: true,
        clickToPlay: true,
      });
    } catch (e) { previewPlyr = null; return; }
    videoEl.addEventListener('loadedmetadata', sizePreviewPlayer);
    if (videoEl.readyState >= 1) sizePreviewPlayer();
  }

  function pausePreviewPlayer() {
    if (previewPlyr) { try { previewPlyr.pause(); } catch (e) {} }
  }

  // A new preview must never inherit the old one's size or player box.
  function resetPreviewPlayer() {
    pausePreviewPlayer();
    previewSized = false;
    previewVideoSized = false;
    if (playerWrap) {
      playerWrap.style.width = '';
      playerWrap.style.height = '';
      playerWrap.style.aspectRatio = '';
      playerWrap.classList.remove('no-video');
    }
  }

  // Re-size when the window changes (rotate the phone, resize desktop).
  window.addEventListener('resize', function () {
    if (previewResizeTimer) clearTimeout(previewResizeTimer);
    previewResizeTimer = setTimeout(function () {
      if (previewSized) sizePreviewPlayer();
    }, 150);
  });

  if (!form || !urlInput) return;

  var PLATFORMS = [
    ['tiktok.com', 'TikTok'],
    ['douyin.com', 'Douyin'],
    ['v.douyin.com', 'Douyin'],
    ['iesdouyin.com', 'Douyin'],
    ['facebook.com', 'Facebook'],
    ['fb.watch', 'Facebook'],
    ['instagram.com', 'Instagram'],
    ['youtube.com', 'YouTube'],
    ['youtu.be', 'YouTube'],
    ['twitter.com', 'X (Twitter)'],
    ['x.com', 'X (Twitter)'],
    ['reddit.com', 'Reddit'],
    ['vimeo.com', 'Vimeo'],
    ['streamable.com', 'Streamable'],
    ['soundcloud.com', 'SoundCloud'],
    ['mixcloud.com', 'Mixcloud'],
    ['odysee.com', 'Odysee'],
    ['bitchute.com', 'BitChute'],
    ['framatube.org', 'PeerTube'],
    ['vk.com', 'VK'],
    ['vkvideo.ru', 'VK'],
    ['ok.ru', 'OK.ru'],
    ['kick.com', 'Kick'],
    ['dailymotion.com', 'Dailymotion'],
    ['dai.ly', 'Dailymotion'],
    ['bsky.app', 'Bluesky'],
    ['tumblr.com', 'Tumblr'],
    ['tmblr.co', 'Tumblr'],
    ['twitch.tv', 'Twitch'],
    ['clips.twitch.tv', 'Twitch'],
    ['pinterest.com', 'Pinterest'],
    ['pin.it', 'Pinterest'],
    ['linkedin.com', 'LinkedIn'],
    ['mojapp.in', 'Moj'],
    ['sharechat.com', 'ShareChat'],
    ['snapchat.com', 'Snapchat'],
    ['t.snapchat.com', 'Snapchat'],
    ['v.qq.com', 'Tencent Video'],
    ['kuaishou.com', 'Kuaishou'],
    ['v.kuaishou.com', 'Kuaishou'],
    ['kwai.com', 'Kwai'],
    ['haokan.baidu.com', 'Haokan'],
    ['pearvideo.com', 'Pear Video'],
    ['zhihu.com', 'Zhihu'],
    ['tv.sohu.com', 'Sohu'],
  ];

  var currentUrl = '';
  var currentTitle = '';
  var currentClientSide = false;

  function detectPlatform(url) {
    try {
      var host = new URL(url).hostname.toLowerCase();
      for (var i = 0; i < PLATFORMS.length; i++) {
        if (host === PLATFORMS[i][0] || host.endsWith('.' + PLATFORMS[i][0])) return PLATFORMS[i][1];
      }
    } catch (e) {}
    return null;
  }

  function showDetect() {
    var v = urlInput.value.trim();
    if (!v) { detect.className = 'detect'; detect.textContent = ''; return; }
    var name = detectPlatform(v);
    if (name) {
      detect.className = 'detect show';
      detect.textContent = '✓ ' + name + ' link detected';
      highlightChip(name);
    } else if (/^https?:\/\//i.test(v)) {
      detect.className = 'detect show bad';
      detect.textContent = 'That link is not from a supported site yet.';
      clearResult();
    } else {
      detect.className = 'detect';
      detect.textContent = '';
    }
  }

  // Clear the previous result card entirely (title, formats, preview
  // video) so a stale video never sits under a new error message.
  function clearResult() {
    resetPreviewPlayer();
    result.hidden = true;
    titleEl.textContent = '';
    uploaderEl.textContent = '';
    durationEl.textContent = '';
    formatsEl.innerHTML = '';
    if (noteEl) noteEl.hidden = true;
    if (videoEl) {
      try { videoEl.pause(); } catch (e) {}
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
    }
    if (thumbImg) thumbImg.style.display = 'none';
    if (playerWrap) playerWrap.style.display = 'none';
  }

  function highlightChip(name) {
    var chips = document.querySelectorAll('.chip');
    chips.forEach(function (c) {
      c.classList.toggle('active', c.textContent.trim() === name);
    });
  }

  function fmtDuration(s) {
    s = Math.round(Number(s) || 0);
    if (!s) return '';
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }

  function fmtSize(n) {
    if (!n || n <= 0) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
  }

  function safeFileName(name, ext) {
    var s = String(name || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
    return s + '.' + (ext || 'mp4');
  }

  // Save a file straight to this device: fetch it and save the blob with
  // a proper name. Returns false when the direct fetch fails, so the
  // caller can fall back to the server save.
  async function downloadDirect(url, filename, onProgress) {
    try {
      // No Referer: some file hosts refuse a request that carries
      // another site's Referer, even though the file itself is public.
      // Sending no Referer makes the same URL answer.
      var r = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!r.ok || !r.body) return false;
      // Stream it (instead of one r.blob()) so the button can show real
      // MB/s + % while it downloads. Content-Length is a CORS-safelisted
      // header, so the total is readable cross-origin; without it the
      // progress shows MB downloaded + speed only.
      var total = 0;
      try { total = parseInt(r.headers.get('content-length') || '0', 10) || 0; } catch (e) {}
      var ctype = '';
      try { ctype = r.headers.get('content-type') || ''; } catch (e) {}
      var reader = r.body.getReader();
      var parts = [];
      var got = 0;
      var started = Date.now(), lastReport = 0;
      for (;;) {
        var read = await reader.read();
        if (read.done) break;
        if (read.value) {
          parts.push(read.value);
          got += read.value.byteLength;
          var now = Date.now();
          if (onProgress && now - lastReport >= 200) {
            lastReport = now;
            onProgress(got, total, (got * 1000) / Math.max(1, now - started));
          }
        }
      }
      if (!got) return false;
      if (total && got !== total) return false; // short read: never save a broken file
      var blob = new Blob(parts, ctype ? { type: ctype } : undefined);
      if (!blob || !blob.size) return false;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- fast download (start) -------------------------------------------
  // Maximum-speed download for direct CDN links: split the file into
  // parallel Range requests (4–6 connections), show real MB/s + % while
  // it downloads, then save one Blob. Bytes still go CDN → this browser
  // only, never through our server — the server stream (/api/save) is
  // untouched. Every step is probe-gated: if the CDN does not allow
  // cross-origin ranged reads, or anything at all fails, the caller
  // falls back to the old flow (single fetch, then open-in-tab / server
  // save) — a failed fast path never breaks a working download.
  // Measured 2026-11-24: X and Facebook allow cross-origin Range
  // (206 + preflight allows the Range header); the Series CDN answers
  // Range only to its own site, so Series always takes the fallback.
  // Speed rule (measured, not guessed): on the test network a single
  // connection was FASTER than parallel for 5–15 MB files (X 3.8s vs
  // 10.5s, FB 3.5s vs 6.9s — the shared egress proxy is the bottleneck,
  // so extra connections only add contention), while on a server that
  // throttles each connection to 400 KB/s parallel was 6.2x faster
  // (73s → 12s for 24 MB). So parallel engages only at 20 MB and up —
  // where per-connection throttling dominates and the probe overhead is
  // negligible — and smaller files take the single fetch, which also
  // shows live speed now (see downloadDirect). One constant below
  // (FAST_MIN_PARALLEL_BYTES) moves that line.
  var FAST_MAX_BYTES = 500 * 1024 * 1024;       // parallel only up to 500 MB
  var FAST_MAX_BYTES_LOWMEM = 100 * 1024 * 1024; // low-memory phones: 100 MB
  var FAST_PROBE_TIMEOUT_MS = 5000;
  var FAST_MIN_PARALLEL_BYTES = 20 * 1024 * 1024; // parallel only at 20 MB and up (measured rule above)

  function fastMaxBytes() {
    try {
      if (navigator.deviceMemory && navigator.deviceMemory <= 2) return FAST_MAX_BYTES_LOWMEM;
    } catch (e) {}
    return FAST_MAX_BYTES;
  }

  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return '';
    var mb = bps / (1024 * 1024);
    return (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB/s';
  }

  function mimeForExt(ext) {
    ext = String(ext || 'mp4').toLowerCase();
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a') return 'audio/mp4';
    if (ext === 'webm') return 'video/webm';
    return 'video/mp4';
  }

  // Button text during a download: "45% · 12.4 MB/s" when the total is
  // known, "3.2 MB · 1.8 MB/s" when it is not.
  function progressText(done, total, bps) {
    if (total > 0) return Math.round((done / total) * 100) + '% · ' + fmtSpeed(bps);
    var mb = done / (1024 * 1024);
    return (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB · ' + fmtSpeed(bps);
  }

  // Probe one URL: HEAD (total via Content-Length — a CORS-safelisted
  // header) + ranged GET bytes=0-0 (206 proves Range works). Content-
  // Range is NOT exposed by these CDNs, so the total must come from
  // HEAD. Resolves { url, total, ttfbMs } or null on ANY failure
  // (CORS block, no 206, no length, timeout, HEAD refused).
  function probeFastUrl(url) {
    var start = Date.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FAST_PROBE_TIMEOUT_MS);
    try {
      var headP = fetch(url, { method: 'HEAD', referrerPolicy: 'no-referrer', signal: ctrl.signal })
        .then(function (r) {
          var n = r.headers.get('content-length');
          return n ? parseInt(n, 10) || 0 : 0;
        })
        .catch(function () { return 0; });
      var rangeP = fetch(url, { headers: { Range: 'bytes=0-0' }, referrerPolicy: 'no-referrer', signal: ctrl.signal })
        .then(function (r) { return r.status === 206; })
        .catch(function () { return false; });
      return Promise.all([headP, rangeP]).then(function (both) {
        clearTimeout(timer);
        var total = both[0], ranged = both[1];
        if (!ranged || !total || total <= 0) return null;
        return { url: url, total: total, ttfbMs: Date.now() - start };
      }).catch(function () { clearTimeout(timer); return null; });
    } catch (e) {
      clearTimeout(timer);
      return Promise.resolve(null);
    }
  }

  // First success wins: race the probes and return the fastest URL that
  // allows ranged reads. Resolves null only when every candidate fails.
  function raceFastUrls(urls) {
    return new Promise(function (resolve) {
      var pending = urls.length, failed = 0;
      if (!pending) { resolve(null); return; }
      urls.forEach(function (u) {
        probeFastUrl(u).then(function (v) {
          if (v) resolve(v);
          else { failed++; if (failed === pending) resolve(null); }
        });
      });
    });
  }

  function chunkCountFor(total) {
    return total < 8 * 1024 * 1024 ? 4 : 6;
  }

  // Fetch one byte-range with a streaming reader so progress + speed
  // update while it downloads. Resolves an ArrayBuffer; throws on any
  // failure (non-206, short read, network error, abort) so the caller
  // falls back instead of saving a broken file.
  async function fetchChunk(url, start, end, signal, onBytes) {
    var r = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end }, referrerPolicy: 'no-referrer', signal: signal });
    if (r.status !== 206 || !r.body) throw new Error('chunk failed');
    var reader = r.body.getReader();
    var parts = [];
    var got = 0;
    for (;;) {
      var read = await reader.read();
      if (read.done) break;
      if (read.value) { parts.push(read.value); got += read.value.byteLength; if (onBytes) onBytes(read.value.byteLength); }
    }
    if (got !== end - start + 1) throw new Error('chunk short');
    var buf = new Uint8Array(got);
    var off = 0;
    parts.forEach(function (p) { buf.set(p, off); off += p.byteLength; });
    return buf.buffer;
  }

  // Parallel chunked download. onProgress(done, total, bytesPerSec) is
  // called as bytes arrive (throttled to ~5/sec). Resolves the assembled
  // Blob, or throws on ANY failure — the caller must fall back, never
  // show an error for a fast-path failure. A shared AbortController
  // stops the other chunks the moment one fails.
  async function downloadParallel(url, total, mime, onProgress) {
    var n = chunkCountFor(total);
    var size = Math.ceil(total / n);
    var ctrl = new AbortController();
    var started = Date.now();
    var done = 0, lastReport = 0;
    function report() {
      var now = Date.now();
      if (now - lastReport < 200 && done < total) return;
      lastReport = now;
      if (onProgress) onProgress(done, total, (done * 1000) / Math.max(1, now - started));
    }
    var jobs = [];
    for (var i = 0; i < n; i++) {
      (function (i) {
        var start = i * size, end = Math.min(total - 1, (i + 1) * size - 1);
        jobs.push(fetchChunk(url, start, end, ctrl.signal, function (b) { done += b; report(); }));
      })(i);
    }
    var bufs;
    try {
      bufs = await Promise.all(jobs);
    } catch (e) {
      try { ctrl.abort(); } catch (e2) {}
      throw e;
    }
    report();
    return new Blob(bufs, { type: mime });
  }

  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
  }

  // Fast path for a direct format: race the candidate URLs (same quality
  // from another source, if any — a format's own `urls` array, or a
  // sibling format with the same label + extension), probe for ranged
  // reads, then download in parallel with live speed. Resolves 'saved'
  // on success, 'toobig' when the file is over the parallel cap (the
  // caller must NOT fetch it whole — open-in-tab / server save instead),
  // or null when the fast path is unavailable or failed (caller runs the
  // old flow unchanged). Never throws, never shows an error itself.
  async function tryFastDownload(format, formats, filename, btn) {
    try {
      var urls = [];
      if (format.url) urls.push(format.url);
      if (Array.isArray(format.urls)) format.urls.forEach(function (u) { if (u && urls.indexOf(u) === -1) urls.push(u); });
      (formats || []).forEach(function (g) {
        if (g !== format && g.url && g.label === format.label && g.ext === format.ext && urls.indexOf(g.url) === -1) urls.push(g.url);
      });
      if (!urls.length) return null;
      var best = await raceFastUrls(urls);
      if (!best) return null;
      if (best.total > fastMaxBytes()) return 'toobig';
      if (best.total < FAST_MIN_PARALLEL_BYTES) return null; // small file: one fetch is faster (measured)
      var blob = await downloadParallel(best.url, best.total, mimeForExt(format.ext), function (done, total, bps) {
        if (btn) btn.textContent = progressText(done, total, bps);
      });
      if (!blob || !blob.size) return null;
      saveBlob(blob, filename);
      return 'saved';
    } catch (e) {
      return null;
    }
  }
  // ---- fast download (end) ---------------------------------------------

  function setBusy(busy) {
    goBtn.disabled = busy;
    goBtn.textContent = busy ? 'Loading…' : 'Get video';
    progress.classList.toggle('show', busy);
  }

  var latestReq = 0;

  // ---- multi-region fallback ---------------------------------------------
  // The site runs on 15 free Render services (1 main + 14 backups). If
  // this region's API cannot read a link (YouTube/TikTok block some
  // datacenter IPs), the same request is tried against a backup region,
  // and the download then comes from there. currentInfoOrigin remembers
  // which region answered the quality list, so the Save button downloads
  // from that same region. Only a few backups are ever tried (see the
  // caps below): every backup tried is a sleeping free service that wakes
  // up and burns shared instance hours.
  var origins = null; // [own origin, backup origin] — filled lazily
  var originsPromise = null;
  var currentInfoOrigin = '';
  function getOrigins() {
    if (origins) return Promise.resolve(origins);
    if (!originsPromise) {
      originsPromise = fetch('/api/config')
        .then(function (r) { return r.json(); })
        .then(function (cfg) {
          origins = [location.origin];
          var list = (cfg && cfg.backupOrigins) || (cfg && cfg.backupOrigin ? [cfg.backupOrigin] : []);
          list.forEach(function (o) {
            if (o && o !== location.origin && origins.indexOf(o) === -1) origins.push(o);
          });
          return origins;
        })
        .catch(function () { origins = [location.origin]; return origins; });
    }
    return originsPromise;
  }
  // Region of an origin, from its subdomain: -eu is Frankfurt (EU),
  // -sg is Singapore (Asia), everything else is the US (Oregon/Ohio/
  // Virginia, including the main link and the -mo6m backup). Used only
  // to spread retries across regions — a geo-block is decided by the
  // region, so trying three US origins in a row would never help.
  function regionOf(origin) {
    var o = String(origin || '');
    if (/-eu\d*\./.test(o)) return 'EU';
    if (/-sg\d*\./.test(o)) return 'ASIA';
    return 'US';
  }
  // Reorder origins so the first three cover one region each (US, EU,
  // Asia), keeping the original order inside each region. A plain
  // retry list can be three US origins in a row — useless for a
  // geo-block, and it burns the 3-origin cap before Asia is tried.
  function orderOriginsByRegion(list) {
    var first = {};
    var rest = [];
    list.forEach(function (o) {
      var r = regionOf(o);
      if (!first[r]) first[r] = o;
      else rest.push(o);
    });
    var out = [];
    ['US', 'EU', 'ASIA'].forEach(function (r) { if (first[r]) out.push(first[r]); });
    return out.concat(rest);
  }
  // Try each origin in order until one answers with ok JSON.
  // Returns { data, origin }. Throws the last error when all fail.
  // 4xx answers are terminal: they are decided by the LINK (not the
  // region), so another region would answer the same way — trying it
  // only burns seconds and wakes a sleeping backup service for nothing.
  // 5xx / timeouts / network errors fall through to the next origin.
  // maxOrigins caps how many origins are tried: /api/meta is capped at
  // 2 and /api/info at 3, so a row of sleeping backup regions cannot
  // stretch the wait to minutes — each origin already burns its full
  // per-origin timeout while a free Render service wakes (~50s).
  async function tryOrigins(path, options, timeoutMs, maxOrigins, opts) {
    var list = await getOrigins();
    if (opts && opts.regionDiverse) list = orderOriginsByRegion(list);
    if (maxOrigins) list = list.slice(0, maxOrigins);
    var lastErr = null;
    var geoFails = 0;
    var answered = 0;
    for (var i = 0; i < list.length; i++) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      try {
        var r = await fetch(list[i] + path, Object.assign({}, options, { signal: ctrl.signal }));
        var data = await r.json().catch(function () { return null; });
        if (!data) { lastErr = new Error('Something went wrong.'); continue; }
        if (!r.ok) {
          answered++;
          if (data.geoBlocked) geoFails++;
          lastErr = new Error(data.error || 'Something went wrong.');
          // Carry the flags the caller needs to decide what to do next:
          // a geo-block is final, and a no-stream video has no file to
          // wait for — neither should start a background job.
          if (data.geoBlocked) lastErr.geoBlocked = true;
          if (data.noStream) lastErr.noStream = true;
          if (r.status >= 400 && r.status < 500) lastErr._terminal = true;
          if (lastErr._terminal) throw lastErr;
          continue;
        }
        return { data: data, origin: list[i] };
      } catch (e) {
        if (e && e._terminal) throw e;
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    // Geo-block: every origin that answered said the video is blocked
    // in its region — carry the flag so the caller can say so plainly
    // instead of a generic "try again". (A 502 is retried, never
    // terminal, so a single geo failure alone never sets this.)
    if (answered && geoFails === answered && lastErr) lastErr.geoBlocked = true;
    throw lastErr || new Error('Something went wrong.');
  }

  // Typical seconds each platform takes to show the video (measured live,
  // warm server). meta = title/thumbnail, info = full quality list,
  // max = give up after this.
  var PLATFORM_TIME = {
    'YouTube': { meta: 1, info: 8, max: 30 },
    'TikTok': { meta: 1, info: 6, max: 30 },
    'Douyin': { meta: 2, info: 10, max: 30 },
    'Facebook': { meta: 2, info: 12, max: 35 },
    'Instagram': { meta: 2, info: 8, max: 30 },
    'X (Twitter)': { meta: 1, info: 10, max: 30 },
    'Reddit': { meta: 1, info: 10, max: 30 },
    'Vimeo': { meta: 1, info: 12, max: 30 },
    'Streamable': { meta: 1, info: 8, max: 30 },
    'Kwai': { meta: 1, info: 8, max: 30 },
    'SoundCloud': { meta: 1, info: 15, max: 30 },
    'Mixcloud': { meta: 1, info: 12, max: 30 },
    'Odysee': { meta: 1, info: 10, max: 30 },
    'BitChute': { meta: 1, info: 8, max: 30 },
    'PeerTube': { meta: 1, info: 10, max: 30 },
    'VK': { meta: 1, info: 13, max: 30 },
    'OK.ru': { meta: 1, info: 10, max: 30 },
    'Kick': { meta: 1, info: 8, max: 30 },
    'Dailymotion': { meta: 2, info: 8, max: 30 },
    'Bluesky': { meta: 2, info: 8, max: 30 },
    'Tumblr': { meta: 1, info: 8, max: 30 },
    'Twitch': { meta: 2, info: 12, max: 35 },
    'Pinterest': { meta: 2, info: 10, max: 30 },
    'LinkedIn': { meta: 2, info: 10, max: 30 },
    'Moj': { meta: 2, info: 8, max: 30 },
    'ShareChat': { meta: 2, info: 8, max: 30 },
    'Snapchat': { meta: 2, info: 8, max: 30 },
    'Tencent Video': { meta: 2, info: 10, max: 30 },
  };
  var timerEl = document.getElementById('timer');
  var timerInt = null;
  var timerStart = 0;

  function fmtSecs(s) { return s.toFixed(1) + 's'; }

  function stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
  }

  function startTimer(platform) {
    stopTimer();
    var t = PLATFORM_TIME[platform] || { meta: 3, info: 8, max: 30 };
    timerStart = Date.now();
    if (!timerEl) return t;
    timerEl.innerHTML = '<b>' + platform + '</b> — video usually shows in ~' + t.meta + 's… <b class="elapsed">0.0s</b>';
    timerInt = setInterval(function () {
      var el = timerEl.querySelector('.elapsed');
      if (el) el.textContent = fmtSecs((Date.now() - timerStart) / 1000);
    }, 100);
    return t;
  }

  function timerShown(seconds) {
    if (!timerEl) return;
    timerEl.innerHTML = 'Video shown in <b>' + fmtSecs(seconds) + '</b> — getting qualities…';
  }

  function timerDone(seconds) {
    stopTimer();
    if (!timerEl) return;
    timerEl.innerHTML = 'Ready in <b>' + fmtSecs(seconds) + '</b>';
  }

  function renderPreview(data) {
    resetPreviewPlayer();
    currentTitle = data.title || 'video';
    titleEl.textContent = currentTitle;
    uploaderEl.textContent = data.uploader ? 'By ' + data.uploader : '';
    durationEl.textContent = data.duration ? 'Length: ' + fmtDuration(data.duration) : '';
    if (videoEl) {
      try { videoEl.pause(); } catch (e) {}
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
    }
    if (data.thumbnail) {
      thumbImg.src = data.thumbnail; thumbImg.style.display = '';
      // Size the box from the thumbnail NOW (same ratio as the video):
      // it loads in under a second, so the box never jumps when the
      // stream's metadata arrives later. Setting src makes complete
      // false until the new image loads, so the immediate call only
      // fires when this thumbnail was already loaded.
      if (thumbImg.complete && thumbImg.naturalWidth) sizeFromThumb();
      thumbImg.addEventListener('load', sizeFromThumb, { once: true });
    }
    else thumbImg.style.display = 'none';
    if (playerWrap) playerWrap.style.display = data.thumbnail ? '' : 'none';
    formatsEl.innerHTML = '<li class="loading">Finding qualities…</li>';
    result.hidden = false;
  }

  async function fetchInfo(url) {
    currentUrl = url;
    var reqId = ++latestReq;
    var renderedForReq = false; // anything at all shown (preview or full result)
    var resultRendered = false; // the FULL result (qualities) shown — a meta
    // preview must not block the full result from rendering its
    // qualities: renderPreview only shows title/thumbnail + "Finding
    // qualities…", so discarding the full answer after a preview left
    // the user stuck on "Could not load qualities" even though the
    // full quality list had already arrived.
    var platform = detectPlatform(url) || 'Video';
    var metaDuration = 0; // seconds, from Stage 1 — decides "long video"
    var timing = startTimer(platform);
    setBusy(true);
    msg.textContent = '';
    result.hidden = true;
    formatsEl.innerHTML = '';
    // Stage 1 — fast preview (title + thumbnail) in about a second.
    // At most 2 origins (own + 1 backup): a 404 means "no preview for
    // this link" on every region, so trying more only burns time.
    tryOrigins('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    }, 5000, 2)
      .then(function (res) {
        var data = res && res.data;
        if (reqId !== latestReq || !data || !data.title) return;
        renderedForReq = true;
        metaDuration = data.duration || 0;
        if (data.formats && data.formats.length) {
          // The preview already carries this link's qualities (X: the
          // tweet page embeds the direct files, so /api/meta attaches
          // them). Render the full result NOW — Stage 2 below is only
          // a fallback and will re-render the same list if it lands.
          // This is what makes X robust when Stage 2 stalls in a real
          // browser: the qualities are on screen with the preview
          // (~1s) instead of depending on Stage 2's timers at all.
          currentInfoOrigin = res.origin;
          resultRendered = true;
          renderResult(data);
          timerDone((Date.now() - timerStart) / 1000);
        } else {
          renderPreview(data);
          timerShown((Date.now() - timerStart) / 1000);
        }
      })
      .catch(function () {});
    // Cold start: if nothing has rendered after 4s the service is
    // probably waking up (free tier sleeps after 15 min idle) — say so
    // instead of leaving the "usually shows in ~2s" estimate on screen.
    setTimeout(function () {
      if (reqId === latestReq && !renderedForReq && timerEl) {
        timerEl.innerHTML = 'Waking up the server… first load can take a few seconds, please wait.';
      }
    }, 4000);
    // Stage 2 — full quality list (takes a few seconds longer).
    // Tries the backup region too when this region cannot read the link.
    // Bounded: at most 3 origins at 10s each, and a 45s global budget
    // for the whole stage — after that the error below is shown instead
    // of "Finding qualities…" hanging forever. (/api/meta above is
    // capped at 2 origins, 5s each: it is only the fast preview.)
    // Note: timing.max is no longer used for /api/info; the table keeps
    // its measured per-platform figures for the on-screen estimate.
    // ---- Background jobs (slow videos) ---------------------------------
    // Some videos can never finish inside /api/info's 25s cap: long
    // YouTube videos, Douyin/Kuaishou, Moj/ShareChat, Zhihu. For those
    // the server runs the same lookup in the background (POST /api/job)
    // and this code polls it. The fast path above is untouched: a video
    // that answers in time never starts a job. A job starts only when
    // the sync lookup is about to time out (12s for known-slow links,
    // 25s otherwise) or when it already timed out below.
    var jobStarted = false; // a job is running for this request
    var jobStopped = false; // Stage 2 won, or a newer request started
    var jobId = null;
    var jobOrigin = '';
    var jobPollTimer = null;
    function isSlowJobLink() {
      if (platform === 'Douyin' || platform === 'Kuaishou' ||
          platform === 'Moj' || platform === 'ShareChat' || platform === 'Zhihu') return true;
      if (platform === 'YouTube' && metaDuration >= 240) return true;
      return false;
    }
    function jobStop() {
      jobStopped = true;
      if (jobPollTimer) { clearTimeout(jobPollTimer); jobPollTimer = null; }
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
      // Free the server-side per-IP slot: the lookup keeps running, but
      // its result is discarded once the job record is gone.
      if (jobId && jobOrigin) {
        fetch(jobOrigin + '/api/job/' + jobId, { method: 'DELETE' }).catch(function () {});
        jobId = null;
      }
    }
    function jobShowProgress(pct, step) {
      if (reqId !== latestReq || jobStopped || resultRendered) return;
      if (timerEl) timerEl.innerHTML = 'Working in the background… <b class="elapsed">' + ((Date.now() - timerStart) / 1000).toFixed(1) + 's</b>';
      formatsEl.innerHTML = '<li class="loading job">' +
        '<span class="job-text">' + step + ' ' + pct + '%</span>' +
        '<span class="job-progress"><span class="job-bar" style="width:' + pct + '%"></span></span>' +
        '<span class="job-note">This one is slow — it keeps working in the background.</span></li>';
    }
    function jobShowError(text) {
      if (reqId !== latestReq || jobStopped) return;
      stopTimer();
      if (!renderedForReq) { clearResult(); msg.textContent = text; }
      else if (!resultRendered) formatsEl.innerHTML = '<li class="loading">' + text + '</li>';
      if (reqId === latestReq) setBusy(false);
    }
    async function startJobFlow() {
      if (jobStarted || reqId !== latestReq || resultRendered) return;
      jobStarted = true;
      var origins;
      try { origins = await getOrigins(); } catch (e) { origins = [location.origin]; }
      origins = orderOriginsByRegion(origins.slice());
      var started = null;
      for (var i = 0; i < Math.min(3, origins.length); i++) {
        try {
          var r = await fetch(origins[i] + '/api/job', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url }),
          });
          var d = await r.json().catch(function () { return null; });
          if (r.ok && d && d.jobId) { started = { origin: origins[i], jobId: d.jobId }; break; }
          if (r.status === 429 || r.status === 400) break; // decided: do not burn other origins
        } catch (e) { /* next origin */ }
        if (reqId !== latestReq || jobStopped) return;
      }
      if (!started) { jobShowError(platform + ' is taking too long right now. Please try again.'); return; }
      jobOrigin = started.origin;
      jobId = started.jobId;
      var jobStart = Date.now();
      var poll = async function () {
        if (reqId !== latestReq || jobStopped) return;
        if (Date.now() - jobStart > 320000) { jobShowError(platform + ' is taking too long right now. Please try again.'); return; }
        var pr, pd;
        try {
          pr = await fetch(jobOrigin + '/api/job/' + jobId);
          pd = await pr.json().catch(function () { return null; });
        } catch (e) { pd = null; }
        if (reqId !== latestReq || jobStopped) return;
        if (!pd) { jobPollTimer = setTimeout(poll, 3000); return; }
        if (pd.status === 'ready' && pd.formats && pd.formats.length) {
          currentInfoOrigin = jobOrigin;
          renderedForReq = true;
          resultRendered = true;
          jobStopped = true;
          renderResult(pd);
          timerDone((Date.now() - timerStart) / 1000);
          if (reqId === latestReq) setBusy(false);
          return;
        }
        if (pd.status === 'failed') {
          if (pd.geoBlocked) { jobShowError('This video is blocked in every region we can reach (US, Europe and Asia). It is only available in the country where the uploader allowed it.'); return; }
          jobShowError(pd.error || 'Could not load qualities — please try again.');
          return;
        }
        if (pr.status === 404) { jobShowError(platform + ' is taking too long right now. Please try again.'); return; }
        jobShowProgress(pd.progress || 0, pd.step || 'Getting it ready…');
        jobPollTimer = setTimeout(poll, 3000);
      };
      jobShowProgress(0, 'Getting it ready…');
      poll();
    }
    // The delay is decided when the timer FIRES, not when it is set:
    // Stage 1's meta (which carries the duration) usually lands in ~1s,
    // but the timer is created before that — deciding at creation time
    // would see duration 0 and always take the 25s branch for YouTube.
    // At 12s, start the job if the link is known-slow by then; otherwise
    // wait out the remaining time to 25s and start it then.
    function jobTimerDue() {
      if (reqId !== latestReq || resultRendered) return;
      var elapsed = Date.now() - timerStart;
      if (isSlowJobLink() || elapsed >= 25000) { startJobFlow(); return; }
      jobTimer = setTimeout(jobTimerDue, 25000 - elapsed);
    }
    var jobTimer = setTimeout(jobTimerDue, 12000);
    try {
      var infoBudget = new Promise(function (resolve, reject) {
        setTimeout(function () {
          var err = new Error(platform + ' is taking too long right now. Please try again.');
          err.name = 'AbortError';
          reject(err);
        }, 45000);
      });
      var res = await Promise.race([
        tryOrigins('/api/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url }),
        }, 10000, 3, { regionDiverse: true }),
        infoBudget,
      ]);
      jobStop(); // Stage 2 won: stop any job polling and free its slot
      if (reqId !== latestReq) return;
      currentInfoOrigin = res.origin;
      renderedForReq = true;
      resultRendered = true;
      renderResult(res.data);
      timerDone((Date.now() - timerStart) / 1000);
    } catch (err) {
      if (reqId !== latestReq) return;
      clearTimeout(jobTimer);
      if (jobStarted) return; // the job flow owns the UI now
      stopTimer();
      // Nothing rendered for this request: clear the old card so no
      // stale video sits under the error. When the preview did render,
      // keep it and show the failure inside the quality list instead.
      // Geo-block on every region tried: the video is public, but the
      // uploader restricted it to countries none of our regions is in.
      // Say so plainly — retrying the same link will not help.
      // A full result already on screen (rendered by the preview when
      // it carried the qualities, or by the TikTok browser path) must
      // NEVER be overwritten by a later Stage 2 failure: without this
      // guard the qualities render at ~1s and Stage 2's error then
      // erases them at ~30s, leaving the exact "Finding qualities…"
      // hang's twin — a flicker followed by an error. resultRendered
      // covers the TikTok case too (that path sets both flags).
      if (err && err.geoBlocked) {
        var geoMsg = 'This video is blocked in every region we can reach (US, Europe and Asia). It is only available in the country where the uploader allowed it.';
        if (!renderedForReq) { clearResult(); msg.textContent = geoMsg; }
        else if (!resultRendered) formatsEl.innerHTML = '<li class="loading">' + geoMsg + '</li>';
      } else if (err && !err._terminal && !err.noStream &&
                 (err.name === 'AbortError' || /taking too long/i.test(err.message || ''))) {
        // Slow, not decided: hand over to the background job instead of
        // showing the timeout. (Geo-block, no-stream and terminal 4xx
        // never reach here — they are final.)
        startJobFlow();
      } else if (err && err.name === 'AbortError') {
        if (!renderedForReq) { clearResult(); msg.textContent = platform + ' is taking too long right now. Please try again.'; }
        else if (!resultRendered) formatsEl.innerHTML = '<li class="loading">Taking too long — please try again.</li>';
      } else if (!renderedForReq) {
        clearResult();
        msg.textContent = err.message || 'Something went wrong. Please try another link.';
      } else if (!resultRendered) {
        formatsEl.innerHTML = '<li class="loading">Could not load qualities — please try again.</li>';
      }
    } finally {
      if (reqId === latestReq) setBusy(false);
    }
  }

  function renderResult(data) {
    currentTitle = data.title || 'video';
    currentClientSide = !!data.clientSide;
    titleEl.textContent = currentTitle;
    uploaderEl.textContent = data.uploader ? 'By ' + data.uploader : '';
    durationEl.textContent = data.duration ? 'Length: ' + fmtDuration(data.duration) : '';
    if (noteEl) {
      if (data.note) { noteEl.textContent = data.note; noteEl.hidden = false; }
      else noteEl.hidden = true;
    }

    // Proper preview player: play the source stream when possible,
    // fall back to the still image if the stream cannot play.
    var hasVideo = !!(data.previewUrl && videoEl);
    if (videoEl) {
      if (hasVideo) {
        // v3: the result can render TWICE for one link (sync info, then
        // the background-job result ~60s later). The second render
        // reset the box and sized it from the (by then loaded) 9:16
        // cover, while the video's 3:4 re-size never re-fired — setting
        // the SAME src does not fire loadedmetadata again, and
        // setupPreviewPlayer() early-returns once Plyr exists. So: if
        // the stream's metadata is already here, size from the VIDEO
        // right away; only fall back to the thumbnail while the stream
        // is still loading (its loadedmetadata listener then overrides
        // the thumb, as v2 intended).
        var hadVideoMeta = !!(videoEl.videoWidth && videoEl.videoHeight);
        resetPreviewPlayer();
        if (hadVideoMeta) sizePreviewPlayer();
        else sizeFromThumb(); // keep the preview's size while the stream loads
        videoEl.referrerPolicy = 'no-referrer';
        videoEl.src = data.previewUrl;
        videoEl.poster = data.thumbnail || '';
        videoEl.style.display = '';
        thumbImg.style.display = 'none';
        videoEl.load();
        setupPreviewPlayer();
        videoEl.onerror = function () {
          // The stream cannot play: hide the whole player box (the
          // Plyr frame would otherwise sit there empty) and fall back
          // to the still image, exactly like the old player did.
          pausePreviewPlayer();
          videoEl.style.display = 'none';
          if (playerWrap) playerWrap.classList.add('no-video');
          if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
        };
      } else {
        resetPreviewPlayer();
        sizeFromThumb(); // thumbnail-only result (e.g. X): keep the preview's size
        videoEl.style.display = 'none';
        if (playerWrap) playerWrap.classList.add('no-video');
        if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
        else thumbImg.style.display = 'none';
      }
    } else if (data.thumbnail) {
      thumbImg.src = data.thumbnail;
      thumbImg.style.display = '';
    }
    if (playerWrap) playerWrap.style.display = (hasVideo || data.thumbnail) ? '' : 'none';

    formatsEl.innerHTML = '';
    data.formats.forEach(function (f, i) {
      var li = document.createElement('li');
      if (i === 0) li.className = 'best';
      var size = fmtSize(f.filesize);
      var tag = i === 0 ? '<span class="tag">Best</span>' : (f.label === 'Audio only' ? '<span class="tag">Audio</span>' : '');
      li.innerHTML =
        tag +
        '<span class="q">' + f.label + '</span>' +
        '<span class="n">' + (f.note || '') + (size ? ' · ' + size : '') + '</span>' +
        '<button type="button">Save</button>';
      li.querySelector('button').addEventListener('click', function (ev) {
        var btn = ev.target;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        var reset = function () { setTimeout(function () { btn.disabled = false; btn.textContent = 'Save'; }, 3000); };
        var serverSave = function () {
          window.location.href = (currentInfoOrigin || '') + '/api/save?url=' + encodeURIComponent(currentUrl) +
            '&formatId=' + encodeURIComponent(f.id) +
            '&t=' + encodeURIComponent(currentTitle);
          reset();
        };
        // Open the file in a new tab with NO Referer (same reason as
        // downloadDirect). Used for files too big to hold in memory,
        // and when the file host refuses cross-origin reads.
        var openTab = function () {
          var a = document.createElement('a');
          a.href = f.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.referrerPolicy = 'no-referrer';
          a.download = safeFileName(currentTitle, f.ext);
          document.body.appendChild(a);
          a.click();
          a.remove();
          btn.textContent = 'Saving…';
          reset();
        };
        // Direct download when this quality carries its own link: the
        // browser fetches the file itself. Falls back to the server
        // save when the direct fetch fails — except on client-side-only
        // platforms, where there IS no server save: the browser then
        // opens the file itself in a new tab.
        var legacy = function () {
          downloadDirect(f.url, safeFileName(currentTitle, f.ext), function (done, total, bps) {
            btn.textContent = progressText(done, total, bps);
          }).then(function (ok) {
            if (ok) { btn.textContent = 'Saved ✓'; reset(); }
            else if (currentClientSide) openTab();
            else serverSave();
          });
        };
        if (f.url) {
          // Fast path first: parallel chunked download with live speed
          // (only when the CDN allows it). Any fast-path failure falls
          // through to the old flow below — nothing about it can break
          // a download that used to work. A file over the parallel cap
          // never goes through a whole-file fetch: it opens in a tab
          // (client-side-only) or takes the server stream instead.
          tryFastDownload(f, data.formats, safeFileName(currentTitle, f.ext), btn).then(function (res) {
            if (res === 'saved') { btn.textContent = 'Saved ✓'; reset(); }
            else if (res === 'toobig') { if (currentClientSide) openTab(); else serverSave(); }
            else legacy();
          });
          return;
        }
        serverSave();
      });
      formatsEl.appendChild(li);
    });
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = urlInput.value.trim();
    if (url) fetchInfo(url);
  });

  urlInput.addEventListener('input', showDetect);
  urlInput.addEventListener('paste', function () {
    setTimeout(function () {
      clearResult();
      showDetect();
      var v = urlInput.value.trim();
      if (detectPlatform(v)) fetchInfo(v); // instant: valid paste starts fetching right away
    }, 60);
  });

  if (pasteBtn) {
    pasteBtn.addEventListener('click', async function () {
      try {
        var text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          clearResult();
          showDetect();
          if (detectPlatform(urlInput.value.trim())) fetchInfo(urlInput.value.trim());
          return;
        }
      } catch (e) { /* clipboard blocked: fall through to focus */ }
      urlInput.focus();
    });
  }

  // The guiding text in the link box comes from the HTML placeholder
  // ("Paste your link here" on the home page, "Paste a TikTok link
  // here…" on a platform page) — never overwritten with an example URL.
})();
