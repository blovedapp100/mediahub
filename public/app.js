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
    // MOBILE-WIDTH FIX: on a phone the 0.70 cap shrank a 9:16 player to
    // ~74% of the screen (browser chrome eats viewport height). 0.78
    // keeps the player + title on screen while using the width.
    var maxH = Math.round(window.innerHeight * (isPhone ? 0.78 : 0.70));
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
  // X-LETTERBOX FIX: thumbImg may still hold the PREVIOUS search's image
  // (its src is only replaced when the stream errors or the preview
  // renders), so sizing from it locks the box to the old clip's ratio —
  // permanent when the new stream never delivers metadata (the X mp4
  // 403s, so loadedmetadata never fires to correct it). Pass the
  // CURRENT link's thumbnail URL: when thumbImg already holds that exact
  // (loaded) image, size from it at once; otherwise preload it in a
  // throwaway Image and size when it lands. The currentThumb check in
  // the load callback drops a late image from an older search.
  var currentThumb = '';
  function sizeFromThumb(url) {
    if (typeof url !== 'string' || !url) url = thumbImg ? thumbImg.src : '';
    if (!url) return;
    if (thumbImg && thumbImg.src === url && thumbImg.naturalWidth && thumbImg.naturalHeight) {
      sizePreviewPlayerFromRatio(thumbImg.naturalWidth / thumbImg.naturalHeight);
      return;
    }
    var img = new Image();
    img.onload = function () {
      if (url !== currentThumb) return; // a newer search superseded this one
      if (img.naturalWidth && img.naturalHeight) sizePreviewPlayerFromRatio(img.naturalWidth / img.naturalHeight);
    };
    img.src = url;
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
    // MOBILE-BLACK FIX: Plyr builds its own .plyr__poster div at init
    // and only fills it after its own image preload resolves — on a
    // slow connection the pre-play player sits black meanwhile. The
    // poster attribute was set before Plyr existed, so re-apply it now
    // that the div exists: the div gets the image at once (plus the
    // poster-enabled class, which is what makes it visible at all).
    var _posterUrl = videoEl.getAttribute('poster');
    if (_posterUrl) {
      showPreviewPoster(_posterUrl);
      var _plyrEl = playerWrap ? playerWrap.querySelector('.plyr') : null;
      if (_plyrEl) _plyrEl.classList.add('plyr__poster-enabled');
    }
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
    clearPosterStallTimer();
    pendingYouTubePreview = '';
    if (playerWrap) {
      playerWrap.style.width = '';
      playerWrap.style.height = '';
      playerWrap.style.aspectRatio = '';
      playerWrap.classList.remove('no-video');
      // A YouTube lazy-preview button from a previous search must not
      // sit over the new preview.
      var yb = playerWrap.querySelector('.yt-play-btn');
      if (yb) yb.remove();
      // A previous video's poster must not sit over the new preview:
      // Plyr mirrors the poster into its own .plyr__poster div and
      // never refreshes it when the src changes directly, so hide it
      // here; showPreviewPoster() below puts the new one back.
      var pp = playerWrap.querySelector('.plyr__poster');
      if (pp) pp.style.display = 'none';
    }
  }

  // The poster can be a different crop from the video (TikTok's cover
  // is 3:4, the clip 9:16), so while paused it letterboxes inside the
  // box and looks like a broken player — the box itself is the video's
  // true ratio (sized from its metadata). Once the first frame is
  // decoded, drop the poster so the paused player shows the video's
  // own first frame, which always matches the box. Plyr mirrors the
  // poster into its own .plyr__poster div (background-size: contain),
  // so removing the attribute alone leaves that div showing the old
  // crop — hide it too. If the frame never arrives (stream fails),
  // the poster stays and the error fallback takes over, so this can
  // never leave a black box. Audio-only keeps its poster (no frame).
  function clearPreviewPoster() {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return;
    // MOBILE-BLACK FIX: if the video is hidden (error fallback, or a
    // stale preview overwrote the result), the poster is the only
    // thing that could show — dropping it leaves a black box. Only
    // clear it when the video is actually on screen.
    if (videoEl.style.display === 'none' || (typeof getComputedStyle === 'function' && getComputedStyle(videoEl).display === 'none')) return;
    videoEl.removeAttribute('poster');
    var p = playerWrap ? playerWrap.querySelector('.plyr__poster') : null;
    if (p) p.style.display = 'none';
  }
  function showPreviewPoster(url) {
    if (videoEl && url) videoEl.setAttribute('poster', url);
    var p = playerWrap ? playerWrap.querySelector('.plyr__poster') : null;
    if (p && url) {
      p.style.display = '';
      p.style.backgroundImage = "url('" + url + "')";
    }
  }

  // ---- poster survival + YouTube lazy preview (2026-11-25) ------------
  // The still image (#thumb) used to be hidden the moment a preview
  // stream was set up, and the <video>'s own poster / first frame took
  // over — on mobile Chrome that frame is black (YouTube streams open
  // on a black frame, and a googlevideo URL signed for the server's
  // egress IP 403s / stalls on the visitor's phone), so every video
  // showed a black poster while playing fine. So now: #thumb stays
  // visible until the video fires loadeddata AND its first frame is
  // not black (when that can be detected at all); a stall (>3s with
  // no loadeddata) or an error restores #thumb. For YouTube the
  // googlevideo preview URL is never auto-loaded at all — the still
  // image + a play button are shown, and the stream loads only when
  // the visitor presses play.
  var pendingYouTubePreview = ''; // googlevideo URL waiting for a tap
  var posterStallTimer = null;
  var posterFrameHandler = null;
  function clearPosterStallTimer() {
    if (posterStallTimer) { clearTimeout(posterStallTimer); posterStallTimer = null; }
  }
  function firstFrameLooksBlack() {
    // Best-effort only: a cross-origin stream without CORS taints the
    // canvas, so getImageData throws — then we return null (unknown)
    // and loadeddata alone decides. Never blocks the poster.
    try {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
      var c = document.createElement('canvas');
      c.width = 16; c.height = 9;
      var ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(videoEl, 0, 0, 16, 9);
      var d = ctx.getImageData(0, 0, 16, 9).data;
      var sum = 0, n = 0;
      for (var i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
      return (sum / (n * 3)) < 12; // near-black first frame
    } catch (e) { return null; }
  }
  // Arm the poster handover for a stream that was just given a src:
  // hide #thumb only once a real (non-black, when detectable) frame
  // exists; if nothing arrives in 3s, restore #thumb instead of
  // leaving a black box. Call after setting videoEl.src + load().
  function armPosterSurvival() {
    clearPosterStallTimer();
    if (posterFrameHandler && videoEl) videoEl.removeEventListener('loadeddata', posterFrameHandler);
    posterFrameHandler = function () {
      clearPosterStallTimer();
      if (firstFrameLooksBlack() === true) return; // keep the still: first frame is black
      clearPreviewPoster();
      if (thumbImg) thumbImg.style.display = 'none';
    };
    if (videoEl) videoEl.addEventListener('loadeddata', posterFrameHandler, { once: true });
    posterStallTimer = setTimeout(function () {
      posterStallTimer = null;
      if (thumbImg && currentThumb) { thumbImg.src = currentThumb; thumbImg.style.display = ''; }
    }, 3000);
  }
  function showYouTubePlayButton() {
    if (!playerWrap) return;
    playerWrap.style.position = 'relative';
    var b = playerWrap.querySelector('.yt-play-btn');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'yt-play-btn';
      b.setAttribute('aria-label', 'Play preview');
      b.textContent = '▶';
      // Inline styles (no style.css change): a centred play disc
      // over the still image.
      b.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;border:0;background:rgba(0,0,0,0.65);color:#fff;font-size:26px;line-height:1;cursor:pointer;z-index:3;';
      b.addEventListener('click', loadYouTubePreview);
      playerWrap.appendChild(b);
    }
    b.style.display = '';
  }
  function loadYouTubePreview() {
    if (!pendingYouTubePreview || !videoEl) return;
    var url = pendingYouTubePreview;
    pendingYouTubePreview = null;
    var b = playerWrap ? playerWrap.querySelector('.yt-play-btn') : null;
    if (b) b.style.display = 'none';
    resetPreviewPlayer();
    sizeFromThumb(currentThumb);
    videoEl.referrerPolicy = 'no-referrer';
    videoEl.src = url;
    showPreviewPoster(currentThumb);
    videoEl.style.display = '';
    if (playerWrap) playerWrap.classList.remove('no-video');
    videoEl.preload = 'auto';
    videoEl.load();
    setupPreviewPlayer();
    armPosterSurvival(); // #thumb stays until a real frame exists
    try {
      if (previewPlyr) previewPlyr.play();
      else videoEl.play();
    } catch (e) { /* play usually allowed after a tap; if not, controls remain */ }
    videoEl.onerror = function () {
      clearPosterStallTimer();
      pausePreviewPlayer();
      videoEl.style.display = 'none';
      if (playerWrap) playerWrap.classList.add('no-video');
      if (currentThumb) { thumbImg.src = currentThumb; thumbImg.style.display = ''; }
      showYouTubePlayButton(); // let the visitor retry the tap
      pendingYouTubePreview = url;
    };
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
  var currentTitleOrigin = 'original'; // provenance of currentTitle ('original' | 'third-party')
  var metaTitle = ''; // platform-derived title from /api/meta — the filename source
  var metaTitleOrigin = 'original'; // provenance of metaTitle
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

  // YouTube video ID from any link form (watch / youtu.be / shorts /
  // live / embed / v). Used ONLY for the deterministic thumbnail URL
  // below — no other platform has one, so no ID is guessed for them.
  function youtubeIdFromUrl(u) {
    try {
      var p = new URL(u);
      var h = p.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
      if (h === 'youtu.be') return (p.pathname.split('/').filter(function (s) { return s; })[0] || '');
      if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
        if (p.pathname === '/watch') return p.searchParams.get('v') || '';
        var m = p.pathname.match(/^\/(shorts|live|embed|v)\/([A-Za-z0-9_-]{6,})/);
        if (m) return m[2];
      }
      return '';
    } catch (e) { return ''; }
  }
  function youtubeThumbUrl(id) { return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'; }

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
  // sibling format with the same label + file suffix), probe for ranged
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
  // Job-creation order (2026-11-25 speed fix 1c): BACKUP origins first,
  // the own origin LAST. A background job POST takes the first origin
  // that accepts it, so the old region-diverse order (own origin first)
  // always landed the job on main — the slowest origin for
  // YouTube/TikTok/Facebook (502s there while EU answers in ~2s).
  // Region diversity is kept for the backups; only the own origin is
  // moved to the end. Used by startJobFlow() and by the silent upgrade
  // job inside maybeUpgradeQualities(). Per-origin 10s cap and the
  // 429/400 early-break live in those callers and are unchanged.
  function orderOriginsForJob(list) {
    var own = location.origin;
    var src = list || [];
    var others = src.filter(function (o) { return o !== own; });
    var ordered = orderOriginsByRegion(others);
    if (src.indexOf(own) !== -1) ordered.push(own);
    return ordered;
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
    if (opts && opts.parallel) {
      // RACE all origins at once; the fastest healthy region wins.
      // (2026-11-25: serial order let a slow main — 26s 502 — plus a
      // hung backup eat the 45s stage budget before the fast EU origin
      // (1.8s) was ever tried, so YouTube showed only its thumbnail
      // and never played. A 4xx is NOT terminal mid-race: another
      // region may still answer ok; it only becomes the thrown error
      // when no origin succeeds at all.)
      var ctrls = list.map(function () { return new AbortController(); });
      var timers = ctrls.map(function (c) { return setTimeout(function () { c.abort(); }, timeoutMs); });
      var winner = null;
      var doneCount = 0;
      await new Promise(function (resolve) {
        list.forEach(function (origin, idx) {
          fetch(origin + path, Object.assign({}, options, { signal: ctrls[idx].signal }))
            .then(function (r) { return r.json().catch(function () { return null; }).then(function (data) { return { r: r, data: data }; }); })
            .then(function (o) {
              doneCount++;
              if (o && o.data && o.r.ok && !winner) {
                winner = { data: o.data, origin: origin };
                ctrls.forEach(function (c, j) { if (j !== idx) c.abort(); });
                resolve();
              } else {
                if (o && o.data && !o.r.ok) {
                  answered++;
                  if (o.data.geoBlocked) geoFails++;
                  var e = new Error(o.data.error || 'Something went wrong.');
                  if (o.data.geoBlocked) e.geoBlocked = true;
                  if (o.data.noStream) e.noStream = true;
                  if (o.r.status >= 400 && o.r.status < 500) e._terminal = true;
                  lastErr = e;
                } else if (!o || !o.data) {
                  lastErr = new Error('Something went wrong.');
                }
                if (doneCount === list.length) resolve();
              }
            })
            .catch(function (e) {
              doneCount++;
              lastErr = e;
              if (doneCount === list.length) resolve();
            });
        });
      });
      timers.forEach(function (t) { clearTimeout(t); });
      if (winner) return winner;
      if (answered && geoFails === answered && lastErr) lastErr.geoBlocked = true;
      throw lastErr || new Error('Something went wrong.');
    }
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

  // TITLE CLEANER (2026-11-25, user rule): a video's displayed title
  // must be ONLY the title — no view/reaction/like/comment/share
  // counts. Platforms (notably Facebook) prefix the page title with
  // engagement counts: "79K views · 438K reactions | SWITZERLAND in
  // winter...". Strip count segments (number + unit) at the start, at
  // the end, and between separators. A bare word like "view" with no
  // number is NOT stripped ("A view from the top" stays intact).
  // Same logic as the server's stripTitleCounts (defence in depth).
  function stripTitleCounts(t) {
    var s = String(t || '').trim();
    if (!s) return '';
    var orig = s;
    var num = '\\d[\\d,]*?(?:\\.\\d+)?\\s*[KMB]?';
    var unit = '(?:views?|reactions?|likes?|comments?|shares?)';
    var sep = '[·•|:\\-–—]';
    var mid = new RegExp('\\s*' + sep + '\\s*' + num + '\\s*' + unit + '(?=\\s*' + sep + ')', 'gi');
    s = s.replace(mid, '');
    var lead = new RegExp('^\\s*(?:' + num + '\\s*' + unit + '\\s*,\\s*)*' + num + '\\s*' + unit + '(?=\\s*(?:' + sep + '|\\d|$))\\s*(?:' + sep + '\\s*)?', 'i');
    while (lead.test(s)) s = s.replace(lead, '');
    var trailParen = new RegExp('\\s*\\(\\s*' + num + '\\s*' + unit + '\\s*\\)\\s*$', 'i');
    var trailSep = new RegExp('\\s*' + sep + '\\s*' + num + '\\s*' + unit + '\\s*$', 'i');
    var before;
    do {
      before = s;
      s = s.replace(trailParen, '').replace(trailSep, '');
    } while (s !== before);
    if (new RegExp('^\\s*' + num + '\\s*' + unit + '\\s*$', 'i').test(s)) s = '';
    if (s === orig) return s;
    s = s.replace(/\s{2,}/g, ' ').replace(/^[·•|:\-–—]\s*/, '').replace(/\s*[·•|:\-–—]$/, '').trim();
    return s;
  }

  // A scraped title can be an error page's junk name ("Error" when a
  // platform blocks datacenter IPs) — never show that as the video's
  // name; fall back to the neutral placeholder instead.
  function cleanTitle(t) {
    var s = String(t || '').trim();
    if (!s) return 'video';
    var low = s.toLowerCase();
    if (low === 'error' || low === 'something went wrong' ||
        low === 'page not found' || low === 'not found' ||
        low === '404 not found' || low === 'access denied' ||
        low === 'forbidden' || low === 'unavailable') return 'video';
    if (/^error\s*[|\-–—]/.test(s)) return 'video';
    // Strip engagement counts, then re-check: stripping can expose a
    // junk title underneath ("79K views · Error" -> "Error").
    s = stripTitleCounts(s);
    if (!s) return 'video';
    low = s.toLowerCase();
    if (low === 'error' || low === 'something went wrong' ||
        low === 'page not found' || low === 'not found' ||
        low === '404 not found' || low === 'access denied' ||
        low === 'forbidden' || low === 'unavailable') return 'video';
    if (/^error\s*[|\-–—]/.test(s)) return 'video';
    return s;
  }

  // FILENAME TITLE (2026-11-25, user rule): a downloaded file is named
  // from the ORIGINAL title or our cleaned title — never a third-party
  // lane's title. Order: an original /api/meta title first, then the
  // display title when it came from an original lane, then the
  // /api/meta title (the platform-derived replacement the rule names),
  // else the generic name. A third-party /api/info title is never used
  // directly as a filename.
  function fileTitle() {
    var m = String(metaTitle || '').trim();
    var c = String(currentTitle || '').trim();
    if (m && m !== 'video' && metaTitleOrigin === 'original') return m;
    if (c && c !== 'video' && currentTitleOrigin === 'original') return c;
    if (m && m !== 'video') return m;
    return 'video';
  }

  function renderPreview(data) {
    resetPreviewPlayer();
    currentTitle = cleanTitle(data.title);
    currentTitleOrigin = data.titleOrigin || 'original';
    currentThumb = data.thumbnail || '';
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
    // Fresh search: no title from a previous paste may leak into this
    // video's filename (fileTitle reads these).
    currentTitle = '';
    currentTitleOrigin = 'original';
    metaTitle = '';
    metaTitleOrigin = 'original';
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
    // Instant YouTube thumbnail (2026-11-25): the poster URL is
    // deterministic from the video ID, so paint it the moment the
    // link is pasted — never wait for /api/meta (~1.5s) or /api/info.
    // Falls back to mqdefault if hqdefault fails to load. A later
    // meta/info render overwrites it with the server's thumbnail.
    // YouTube only: no other platform has a deterministic thumb URL.
    var ytId = youtubeIdFromUrl(url);
    if (ytId && thumbImg) {
      var ytThumb = youtubeThumbUrl(ytId);
      currentThumb = ytThumb;
      titleEl.textContent = '';
      uploaderEl.textContent = '';
      durationEl.textContent = '';
      thumbImg.src = ytThumb;
      thumbImg.style.display = '';
      if (playerWrap) playerWrap.style.display = '';
      result.hidden = false;
      sizeFromThumb(ytThumb);
      thumbImg.addEventListener('error', function () {
        if (thumbImg.src === ytThumb) thumbImg.src = 'https://i.ytimg.com/vi/' + ytId + '/mqdefault.jpg';
      }, { once: true });
    }
    // JOINT RENDER (2026-11-25): the preview used to render the moment
    // /api/meta landed, leaving the visitor staring at "Finding
    // qualities…" for seconds while /api/info finished — the user asked
    // for preview + qualities TOGETHER, no waiting after the preview.
    // So the preview is HELD up to 2s for the info to land with it: if
    // the info arrives within the fuse, one render shows preview +
    // qualities together (gap 0); if it does not, the preview shows
    // anyway at the fuse so a slow link never leaves a blank screen.
    // (X is unaffected: its preview already carries the qualities and
    // renders the full result at once, as before.)
    var heldMeta = null; // preview data waiting for the info (or the fuse)
    var previewFuseTimer = null;
    var previewShown = false;
    function clearPreviewFuse() {
      if (previewFuseTimer) { clearTimeout(previewFuseTimer); previewFuseTimer = null; }
    }
    function showHeldPreview() {
      if (previewShown || !heldMeta || reqId !== latestReq) return;
      // MOBILE-BLACK FIX: the info can land BEFORE the meta (parallel
      // fetches). If the full result already rendered, the preview must
      // never overwrite it — renderPreview() hides the video and shows
      // the (clipped) thumbnail, leaving a black player.
      if (resultRendered) return;
      clearPreviewFuse();
      previewShown = true;
      renderedForReq = true;
      renderPreview(heldMeta);
      timerShown((Date.now() - timerStart) / 1000);
    }
    // Stage 1 — fast preview (title + thumbnail) in about a second.
    // At most 2 origins (own + 1 backup): a 404 means "no preview for
    // this link" on every region, so trying more only burns time.
    // Parallel + region-diverse (2026-11-25 speed fix 5): without opts
    // this ran SERIAL (main first, 5s, then backup) — TikTok's meta
    // 404s on main, so the preview never showed early. Now the fastest
    // region's meta wins.
    tryOrigins('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    }, 5000, 2, { regionDiverse: true, parallel: true })
      .then(function (res) {
        var data = res && res.data;
        if (reqId !== latestReq || !data || !data.title) return;
        metaDuration = data.duration || 0;
        metaTitle = cleanTitle(data.title);
        metaTitleOrigin = data.titleOrigin || 'original';
        if (data.formats && data.formats.length) {
          // The preview already carries this link's qualities (X: the
          // tweet page embeds the direct files, so /api/meta attaches
          // them). Render the full result NOW — Stage 2 below is only
          // a fallback and will re-render the same list if it lands.
          // This is what makes X robust when Stage 2 stalls in a real
          // browser: the qualities are on screen with the preview
          // (~1s) instead of depending on Stage 2's timers at all.
          clearPreviewFuse();
          currentInfoOrigin = res.origin;
          renderedForReq = true;
          resultRendered = true;
          renderResult(data);
          timerDone((Date.now() - timerStart) / 1000);
        } else {
          // Hold the preview for the info (joint render): the info
          // usually lands within 2s of the preview, and then one
          // render shows both together. The fuse below releases it
          // on its own if the info is slow.
          // MOBILE-BLACK FIX: the info may already have rendered
          // (it can land before the meta). Arming the fuse now would
          // fire showHeldPreview() 2s later and clobber the finished
          // result back to the preview (video hidden -> black box).
          if (resultRendered) return;
          heldMeta = data;
          clearPreviewFuse();
          previewFuseTimer = setTimeout(showHeldPreview, 2000);
        }
      })
      .catch(function () {});
    // Cold start: if nothing has rendered after 4s the service is
    // probably waking up (free tier sleeps after 15 min idle) — say so
    // instead of leaving the "usually shows in ~2s" estimate on screen.
    // (A held preview does not count as "nothing rendered" for this
    // message: the fuse will release it within 2s, so the wake-up text
    // would only flash over it.)
    setTimeout(function () {
      if (reqId === latestReq && !renderedForReq && !heldMeta && timerEl) {
        timerEl.innerHTML = 'Waking up the server… first load can take a few seconds, please wait.';
      }
    }, 4000);
    // Stage 2 — full quality list (takes a few seconds longer).
    // Tries the backup region too when this region cannot read the link.
    // Bounded: at most 3 origins at 27s each (2026-11-25: the server
    // needs up to 25s for a blocked YouTube lookup, so the old 10s
    // per-origin budget aborted the primary before it could ever
    // answer), and a 45s global budget for the whole stage — after
    // that the error below is shown instead of "Finding qualities…"
    // hanging forever. (/api/meta above is capped at 2 origins, 5s
    // each: it is only the fast preview.)
    // Note: timing.max is no longer used for /api/info; the table keeps
    // its measured per-platform figures for the on-screen estimate.
    // On a non-terminal failure the race is retried once at 15s (speed
    // fix 1a) before the job takes over — see the catch below.
    // ---- Background jobs (slow videos) ---------------------------------
    // Some videos can never finish inside /api/info's 25s cap: long
    // YouTube videos, Douyin/Kuaishou, Moj/ShareChat, Zhihu. For those
    // the server runs the same lookup in the background (POST /api/job)
    // and this code polls it. The fast path above is untouched: a video
    // that answers in time never starts a job. A job starts only when
    // the sync lookup is about to time out (8s for known-slow links,
    // 25s otherwise) or when it already timed out below.
    var jobStarted = false; // a job is running for this request
    var jobStopped = false; // Stage 2 won, or a newer request started
    var jobId = null;
    var jobOrigin = '';
    var jobPollTimer = null;
    // TikTok is known-slow (its sync lookup usually needs the job),
    // so it joins the known-slow set: the job starts at the first
    // timer check instead of waiting out the full 25s.
    function isSlowJobLink() {
      if (platform === 'TikTok' || platform === 'Douyin' || platform === 'Kuaishou' ||
          platform === 'Moj' || platform === 'ShareChat' || platform === 'Zhihu' ||
          platform === 'Facebook' || platform === 'Instagram') return true;
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
      // A held preview must not die with the job: show it so the
      // visitor still sees the video while the error is explained.
      showHeldPreview();
      if (!renderedForReq) { clearResult(); msg.textContent = text; }
      else if (!resultRendered) formatsEl.innerHTML = '<li class="loading">' + text + '</li>';
      if (reqId === latestReq) setBusy(false);
    }
    async function startJobFlow() {
      if (jobStarted || reqId !== latestReq || resultRendered) return;
      jobStarted = true;
      // Show the progress row NOW, before the job POST: a stalled
      // origin could hang the POST itself, and without this the visitor
      // stares at "Finding qualities…" with no sign of work.
      jobShowProgress(0, 'Getting it ready…');
      var origins;
      try { origins = await getOrigins(); } catch (e) { origins = [location.origin]; }
      // Speed fix 1c: backups first, own origin last (see
      // orderOriginsForJob) — the job must not land on main, the
      // slowest origin for YouTube/TikTok/Facebook.
      origins = orderOriginsForJob(origins.slice());
      var started = null;
      for (var i = 0; i < Math.min(3, origins.length); i++) {
        try {
          // 10s cap per origin: a stalled origin must not hang the job
          // POST forever (the hang that froze TikTok for minutes).
          var postCtrl = new AbortController();
          var postTimer = setTimeout(function () { postCtrl.abort(); }, 10000);
          var r;
          try {
            r = await fetch(origins[i] + '/api/job', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: url }),
              signal: postCtrl.signal,
            });
          } finally { clearTimeout(postTimer); }
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
        // 10s cap per poll: a stalled origin must not hang the poll.
        var pollCtrl = new AbortController();
        var pollTimer = setTimeout(function () { pollCtrl.abort(); }, 10000);
        try {
          pr = await fetch(jobOrigin + '/api/job/' + jobId, { signal: pollCtrl.signal });
          pd = await pr.json().catch(function () { return null; });
        } catch (e) { pd = null; }
        finally { clearTimeout(pollTimer); }
        if (reqId !== latestReq || jobStopped) return;
        if (!pd) { jobPollTimer = setTimeout(poll, 3000); return; }
        if (pd.status === 'ready' && pd.formats && pd.formats.length) {
          currentInfoOrigin = jobOrigin;
          renderedForReq = true;
          resultRendered = true;
          jobStopped = true;
          renderResult(pd);
          timerDone((Date.now() - timerStart) / 1000);
          // A job answer can itself be partial (server marks it
          // partial:true) — the silent upgrade below then chases the
          // fuller list, exactly as for a sync answer.
          maybeUpgradeQualities(pd);
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
    // At 8s, start the job if the link is known-slow by then; otherwise
    // wait out the remaining time to 25s and start it then. 8s (not
    // 12s): with the sync grace gone, a healthy TikTok answers by ~4s,
    // so at 8s the sync path is known-failed and the job — which
    // resolves TikTok in <5s — is the fastest rescue.
    function jobTimerDue() {
      if (reqId !== latestReq || resultRendered) return;
      var elapsed = Date.now() - timerStart;
      if (isSlowJobLink() || elapsed >= 25000) { startJobFlow(); return; }
      jobTimer = setTimeout(jobTimerDue, 25000 - elapsed);
    }
    var jobTimer = setTimeout(jobTimerDue, 8000);
    // ---- Progressive quality upgrade (TikTok completeness) -----------
    // The sync answer is fast but may carry only Best (SSSTik) while
    // tikwm's HD/SD/Audio are still landing. After a TikTok answer with
    // fewer than the full 4 formats, two silent routes run in parallel
    // and whichever delivers a fuller list first swaps the format rows
    // in place (the preview player is untouched): (1) poll GET
    // /api/merge — the union the race stores when the other leg lands
    // (~8s); (2) a background job — long tikwm timeout + 10s grace,
    // the reliable route (~10-13s). Silent: no progress rows, no
    // errors; if nothing fuller ever arrives, the visitor keeps the
    // qualities already shown. Stops on a newer request or when the
    // full list arrives.
    var upgradeDone = false;
    var upgradeTimer = null;
    var upgradeJobTimer = null;
    var upgradeJobId = null;
    var upgradeJobOrigin = '';
    function upgradeStop() {
      upgradeDone = true;
      if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null; }
      if (upgradeJobTimer) { clearTimeout(upgradeJobTimer); upgradeJobTimer = null; }
      if (upgradeJobId && upgradeJobOrigin) {
        fetch(upgradeJobOrigin + '/api/job/' + upgradeJobId, { method: 'DELETE' }).catch(function () {});
        upgradeJobId = null;
      }
    }
    function upgradeSwap(data) {
      if (reqId !== latestReq || upgradeDone || !data || !Array.isArray(data.formats)) return false;
      var shown = formatsEl.querySelectorAll('li').length;
      if (data.formats.length <= shown) {
        // YT-LONG FIX (2026-11-26): the job's list can be SHORTER yet
        // better. The choc first list (10 video-only + audio = 11
        // rows) is longer than the own full list (merged video+audio
        // pairs, one file with sound = 7-9 rows), but the own list is
        // the better one — so swap when the job brings a with-sound
        // quality and the shown list has none. The shown list's notes
        // are rendered as text in each <li> ("With sound" / "Video
        // only" / "Sound only"), so the check reads them directly.
        var jobHasSound = data.formats.some(function (f) { return f && f.hasAudio && f.label !== 'Audio only'; });
        if (!jobHasSound) return false;
        var shownHasSound = false;
        var items = formatsEl.querySelectorAll('li');
        for (var i = 0; i < items.length; i++) {
          if ((items[i].textContent || '').indexOf('With sound') !== -1) { shownHasSound = true; break; }
        }
        if (shownHasSound) return false;
        renderFormats(data);
        return true;
      }
      renderFormats(data);
      return true;
    }
    // Silent background job for the progressive upgrade: the same
    // lookup with no sync cap, polled up to 180s; on ready it swaps in
    // the fuller list (upgradeSwap) and stops. Silent by design: no
    // progress row, no error, never touches the playing preview
    // player; stops on a newer request (reqId) or when a fuller list
    // arrives. (The 60s cap was too short: the job lands at ~45-50s
    // on Render after the WARP-pass skip, and at ~100s before it —
    // YT-long fix 2026-11-26.) When the job's answer carries a
    // previewStream (same-origin relay, with sound) and the visitor
    // has not tapped play yet, the pending preview URL is updated to
    // it — so the tap plays with sound. A video already playing is
    // never swapped mid-play.
    // Job creation uses orderOriginsForJob (backups first, own origin
    // last — speed fix 1c); the 10s per-origin cap and the 429/400
    // early-break are unchanged.
    async function startUpgradeJob() {
      if (reqId !== latestReq || upgradeDone) return;
      var origins;
      try { origins = await getOrigins(); } catch (e) { origins = [location.origin]; }
      origins = orderOriginsForJob(origins.slice());
      var started = null;
      for (var i = 0; i < Math.min(3, origins.length); i++) {
        try {
          var postCtrl = new AbortController();
          var postTimer = setTimeout(function () { postCtrl.abort(); }, 10000);
          var rr;
          try {
            rr = await fetch(origins[i] + '/api/job', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: url }),
              signal: postCtrl.signal,
            });
          } finally { clearTimeout(postTimer); }
          var dd = await rr.json().catch(function () { return null; });
          if (rr.ok && dd && dd.jobId) { started = { origin: origins[i], jobId: dd.jobId }; break; }
          if (rr.status === 429 || rr.status === 400) break;
        } catch (e) { /* next origin */ }
        if (reqId !== latestReq || upgradeDone) return;
      }
      if (!started) return;
      upgradeJobOrigin = started.origin;
      upgradeJobId = started.jobId;
      var jobStart = Date.now();
      var poll = async function () {
        if (reqId !== latestReq) { upgradeStop(); return; }
        if (upgradeDone) return;
        if (Date.now() - jobStart > 180000) { upgradeStop(); return; }
        var pr, pd;
        var pCtrl = new AbortController();
        var pTimer = setTimeout(function () { pCtrl.abort(); }, 10000);
        try {
          pr = await fetch(upgradeJobOrigin + '/api/job/' + upgradeJobId, { signal: pCtrl.signal });
          pd = await pr.json().catch(function () { return null; });
        } catch (e) { pd = null; }
        finally { clearTimeout(pTimer); }
        if (reqId !== latestReq) { upgradeStop(); return; }
        if (upgradeDone) return;
        if (pd && pd.status === 'ready' && pd.formats && pd.formats.length) {
          upgradeSwap(pd);
          // YT-LONG FIX (2026-11-26): the job's answer carries the
          // preview relay (with sound) when the first list's preview
          // was the silent choc stream. Update the PENDING preview URL
          // so a later tap plays with sound. Only when the visitor
          // has not tapped yet (pendingYouTubePreview non-empty) — a
          // video already playing is never swapped mid-play.
          if (pd.previewStream && pendingYouTubePreview) pendingYouTubePreview = pd.previewStream;
          upgradeStop(); // job is done either way — nothing fuller left to show
          return;
        }
        if (pd && (pd.status === 'failed' || pr.status === 404)) { upgradeStop(); return; }
        upgradeJobTimer = setTimeout(poll, 3000);
      };
      poll();
    }
    function maybeUpgradeQualities(data) {
      if (!data || !Array.isArray(data.formats)) return;
      if (reqId !== latestReq) return;
      var isPartial = data.partial === true;
      if (platform === 'TikTok') {
        // TikTok completeness trigger, unchanged: fewer than the full
        // 4 formats (Best + HD + SD + Audio) — or a partial flag.
        if (data.formats.length >= 4 && !isPartial) return;
      } else {
        // Generalised upgrade (2026-11-25 speed fix 6): the server
        // marks a degraded/partial /api/info answer with top-level
        // partial:true (e.g. a YouTube mirror 240p-only list). ANY
        // platform may be partial, so a partial rendered result starts
        // the SILENT upgrade flow — background-job route only (no
        // merge poll: /api/merge is a TikTok union, not a general
        // fuller list). It never shows an error or progress row, never
        // touches the playing preview player (it may update the pending
        // tap-to-play URL — YT-long fix 2026-11-26), and stops on a
        // newer request (reqId) or when a fuller list arrives (see
        // startUpgradeJob).
        if (!isPartial) return;
      }
      if (platform === 'TikTok') {
        var mergeOrigin = currentInfoOrigin || location.origin;
        var mergeDeadline = Date.now() + 12000;
        var pollMerge = async function () {
          if (reqId !== latestReq || upgradeDone) return;
          if (Date.now() > mergeDeadline) return; // the job below is the remaining route
          try {
            var mCtrl = new AbortController();
            var mTimer = setTimeout(function () { mCtrl.abort(); }, 5000);
            var r;
            try {
              r = await fetch(mergeOrigin + '/api/merge?url=' + encodeURIComponent(url), { signal: mCtrl.signal });
            } finally { clearTimeout(mTimer); }
            if (r.ok) {
              var d = await r.json().catch(function () { return null; });
              if (d && upgradeSwap(d)) { upgradeStop(); return; }
            }
          } catch (e) { /* next poll */ }
          if (reqId !== latestReq || upgradeDone) return;
          upgradeTimer = setTimeout(pollMerge, 2000);
        };
        pollMerge();
      }
      // Silent background job: same lookup with no sync cap, so tikwm
      // gets its 15s timeout and the 10s grace can merge it (TikTok),
      // or the fuller list lands for a partial answer (any platform).
      // Started at once (the job itself takes ~10s) — the merge poll
      // above usually wins first when tikwm cooperates quickly.
      startUpgradeJob();
    }
    // The /api/info request options, shared by the first race and the
    // retry below (speed fix 1a) so both attempts ask for the same thing.
    var infoReqOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    };
    try {
      var infoBudget = new Promise(function (resolve, reject) {
        setTimeout(function () {
          var err = new Error(platform + ' is taking too long right now. Please try again.');
          err.name = 'AbortError';
          reject(err);
        }, 45000);
      });
      var res = await Promise.race([
        tryOrigins('/api/info', infoReqOptions, 27000, 3, { regionDiverse: true, parallel: true }),
        infoBudget,
      ]);
      jobStop(); // Stage 2 won: stop any job polling and free its slot
      if (reqId !== latestReq) return;
      clearPreviewFuse(); // joint render: the preview was held for this — show both at once
      currentInfoOrigin = res.origin;
      renderedForReq = true;
      resultRendered = true;
      renderResult(res.data);
      timerDone((Date.now() - timerStart) / 1000);
      maybeUpgradeQualities(res.data);
    } catch (err) {
      if (reqId !== latestReq) return;
      // RACE RETRY (2026-11-25 speed fix 1a/1b): the first race can
      // lose to a cold origin even though a second attempt — a few
      // seconds later, against warming origins — would win. So before
      // the job is allowed to own the UI, retry the race ONCE with a
      // shorter 15s budget, for any error that is NOT terminal (4xx),
      // NOT a geo-block and NOT a no-stream video (those are decided:
      // another attempt would answer the same way). The job timer is
      // deliberately NOT cleared before the retry: the job may start
      // while the retry is in flight, and that is fine — a retry win
      // below stops it with jobStop() and renders, exactly like the
      // first-attempt success path above. A race win is therefore
      // honoured whenever it lands, even while a job is polling.
      // Only if the retry ALSO fails AND a job has started does the
      // job own the UI; otherwise the error handling below runs (and
      // may itself start the job for a slow, undecided link).
      if (err && !err._terminal && !err.geoBlocked && !err.noStream) {
        try {
          var retryBudget = new Promise(function (resolve, reject) {
            setTimeout(function () {
              var err2 = new Error(platform + ' is taking too long right now. Please try again.');
              err2.name = 'AbortError';
              reject(err2);
            }, 15000);
          });
          var res2 = await Promise.race([
            tryOrigins('/api/info', infoReqOptions, 15000, 3, { regionDiverse: true, parallel: true }),
            retryBudget,
          ]);
          jobStop(); // retry won: stop any job polling and free its slot
          if (reqId !== latestReq) return;
          clearPreviewFuse();
          currentInfoOrigin = res2.origin;
          renderedForReq = true;
          resultRendered = true;
          renderResult(res2.data);
          timerDone((Date.now() - timerStart) / 1000);
          maybeUpgradeQualities(res2.data);
          return;
        } catch (err2) {
          err = err2; // the retry's verdict decides what happens next
        }
      }
      clearTimeout(jobTimer);
      if (jobStarted) return; // the job flow owns the UI now
      stopTimer();
      // The info failed: no point holding the preview out for the fuse
      // any longer — show it now so the visitor at least sees the
      // video while the error is explained below.
      showHeldPreview();
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

  // The format rows, extracted so the progressive upgrade can swap
  // them in place without touching the preview player or scrolling.
  function renderFormats(data) {
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
            '&t=' + encodeURIComponent(fileTitle());
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
          a.download = safeFileName(fileTitle(), f.ext);
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
          downloadDirect(f.url, safeFileName(fileTitle(), f.ext), function (done, total, bps) {
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
          tryFastDownload(f, data.formats, safeFileName(fileTitle(), f.ext), btn).then(function (res) {
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
  }

  function renderResult(data) {
    currentTitle = cleanTitle(data.title);
    currentTitleOrigin = data.titleOrigin || 'original';
    currentThumb = data.thumbnail || '';
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
    var isYouTubeResult = detectPlatform(currentUrl) === 'YouTube';
    if (videoEl) {
      if (hasVideo && isYouTubeResult) {
        // YouTube lazy preview (2026-11-25): never auto-load the
        // googlevideo preview URL — it was signed for the server's
        // egress IP and 403s / stalls on the visitor's phone, leaving
        // a black box. Show the still image + a play button; the
        // stream loads only when the visitor presses play.
        // YT-LONG FIX (2026-11-26): prefer the same-origin relay
        // (previewStream) when the server sent one — the YT-A proxy
        // URL is unplayable cross-origin (CORP, no ACAO, no Range),
        // so a tap on it did nothing (black, silent, "Nothing
        // played"). The relay streams the same file with video
        // headers, so the tap plays with sound. Falls back to the raw
        // previewUrl (choc proxy / Piped) when no relay exists.
        resetPreviewPlayer();
        sizeFromThumb(data.thumbnail);
        pendingYouTubePreview = data.previewStream || data.previewUrl;
        videoEl.style.display = 'none';
        if (playerWrap) playerWrap.classList.add('no-video');
        if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
        else thumbImg.style.display = 'none';
        showYouTubePlayButton();
      } else if (hasVideo) {
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
        // X-LETTERBOX FIX: only trust the video's metadata when it
        // belongs to THIS video. After a previous search the element
        // still reports the OLD clip's dimensions until the new stream's
        // resource selection resets them, and sizing from them locks the
        // box to the old clip's ratio. currentSrc matches only on the
        // double-render of the SAME link (v3's case), where the metadata
        // really is this video's.
        var hadVideoMeta = !!(videoEl.videoWidth && videoEl.videoHeight) &&
          videoEl.currentSrc === data.previewUrl;
        resetPreviewPlayer();
        if (hadVideoMeta) sizePreviewPlayer();
        else sizeFromThumb(data.thumbnail); // size from THIS link's thumbnail
        videoEl.referrerPolicy = 'no-referrer';
        videoEl.src = data.previewUrl;
        showPreviewPoster(data.thumbnail);
        videoEl.style.display = '';
        // Poster survival (2026-11-25): do NOT hide #thumb here — it
        // stays until a real frame arrives (armPosterSurvival below).
        // Hiding it now is what left a black box on mobile.
        // preload="auto" (not the HTML's "metadata"): the first frame
        // must be buffered, or the paused player has no frame to show
        // once the poster is dropped below.
        videoEl.preload = 'auto';
        videoEl.load();
        setupPreviewPlayer();
        // Poster survival (2026-11-25): #thumb hides only once a real
        // (non-black, when detectable) frame exists; a >3s stall
        // restores #thumb instead of leaving a black box.
        armPosterSurvival();
        videoEl.onerror = function () {
          // The stream cannot play: hide the whole player box (the
          // Plyr frame would otherwise sit there empty) and fall back
          // to the still image, exactly like the old player did.
          clearPosterStallTimer();
          pausePreviewPlayer();
          videoEl.style.display = 'none';
          if (playerWrap) playerWrap.classList.add('no-video');
          if (data.thumbnail) { thumbImg.src = data.thumbnail; thumbImg.style.display = ''; }
          // X-LETTERBOX FIX: the failed stream never delivered metadata,
          // so the box may still carry a stale size (from the previous
          // clip, or the hidden-state 200px clamp): re-size it from this
          // link's thumbnail. Only when the video has no dimensions at
          // all — if metadata arrived, the box is already the video's
          // own ratio and the thumbnail must not override it.
          if (!videoEl.videoWidth) { previewVideoSized = false; sizeFromThumb(data.thumbnail); }
        };
      } else {
        resetPreviewPlayer();
        sizeFromThumb(data.thumbnail); // thumbnail-only result: size from THIS link's thumbnail
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

    renderFormats(data);
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
