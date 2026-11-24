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

  // Download a file straight from the video CDN in this browser: fetch it
  // (TikTok / Facebook / Instagram CDNs allow cross-origin reads) and save
  // the blob with a proper name. The server never sees the bytes — it only
  // keeps the website live. Returns false when the direct fetch fails, so
  // the caller can fall back to the server save. YouTube's CDN does not
  // allow cross-origin reads, so YouTube qualities keep the server path.
  async function downloadDirect(url, filename) {
    try {
      // No Referer: some CDNs (video.twimg.com) 403 when the request
      // carries another site's Referer, even though the file itself is
      // public. Sending no Referer makes the same URL answer 206.
      var r = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!r.ok) return false;
      var blob = await r.blob();
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

  // TikTok straight from the visitor's browser: tikwm's public API allows
  // cross-origin calls, so the browser itself asks tikwm for the video's
  // direct links — no server involved at all. Returns the same shape
  // renderResult expects, or null when tikwm cannot be reached (then the
  // server flow below runs instead). The timeout is generous (20s) on
  // purpose: tikwm's answers swing from ~3s to ~15s, and this call runs
  // concurrently with the server stages, so waiting longer costs nothing
  // when tikwm is fast — but an 8s timeout threw away slow answers that
  // would have rendered.
  async function fetchTikwmBrowser(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    try {
      var r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', { signal: ctrl.signal });
      var j = await r.json();
      if (!j || j.code !== 0 || !j.data || !j.data.play) return null;
      var d = j.data;
      var formats = [];
      if (d.hdplay) formats.push({ id: 'tt-hd', label: 'HD', ext: 'mp4', hasAudio: true, filesize: 0, note: 'Best quality', url: d.hdplay });
      formats.push({ id: 'tt-sd', label: 'SD', ext: 'mp4', hasAudio: true, filesize: 0, note: '', url: d.play });
      if (d.music) formats.push({ id: 'tt-audio', label: 'Audio only', ext: 'mp3', hasAudio: true, filesize: 0, note: 'Sound only', url: d.music });
      return {
        title: d.title || 'TikTok video',
        uploader: (d.author && d.author.nickname) || '',
        duration: d.duration || 0,
        thumbnail: d.cover || '',
        previewUrl: d.hdplay || d.play || '',
        formats: formats,
      };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

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
    'Vimeo': { meta: 1, info: 8, max: 30 },
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
    currentTitle = data.title || 'video';
    titleEl.textContent = currentTitle;
    uploaderEl.textContent = data.uploader ? 'By ' + data.uploader : '';
    durationEl.textContent = data.duration ? 'Length: ' + fmtDuration(data.duration) : '';
    if (videoEl) {
      try { videoEl.pause(); } catch (e) {}
      videoEl.removeAttribute('src');
      videoEl.style.display = 'none';
    }
    if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
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
    // preview must not block the browser tikwm result from rendering its
    // qualities: renderPreview only shows title/thumbnail + "Finding
    // qualities…", so discarding the tikwm answer after a preview left
    // the user stuck on "Could not load qualities" even though the
    // browser already had the whole quality list.
    var platform = detectPlatform(url) || 'Video';
    var timing = startTimer(platform);
    setBusy(true);
    msg.textContent = '';
    result.hidden = true;
    formatsEl.innerHTML = '';
    // TikTok: the browser itself asks tikwm (public, cross-origin) at
    // the SAME time as the server stages below — it used to be awaited
    // first, which held the whole flow up to 8s when tikwm was slow.
    // Whichever answers first renders; the server result replaces it
    // when it lands.
    var ttRendered = false;
    if (platform === 'TikTok') {
      fetchTikwmBrowser(url).then(function (tt) {
        if (tt && reqId === latestReq && !resultRendered) {
          renderedForReq = true;
          resultRendered = true;
          ttRendered = true;
          renderResult(tt);
          timerDone((Date.now() - timerStart) / 1000);
        }
      }).catch(function () {});
    }
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
      if (reqId !== latestReq) return;
      currentInfoOrigin = res.origin;
      renderedForReq = true;
      resultRendered = true;
      renderResult(res.data);
      timerDone((Date.now() - timerStart) / 1000);
    } catch (err) {
      if (reqId !== latestReq) return;
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
        videoEl.referrerPolicy = 'no-referrer';
        videoEl.src = data.previewUrl;
        videoEl.poster = data.thumbnail || '';
        videoEl.style.display = '';
        thumbImg.style.display = 'none';
        videoEl.load();
        videoEl.onerror = function () {
          videoEl.style.display = 'none';
          if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
        };
      } else {
        videoEl.style.display = 'none';
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
        // Direct download when this quality carries its own link: the
        // browser fetches the file straight from the video CDN. Falls
        // back to the server save when the direct fetch fails — except
        // on client-side-only platforms, where there IS no server save:
        // the browser then opens the file itself in a new tab, and the
        // file still comes straight from the video CDN to this device,
        // never through our server. (Some CDNs refuse cross-origin
        // reads, so the open-in-tab step is how those files arrive.)
        if (f.url) {
          downloadDirect(f.url, safeFileName(currentTitle, f.ext)).then(function (ok) {
            if (ok) { btn.textContent = 'Saved ✓'; reset(); }
            else if (currentClientSide) {
              // Open the file in a new tab with NO Referer (same reason
              // as downloadDirect: video.twimg.com 403s a request that
              // carries this site's Referer). The file still comes
              // straight from the video CDN to this device.
              var a = document.createElement('a');
              a.href = f.url;
              a.target = '_blank';
              a.rel = 'noopener';
              a.referrerPolicy = 'no-referrer';
              a.download = safeFileName(currentTitle, f.ext);
              document.body.appendChild(a);
              a.click();
              a.remove();
              btn.textContent = 'Opened ↗';
              reset();
            }
            else serverSave();
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

  // Prefill the example link for the platform page, if the field is empty.
  var example = urlInput.getAttribute('data-example') || '';
  if (example && !urlInput.value) urlInput.placeholder = 'Try: ' + example;
})();
