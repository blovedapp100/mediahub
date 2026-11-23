// MediaHub frontend — no frameworks, no heavy libs.
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
  if (!form || !urlInput) return;

  var PLATFORMS = [
    ['tiktok.com', 'TikTok'],
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
  ];

  var currentUrl = '';
  var currentTitle = '';

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
    } else {
      detect.className = 'detect';
      detect.textContent = '';
    }
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

  function setBusy(busy) {
    goBtn.disabled = busy;
    goBtn.textContent = busy ? 'Loading…' : 'Get video';
    progress.classList.toggle('show', busy);
  }

  async function fetchInfo(url) {
    currentUrl = url;
    setBusy(true);
    msg.textContent = '';
    result.hidden = true;
    formatsEl.innerHTML = '';
    try {
      var r = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url }),
      });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Something went wrong.');
      renderResult(data);
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong. Please try another link.';
    } finally {
      setBusy(false);
    }
  }

  function renderResult(data) {
    currentTitle = data.title || 'video';
    titleEl.textContent = currentTitle;
    uploaderEl.textContent = data.uploader ? 'By ' + data.uploader : '';
    durationEl.textContent = data.duration ? 'Length: ' + fmtDuration(data.duration) : '';

    // Proper preview player: play the source stream when possible,
    // fall back to the still image if the stream cannot play.
    var hasVideo = !!(data.previewUrl && videoEl);
    if (videoEl) {
      if (hasVideo) {
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
        var saveUrl = '/api/save?url=' + encodeURIComponent(currentUrl) +
          '&formatId=' + encodeURIComponent(f.id) +
          '&t=' + encodeURIComponent(currentTitle);
        window.location.href = saveUrl;
        setTimeout(function () { btn.disabled = false; btn.textContent = 'Save'; }, 3000);
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
