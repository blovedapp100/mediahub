// Popup for Save Video Cookie Sync: shows the last sync and per-platform
// cookie counts, with a "Sync now" button for an immediate sync. Also shows
// the site-open gate: syncing only happens while the Save Video website is
// open in a tab, so when the site is closed the popup says so instead of
// pretending a sync happened.
const ORIGIN_COUNT = 15;

function originOkCount(p) {
  if (!p || !p.origins) return null;
  const vals = Object.values(p.origins);
  return vals.filter((v) => v === 'ok').length;
}

function render(data, gate) {
  const rows = document.getElementById('rows');
  const last = document.getElementById('last');
  const gateEl = document.getElementById('gate');
  const names = { youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram', douyin: 'Douyin', reddit: 'Reddit', xigua: 'Xigua', weibo: 'Weibo', xiaohongshu: 'Xiaohongshu', zhihu: 'Zhihu', iqiyi: 'iQIYI' };
  if (gate && gate.gated) {
    gateEl.style.display = 'block';
    gateEl.textContent = 'Waiting for the website to open — open Save Video in a tab to sync.';
  } else {
    gateEl.style.display = 'none';
    gateEl.textContent = '';
  }
  rows.innerHTML = '';
  if (!data || !data.platforms) {
    last.textContent = 'Never synced yet.';
    for (const k of Object.keys(names)) {
      rows.insertAdjacentHTML('beforeend', '<div class="row"><span>' + names[k] + '</span><b>—</b></div>');
    }
    return;
  }
  for (const k of Object.keys(names)) {
    const p = data.platforms[k];
    let right = '—';
    if (p) {
      if (p.error) right = '<span class="bad">error</span>';
      else if (p.skipped) right = '0 (not logged in)';
      else {
        const ok = originOkCount(p);
        right = p.count + ' cookies' + (ok === null ? '' : ' · ' + ok + '/' + ORIGIN_COUNT + ' servers');
      }
    }
    rows.insertAdjacentHTML('beforeend', '<div class="row"><span>' + names[k] + '</span><b>' + right + '</b></div>');
  }
  last.textContent = data.lastSync
    ? 'Last sync: ' + new Date(data.lastSync).toLocaleString() + ' (' + (data.reason || '') + ')'
    : 'Never synced yet.';
}

async function refresh() {
  const stored = await chrome.storage.local.get(['lastSync', 'gate']);
  render(stored.lastSync || null, stored.gate || null);
}

document.getElementById('syncNow').addEventListener('click', async () => {
  const btn = document.getElementById('syncNow');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = 'Syncing…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sync-now' });
    if (res && res.gated) {
      // The gate held: no sync ran. Show the waiting state (it does not
      // bypass the gate) and re-read storage so the banner shows too.
      status.textContent = 'Waiting for the website to open — open Save Video in a tab to sync.';
      await refresh();
    } else {
      render(res, null);
      status.textContent = 'Done.';
    }
  } catch (e) {
    status.textContent = 'Sync failed: ' + String((e && e.message) || e);
  }
  btn.disabled = false;
});

refresh();
