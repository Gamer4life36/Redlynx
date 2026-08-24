/* Browser chrome: tab strip, omnibar, panels, and the ask-first prompts. */
const api = window.redlynx;
const $ = (id) => document.getElementById(id);

let state = { tabs: [], activeId: null };
let nav = { url: '', canBack: false, canFwd: false, loading: false, secure: false, blocked: 0, media: 0 };
let prefs = {};
let urlFocused = false;

// ── tabs ──────────────────────────────────────────────────────────
let dragId = null;

function clearDropMarks() {
  document.querySelectorAll('.tab.dropL, .tab.dropR')
    .forEach((n) => n.classList.remove('dropL', 'dropR'));
}

function renderTabs() {
  const host = $('tabs');
  // Every redraw rebuilds the strip. Without this the tabs are appended
  // again each time, so closing one appears to multiply them.
  host.replaceChildren();
  state.tabs.forEach((t, index) => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeId ? ' active' : '') + (t.suspended ? ' sus' : '') + (t.private ? ' priv' : '');
    el.dataset.id = String(t.id);
    el.title = (t.suspended ? '[suspended] ' : '') + (t.title || '') + '\n' + (t.url || '');
    const dot = t.loading ? '<span class="dot"></span>' : (t.pinned ? '<span class="dot" style="background:var(--warn)"></span>' : '');
    el.innerHTML = dot + '<span class="t"></span><span class="cl" title="Close">✕</span>';
    el.querySelector('.t').textContent = t.title || 'New tab';
    el.onclick = (e) => { if (!e.target.classList.contains('cl')) api.activateTab(t.id); };
    // Middle-click closes the tab, as everywhere else. auxclick rather than
    // mousedown so a drag that starts on the wheel button does not close it.
    el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); api.closeTab(t.id); } };
    el.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
    el.querySelector('.cl').onclick = (e) => { e.stopPropagation(); api.closeTab(t.id); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (t.id === state.activeId) api.pinTab(t.id); else api.suspendTab(t.id);
    };

    // Drag to reorder. The drop side is decided by which half of the tab the
    // pointer is over, so a drag reads the same way it looks.
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragId = t.id;
      el.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); } catch (err) {}
    });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearDropMarks(); });
    el.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === t.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      clearDropMarks();
      el.classList.add(after ? 'dropR' : 'dropL');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (dragId === null || dragId === t.id) return;
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      const fromIndex = state.tabs.findIndex((x) => x.id === dragId);
      let to = index + (after ? 1 : 0);
      // Removing the dragged tab first shifts everything after it left by one.
      if (fromIndex > -1 && fromIndex < to) to -= 1;
      clearDropMarks();
      const moving = dragId;
      dragId = null;
      await api.moveTab(moving, to);
    });

    host.appendChild(el);
  });
}

// ── omnibar ───────────────────────────────────────────────────────
function renderNav() {
  $('back').disabled = !nav.canBack;
  $('forward').disabled = !nav.canFwd;
  $('reload').textContent = nav.loading ? '✕' : '⟳';
  $('lock').textContent = nav.secure ? '🔒' : '⚠';
  $('lock').title = nav.secure ? 'Encrypted connection' : 'Not secure';
  if (!urlFocused) $('url').value = nav.url || '';

  $('blockCount').textContent = nav.blocked || 0;
  $('shield').classList.toggle('live', (nav.blocked || 0) > 0);
  $('shieldTotal').textContent = nav.blocked || 0;

  const m = nav.media || 0;
  $('mediaCount').textContent = m;
  $('grabBtn').classList.toggle('live', m > 0);
  $('grabBtn').title = m ? (m + ' downloadable item(s) found on this page') : 'Download media from this page';
}

$('back').onclick = () => api.back();
$('forward').onclick = () => api.forward();
$('reload').onclick = () => (nav.loading ? api.stop() : api.reload());
$('home').onclick = () => api.home();
$('newtab').onclick = () => api.newTab();
$('btnSuspendOthers').onclick = async () => { await api.suspendOthers(); toast('Other tabs suspended — memory freed.'); };

const url = $('url');
url.addEventListener('focus', () => { urlFocused = true; url.select(); });
url.addEventListener('blur', () => { urlFocused = false; renderNav(); });
// ── omnibar suggestions ───────────────────────────────────────────
// History and bookmarks have been searchable all along; there was simply
// nothing showing them. The first row is whatever Enter would do anyway, so
// arrowing down never contradicts just pressing return.
const SUG_ICONS = { search: '🔎', url: '🌐', bookmark: '★', history: '🕓' };
let sugs = [];
let sugSel = -1;
let sugSeq = 0;

function positionDrop() {
  const drop = $('omniDrop');
  const box = $('url').closest('.urlwrap').getBoundingClientRect();
  drop.style.left = Math.round(box.left) + 'px';
  drop.style.width = Math.round(box.width) + 'px';
  drop.style.top = Math.round(box.bottom + 6) + 'px';
}

function closeSuggest() {
  sugs = []; sugSel = -1;
  $('omniDrop').classList.remove('open');
  syncOverlay();
}

function renderSuggest() {
  const drop = $('omniDrop');
  if (!sugs.length) return closeSuggest();
  drop.innerHTML = '';
  sugs.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'osug' + (i === sugSel ? ' sel' : '');
    row.innerHTML = '<div class="oic"></div><div class="otx"><div class="ott"></div><div class="osb"></div></div>';
    row.querySelector('.oic').textContent = SUG_ICONS[s.kind] || '🌐';
    row.querySelector('.ott').textContent = s.title;
    row.querySelector('.osb').textContent = s.sub || s.url;
    // mousedown, not click: the input's blur would close this first.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); goTo(s.url); });
    drop.appendChild(row);
  });
  positionDrop();
  drop.classList.add('open');
  syncOverlay();
}

function goTo(target) {
  closeSuggest();
  $('url').blur();
  api.go(target);
}

async function askSuggest() {
  const q = $('url').value.trim();
  if (!q) return closeSuggest();
  const mine = ++sugSeq;
  let list = [];
  try { list = await api.omniSuggest(q); } catch (e) { list = []; }
  if (mine !== sugSeq) return;          // a newer keystroke already answered
  sugs = list || [];
  sugSel = -1;
  renderSuggest();
}

// Warm the connection while the user is still typing, so Enter reuses an
// already-open socket instead of starting DNS and TLS from scratch.
let warmTimer = null;
url.addEventListener('focus', () => { try { api.warm(''); } catch (e) {} });
url.addEventListener('input', () => {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const v = url.value.trim();
    // A typed address warms that host; anything else is heading for a search.
    const isUrl = /^[a-z]+:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+/.test(v);
    try { api.warm(isUrl ? (/^[a-z]+:\/\//i.test(v) ? v : 'https://' + v) : ''); } catch (e) {}
  }, 120);
});

url.addEventListener('input', askSuggest);
url.addEventListener('blur', () => setTimeout(closeSuggest, 120));

url.addEventListener('keydown', (e) => {
  const open = sugs.length && $('omniDrop').classList.contains('open');
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    sugSel += e.key === 'ArrowDown' ? 1 : -1;
    if (sugSel < -1) sugSel = sugs.length - 1;
    if (sugSel >= sugs.length) sugSel = -1;
    renderSuggest();
    return;
  }
  if (e.key === 'Enter') {
    // -1 means no row is picked, which is the typed text itself.
    goTo(open && sugSel >= 0 ? sugs[sugSel].url : url.value);
    return;
  }
  if (e.key === 'Escape') {
    if (open) { closeSuggest(); return; }
    url.value = nav.url;
    url.blur();
  }
});

// ── panels ────────────────────────────────────────────────────────
const PANELS = ['panelDownloads', 'panelMedia', 'panelShield', 'panelSettings', 'panelAI', 'panelGX', 'panelFavs', 'panelHistory', 'panelAnon', 'panelDeep'];
// Anything drawn over the page needs the chrome view grown and raised first,
// or it is clipped to the top strip and hidden behind the site.
function syncOverlay() {
  const shown = PANELS.some((p) => $(p).classList.contains('open')) ||
                $('promptWrap').classList.contains('open') ||
                $('omniDrop').classList.contains('open') ||
                $('paletteWrap').classList.contains('open') ||
                $('findbar').classList.contains('on');
  try { api.setOverlay(shown); } catch (e) {}
}

function openPanel(id) {
  PANELS.forEach((p) => $(p).classList.toggle('open', p === id));
  syncOverlay();
  if (id === 'panelDownloads') refreshDownloads();
  if (id === 'panelMedia') refreshMedia();
  if (id === 'panelSettings') {
    refreshSettings(); refreshExtensions(); refreshPerms();
    api.updateStatus().then(renderUpdate).catch(() => {});
  }
  if (id === 'panelAI') refreshAI();
  if (id === 'panelGX') refreshGX();
  if (id === 'panelFavs') refreshFavs();
  if (id === 'panelShield') refreshShield();
  if (id === 'panelHistory') refreshHistory();
  if (id === 'panelAnon') refreshAnon();
}
function closePanels() { PANELS.forEach((p) => $(p).classList.remove('open')); syncOverlay(); }

// With a panel open the chrome covers the whole window, so a click on what
// looks like the page lands on us instead of the site. Treat that as
// "dismiss", which is what clicking away from a panel should do anyway.
// Toolbar controls are excluded so their own toggles still work: this runs on
// mousedown, and closing here first would make a second click re-open.
document.addEventListener('mousedown', (e) => {
  if (!PANELS.some((p) => $(p).classList.contains('open'))) return;
  if (e.target.closest('.panel, .promptwrap')) return;
  if (e.target.closest('.chip, .inline, .nav, .tab, .tabstrip, .omnibar, .bmbar, .findbar')) return;
  closePanels();
});
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closePanels));
$('btnAI').onclick = () => togglePanel('panelAI');
$('btnGX').onclick = () => togglePanel('panelGX');
$('btnPop').onclick = async () => {
  const r = await api.popOut();
  toast(r === 'ok' ? 'Video popped out.' : r === 'closed' ? 'Pop-out closed.' : r === 'no-video' ? 'No video on this page.' : 'Could not pop out.', r === 'ok' || r === 'closed' ? '' : 'err');
};
$('btnDownloads').onclick = () => togglePanel('panelDownloads');
$('btnShield').onclick = () => togglePanel('panelShield');
$('btnSettings').onclick = () => togglePanel('panelSettings');
$('shield').onclick = () => togglePanel('panelShield');
$('grabBtn').onclick = () => togglePanel('panelMedia');
function togglePanel(id) { const was = $(id).classList.contains('open'); closePanels(); if (!was) openPanel(id); }
// One shortcut table, two callers. The chrome sees keys only while it holds
// focus, so main.js forwards the same descriptor whenever a page has focus —
// otherwise Ctrl+W would work in the omnibar and nowhere else.
function handleShortcut(e) {
  const key = e.key;
  const k = (key || '').toLowerCase();
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const shift = !!e.shiftKey;
  const alt = !!e.altKey;
  const eat = () => { if (e.preventDefault) e.preventDefault(); };
  const ids = () => state.tabs.map((t) => t.id);
  const cycle = (step) => {
    const list = ids();
    if (list.length < 2) return;
    const i = list.indexOf(state.activeId);
    api.activateTab(list[(i + step + list.length) % list.length]);
  };

  // Escape closes whatever is open; with nothing open it stops the load.
  if (key === 'Escape') {
    if (document.querySelector('.panel.open')) closePanels(); else api.stop();
    return;
  }

  // tabs
  if (ctrl && shift && k === 't') { eat(); api.reopenTab(); return; }
  if (ctrl && k === 't') { eat(); api.newTab(); return; }
  if (ctrl && shift && k === 'n') { eat(); api.newPrivateTab(); return; }
  if ((ctrl && k === 'w') || (ctrl && key === 'F4')) {
    eat(); if (state.activeId) api.closeTab(state.activeId); return;
  }
  if (ctrl && k === 'tab') { eat(); cycle(shift ? -1 : 1); return; }
  if (ctrl && key === 'PageDown') { eat(); cycle(1); return; }
  if (ctrl && key === 'PageUp') { eat(); cycle(-1); return; }
  if (ctrl && /^[1-9]$/.test(key)) {
    eat();
    const list = ids();
    const n = Number(key);
    // Ctrl+9 is "last tab", the same as every other browser.
    const target = n === 9 ? list[list.length - 1] : list[n - 1];
    if (target) api.activateTab(target);
    return;
  }

  // navigation
  if (ctrl && k === 'l') { eat(); url.focus(); url.select(); return; }
  if (key === 'F6') { eat(); url.focus(); url.select(); return; }
  if (ctrl && shift && k === 'r') { eat(); api.reload(true); return; }
  if ((ctrl && k === 'r') || key === 'F5') { eat(); api.reload(shift); return; }
  if (alt && key === 'ArrowLeft') { eat(); api.back(); return; }
  if (alt && key === 'ArrowRight') { eat(); api.forward(); return; }
  if (alt && k === 'home') { eat(); api.home(); return; }

  // find
  if ((ctrl && k === 'f') || (ctrl && k === 'g') || key === 'F3') {
    eat();
    if (ctrl && k === 'f') openFind();
    else doFind(!shift, true);
    return;
  }

  // panels
  if (ctrl && k === 'j') { eat(); togglePanel('panelDownloads'); return; }
  if (ctrl && k === 'h') { eat(); togglePanel('panelHistory'); return; }
  if (ctrl && shift && k === 'o') { eat(); togglePanel('panelFavs'); return; }
  if (ctrl && shift && k === 'f') { eat(); openDeep(); return; }
  if (ctrl && k === 'd') { eat(); $('btnStar').click(); return; }
  if (ctrl && k === 'p') { eat(); api.print(); return; }
  if (ctrl && k === 'k') {
    eat();
    if ($('paletteWrap').classList.contains('open')) paletteClose(); else paletteOpen();
    return;
  }
}
document.addEventListener('keydown', handleShortcut);
// Keys that arrived while a page held focus.
api.onShortcut((d) => handleShortcut(Object.assign({ preventDefault() {} }, d)));

// ── media panel ───────────────────────────────────────────────────
async function refreshMedia() {
  const res = await api.mediaList(state.activeId);
  const host = $('mediaList');
  const items = (res && res.items) || [];
  if (!res || !res.enginesReady) {
    $('grabPage').disabled = true;
    host.innerHTML = '<div class="mut pad">Download engines not found.<br>Put <code>yt-dlp.exe</code>, '
      + '<code>gallery-dl.exe</code> and <code>ffmpeg.exe</code> in an <code>engines</code> folder next '
      + 'to the app, or point <code>REDLYNX_ENGINES</code> at a folder that has them.</div>';
    return;
  }
  $('grabPage').disabled = false;
  host.innerHTML = '';

  // ffmpeg is optional but its absence is not cosmetic: without it yt-dlp
  // cannot join the separate video and audio streams sites now serve, so
  // downloads quietly come out at a lower quality than the page was playing.
  // Said here rather than discovered later in a file that looks wrong.
  const eng = (res && res.engines) || {};
  const warn = [];
  if (eng.ffmpeg === false) warn.push('ffmpeg is missing — downloads cannot merge separate video and audio, so quality will be capped.');
  if (eng.gallerydl === false) warn.push('gallery-dl is missing — image galleries cannot be fetched.');
  if (warn.length) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.color = 'var(--warn)';
    note.textContent = warn.join(' ');
    host.appendChild(note);
  }

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mut pad';
    empty.innerHTML = 'No media spotted yet. Try playing the video first — the stream is picked up as it loads.'
      + '<br><br>You can still use “Grab this page’s video” below; the engine understands 1,700+ sites.';
    host.appendChild(empty);
    return;
  }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'item';
    const name = decodeURIComponent((it.url.split('/').pop() || it.url).split('?')[0]).slice(0, 60);
    const dims = it.width && it.height ? (it.width + '×' + it.height) : '';
    row.innerHTML = '<span class="kind ' + it.kind + '">' + it.kind + '</span>' +
      '<div class="meta"><div class="nm"></div><div class="sub"></div></div>' +
      '<button class="btn">⬇</button>';
    row.querySelector('.nm').textContent = name || it.url;
    row.querySelector('.sub').textContent = [dims, it.url].filter(Boolean).join(' · ');
    row.querySelector('button').onclick = async () => {
      await api.grab(it);
      toast('Added to downloads.');
      openPanel('panelDownloads');
    };
    host.appendChild(row);
  });
}
$('grabPage').onclick = async () => {
  await api.grabPage({ url: nav.url, title: (state.tabs.find((t) => t.id === state.activeId) || {}).title });
  toast('Grabbing this page — see Downloads.');
  openPanel('panelDownloads');
};

// ── downloads panel ───────────────────────────────────────────────
function dlRow(d) {
  const row = document.createElement('div');
  row.className = 'item';
  const statusTxt = {
    queued: 'Queued', downloading: (d.progress || 0).toFixed(0) + '%  ' + (d.speed || '') + (d.eta ? '  ETA ' + d.eta : ''),
    converting: 'Merging audio + video…', done: '✓ Done', failed: '✗ ' + (d.error || 'Failed'), canceled: 'Canceled',
  }[d.status] || d.status;
  row.innerHTML =
    '<div class="meta"><div class="nm"></div><div class="sub st-' + d.status + '"></div>' +
    (d.status === 'downloading' ? '<div class="bar"><i style="width:' + (d.progress || 0) + '%"></i></div>' : '') +
    '</div><button class="btn"></button>';
  row.querySelector('.nm').textContent = (d.title || d.url).slice(0, 70);
  row.querySelector('.sub').textContent = statusTxt + (d.size ? '  ·  ' + d.size : '');
  const btn = row.querySelector('button');
  if (d.status === 'done') { btn.textContent = 'Open'; btn.onclick = () => api.openPath(d.file); }
  else if (d.status === 'failed' || d.status === 'canceled') { btn.textContent = 'Retry'; btn.onclick = () => api.retryDownload(d.id); }
  else { btn.textContent = 'Stop'; btn.onclick = () => api.cancelDownload(d.id); }
  return row;
}
async function refreshDownloads(list) {
  const items = list || (await api.downloads());
  const host = $('dlList');
  host.innerHTML = '';
  if (!items.length) { host.innerHTML = '<div class="mut pad">Nothing downloaded yet.</div>'; }
  else items.slice().reverse().forEach((d) => host.appendChild(dlRow(d)));
  const dir = await api.downloadDir();
  $('dlDir').textContent = dir;
}
$('openDlDir').onclick = async () => api.openPath(await api.downloadDir());

// ── settings / prefs ──────────────────────────────────────────────
function bindPrefs() {
  document.querySelectorAll('[data-pref]').forEach((el) => {
    const key = el.dataset.pref;
    el.onchange = () => {
      const val = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      api.setPrefs({ [key]: val });
    };
  });
}
function renderPrefs() {
  gxLabels();
  refreshAnon();
  applyBg();
  applyTheme();
  renderPins();
  renderBM();
  document.querySelectorAll('[data-pref]').forEach((el) => {
    const v = prefs[el.dataset.pref];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
  });
}
async function refreshSettings() {
  const sel = $('engineSel');
  if (sel && !sel.options.length) {
    (await api.enginesList()).forEach((e) => {
      const o = document.createElement('option');
      o.value = e.id; o.textContent = e.name;
      sel.appendChild(o);
    });
    sel.value = prefs.searchEngine || 'google';
  }
  showZoom();
  $('dlDir2').textContent = await api.downloadDir();
  const ready = await api.enginesReady();
  $('engineState').textContent = ready
    ? 'Download engines: ready (yt-dlp + gallery-dl + ffmpeg).'
    : 'Download engines missing — put yt-dlp.exe, gallery-dl.exe and ffmpeg.exe in an “engines” folder next to the app.';
  const v = await api.vaultList();
  const host = $('vaultList');
  if (!v.length) { host.className = 'mut'; host.textContent = 'None saved.'; return; }
  host.className = '';
  host.innerHTML = '';
  v.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<div class="meta"><div class="nm"></div><div class="sub"></div></div><button class="btn">Forget</button>';
    row.querySelector('.nm').textContent = e.host;
    row.querySelector('.sub').textContent = (e.kind || 'password') + (e.username ? ' · ' + e.username : '');
    row.querySelector('button').onclick = async () => { await api.vaultForget(e.host); refreshSettings(); };
    host.appendChild(row);
  });
}
$('clearData').onclick = async () => { await api.clearBrowsingData(); toast('Cookies and cache cleared.'); };

// ── reader mode ───────────────────────────────────────────────────
async function toggleReader() {
  const r = await api.readerToggle();
  if (r && r.ok) {
    $('btnReader').classList.toggle('off', !r.on);
  } else {
    toast((r && r.error) || 'Reader mode could not open this page.', 'err');
  }
}
$('btnReader').onclick = toggleReader;

// ── command palette ───────────────────────────────────────────────
// Everything the toolbar can do, reachable without knowing where it lives or
// whether it happens to be pinned. Ctrl+K works from the page too, because a
// palette you can only open when the chrome has focus is not much of one.
function commands() {
  return [
    { icon: '🗋', name: 'New tab', key: 'Ctrl+T', run: () => api.newTab() },
    { icon: '🕶', name: 'New private tab', key: 'Ctrl+Shift+N', run: () => api.newPrivateTab() },
    { icon: '✕', name: 'Close tab', key: 'Ctrl+W', run: () => api.closeTab(state.activeId) },
    { icon: '⟳', name: 'Reload page', key: 'F5', run: () => api.reload() },
    { icon: '⌂', name: 'Home', run: () => api.home() },
    { icon: '🔎', name: 'Find on page', key: 'Ctrl+F', run: () => openFind() },
    { icon: '🌐', name: 'Deep search (every index at once)', key: 'Ctrl+Shift+F', run: () => openDeep() },
    { icon: '💤', name: 'Suspend other tabs', run: async () => { await api.suspendOthers(); toast('Other tabs suspended.'); } },
    { icon: '⚙', name: 'Settings', run: () => openPanel('panelSettings') },
    { icon: '🛡', name: 'Protection', run: () => openPanel('panelShield') },
    { icon: '📥', name: 'Downloads', key: 'Ctrl+J', run: () => openPanel('panelDownloads') },
    { icon: '🕘', name: 'History', key: 'Ctrl+H', run: () => openPanel('panelHistory') },
    { icon: '★', name: 'Favorites', run: () => openPanel('panelFavs') },
    { icon: '⬇', name: 'Media on this page', run: () => openPanel('panelMedia') },
    { icon: '🎛', name: 'Control — CPU, RAM & network limits', run: () => openPanel('panelGX') },
    { icon: '🕵', name: 'Anonymity — proxy & encrypted DNS', run: () => openPanel('panelAnon') },
    { icon: '⧉', name: 'Pop out video (picture-in-picture)', run: () => api.popOut() },
    { icon: '📖', name: 'Reader mode', run: () => toggleReader() },
    { icon: '✦', name: (prefs.hideAiOverview !== false ? 'Show' : 'Hide') + " Google's AI Overview",
      run: () => $('btnAio').click() },
    { icon: '↻', name: 'Refresh filter lists', run: () => $('refreshLists').click() },
    { icon: '⬆', name: 'Check for updates', run: () => { openPanel('panelSettings'); setTimeout(() => $('updCheck').click(), 200); } },
  ];
}

let palCmds = [];
let palSel = 0;

function paletteOpen() {
  palCmds = commands();
  palSel = 0;
  $('paletteInput').value = '';
  renderPalette();
  $('paletteWrap').classList.add('open');
  syncOverlay();
  $('paletteInput').focus();
}

function paletteClose() {
  $('paletteWrap').classList.remove('open');
  syncOverlay();
}

function filterCmds(q) {
  const s = q.toLowerCase().trim();
  if (!s) return commands();
  // Every letter in order, not necessarily adjacent — "nprv" finds "New private tab".
  return commands().filter((c) => {
    const n = c.name.toLowerCase();
    let i = 0;
    for (const ch of s) {
      i = n.indexOf(ch, i);
      if (i === -1) return false;
      i++;
    }
    return true;
  });
}

function renderPalette() {
  const host = $('paletteList');
  host.innerHTML = '';
  if (!palCmds.length) {
    host.innerHTML = '<div class="pempty">Nothing matches.</div>';
    return;
  }
  palCmds.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'pcmd' + (i === palSel ? ' sel' : '');
    row.innerHTML = '<div class="pi"></div><div class="pn"></div><div class="pk"></div>';
    row.querySelector('.pi').textContent = c.icon || '›';
    row.querySelector('.pn').textContent = c.name;
    row.querySelector('.pk').textContent = c.key || '';
    row.addEventListener('mousedown', (e) => { e.preventDefault(); runCmd(c); });
    host.appendChild(row);
  });
}

function runCmd(c) {
  paletteClose();
  try { c.run(); } catch (e) {}
}

$('paletteInput').addEventListener('input', () => {
  palCmds = filterCmds($('paletteInput').value);
  palSel = 0;
  renderPalette();
});

$('paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    palSel += e.key === 'ArrowDown' ? 1 : -1;
    if (palSel < 0) palSel = palCmds.length - 1;
    if (palSel >= palCmds.length) palSel = 0;
    renderPalette();
    return;
  }
  if (e.key === 'Enter') { if (palCmds[palSel]) runCmd(palCmds[palSel]); return; }
  if (e.key === 'Escape') paletteClose();
});

$('paletteWrap').addEventListener('mousedown', (e) => {
  if (e.target === $('paletteWrap')) paletteClose();
});

api.onPalette(() => paletteOpen());

// ── site permissions ──────────────────────────────────────────────
const PERM_NAMES = {
  media: 'Camera & microphone', geolocation: 'Location', notifications: 'Notifications',
  midi: 'MIDI', midiSysex: 'MIDI (SysEx)', pointerLock: 'Hide the cursor',
  openExternal: 'Open other apps', 'window-management': 'Manage windows',
  'clipboard-read': 'Read the clipboard', 'display-capture': 'Capture the screen',
  'idle-detection': 'Detect when idle', hid: 'HID devices', serial: 'Serial devices', usb: 'USB devices',
};

async function refreshPerms() {
  const host = $('permList');
  if (!host) return;
  let items = [];
  try { items = await api.permList(); } catch (e) {}
  host.innerHTML = '';
  if (!items.length) { host.textContent = 'Nothing decided yet.'; return; }
  items.forEach((x) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<div class="meta"><div class="nm"></div><div class="sub"></div></div><button class="btn">Forget</button>';
    row.querySelector('.nm').textContent = x.host;
    const sub = row.querySelector('.sub');
    sub.textContent = (PERM_NAMES[x.permission] || x.permission) + ' — ' + (x.allowed ? 'allowed' : 'blocked');
    sub.style.color = x.allowed ? 'var(--ok)' : 'var(--err)';
    row.querySelector('button').onclick = async () => {
      await api.permForget(x.host, x.permission);
      toast('Forgotten — this site will ask again.');
      refreshPerms();
    };
    host.appendChild(row);
  });
}

// ── updates ───────────────────────────────────────────────────────
function renderUpdate(u) {
  const line = $('updStatus');
  const act = $('updAction');
  if (!line || !u) return;
  act.style.display = 'none';
  const v = 'Redlynx ' + (u.current || '?');
  if (u.status === 'checking')      line.textContent = 'Checking…';
  else if (u.status === 'available') {
    line.textContent = 'Version ' + u.version + ' is available. You are on ' + u.current + '.';
    act.textContent = 'Download update';
    act.style.display = '';
    act.onclick = async () => { renderUpdate(await api.updateDownload()); };
  } else if (u.status === 'downloading') {
    line.textContent = 'Downloading… ' + (u.percent || 0) + '%';
  } else if (u.status === 'ready') {
    line.textContent = 'Version ' + u.version + ' is ready. It installs when you quit.';
    act.textContent = 'Restart and install';
    act.style.display = '';
    act.onclick = () => api.updateInstall();
  } else if (u.status === 'unpackaged') {
    line.textContent = v + ' — running from source, so there is nothing to update.';
  } else if (u.status === 'error') {
    line.textContent = 'Could not check: ' + u.error;
  } else {
    line.textContent = v + ' — up to date.';
  }
}

$('updCheck').onclick = async () => {
  renderUpdate({ status: 'checking' });
  renderUpdate(await api.updateCheck());
};
api.onUpdate((u) => renderUpdate(u));

// ── extensions ────────────────────────────────────────────────────
async function refreshExtensions() {
  const host = $('extList');
  if (!host) return;
  let r = { items: [], failures: [] };
  try { r = await api.extList(); } catch (e) {}
  host.innerHTML = '';
  if (!r.items.length && !r.failures.length) {
    host.textContent = 'None loaded.';
    return;
  }
  r.items.forEach((x) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<div class="meta"><div class="nm"></div><div class="sub"></div></div><button class="btn">Remove</button>';
    row.querySelector('.nm').textContent = x.name + (x.version ? ' ' + x.version : '');
    row.querySelector('.sub').textContent = x.path;
    row.querySelector('button').onclick = async () => {
      await api.extRemove(x.id);
      toast('Removed — restart to fully unload.');
      refreshExtensions();
    };
    host.appendChild(row);
  });
  // A folder that moved or was deleted is said out loud, not dropped quietly.
  r.failures.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<div class="meta"><div class="nm"></div><div class="sub"></div></div>';
    row.querySelector('.nm').textContent = 'Failed to load';
    row.querySelector('.nm').style.color = 'var(--err)';
    row.querySelector('.sub').textContent = f.path + ' — ' + f.error;
    host.appendChild(row);
  });
}

$('extAdd').onclick = async () => {
  const r = await api.extAdd();
  if (r && r.canceled) return;
  toast(r && r.ok ? ('Loaded ' + r.name) : ('Could not load: ' + ((r && r.error) || 'unknown')),
        r && r.ok ? '' : 'err');
  refreshExtensions();
};

// ── ask-first prompts ─────────────────────────────────────────────
function showPrompt(p) {
  const wrap = $('promptWrap');
  const btns = $('promptBtns');
  btns.innerHTML = '';
  if (p.type === 'save') {
    const what = p.kind === 'card' ? 'card details' : 'password';
    $('promptTitle').textContent = 'Save this ' + what + '?';
    $('promptText').textContent = 'Redlynx has not saved anything yet. ' + p.host +
      (p.username ? ' · ' + p.username : '') + '. Nothing is written to disk unless you choose Save.';
    addBtn(btns, 'Never for this site', 'never');
    addBtn(btns, 'Not now', 'dismiss');
    addBtn(btns, 'Save', 'save', true);
  } else {
    const nice = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'send notifications',
      'display-capture': 'capture your screen', midi: 'use MIDI devices', 'clipboard-read': 'read your clipboard' };
    $('promptTitle').textContent = p.host + ' wants permission';
    $('promptText').textContent = 'This site is asking to ' + (nice[p.permission] || p.permission) +
      '. Denied unless you allow it. Your answer is remembered for this site — ' +
      'change it under Settings.';
    // Both answers stick, which is what stops the same dialog appearing on
    // every page load. Settings lists them so a choice can be taken back.
    addBtn(btns, 'Block', 'never');
    addBtn(btns, 'Allow', 'always', true);
  }
  wrap.classList.add('open');
  wrap._id = p.id;
  syncOverlay();
}
function addBtn(host, label, answer, accent) {
  const b = document.createElement('button');
  b.className = 'btn' + (accent ? ' accent' : '');
  b.textContent = label;
  b.onclick = async () => {
    const wrap = $('promptWrap');
    wrap.classList.remove('open');
    syncOverlay();
    await api.answerPrompt(wrap._id, answer);
  };
  host.appendChild(b);
}






// ── protection panel ──────────────────────────────────────────────
async function refreshShield() {
  try {
    const st = await api.blockStatus();
    const when = st.at ? new Date(st.at).toLocaleString() : 'not loaded';
    $('listStatus').textContent = 'Source: ' + (st.source || 'none') + ' · loaded ' + when;
  } catch (e) {}
}
$('refreshLists').onclick = async () => {
  const b = $('refreshLists');
  b.disabled = true; b.textContent = '↻ Fetching…';
  const r = await api.blockRefresh();
  b.disabled = false; b.textContent = '↻ Refresh filter lists';
  toast(r && r.ok ? 'Filter lists updated.' : 'Could not update lists.', r && r.ok ? '' : 'err');
  refreshShield();
};

// ── pinned toolbar: only what the user chose is on the bar ────────
// ── Google AI Overview toggle ─────────────────────────────────────
// The chip shows the state at a glance: lit means the overview is showing,
// dimmed means it is hidden and the results start at the top.
function syncAio() {
  const btn = $('btnAio');
  if (!btn) return;
  const hidden = prefs.hideAiOverview !== false;
  btn.classList.toggle('off', hidden);
  btn.title = hidden
    ? 'Google AI Overview is hidden — click to show it'
    : 'Google AI Overview is showing — click to hide it';
}

$('btnAio').onclick = async () => {
  const hidden = prefs.hideAiOverview !== false;
  prefs.hideAiOverview = hidden ? false : true;
  await api.setPrefs({ hideAiOverview: prefs.hideAiOverview });
  syncAio();
  toast(prefs.hideAiOverview ? 'AI Overview hidden.' : 'AI Overview showing.');
  // Take effect on what is already on screen, not just the next search.
  if (/google\.[a-z.]+\/search/i.test(nav.url || '')) api.reload();
};

function renderPins() {
  const us = prefs.userscripts || {};
  document.querySelectorAll('[data-us]').forEach((cb) => { cb.checked = us[cb.dataset.us] !== false; });
  syncAio();
  const pins = prefs.pinned || {};
  document.querySelectorAll('[data-tool]').forEach((el) => {
    el.classList.toggle('pinned', !!pins[el.dataset.tool]);
  });
  document.querySelectorAll('[data-pin]').forEach((cb) => { cb.checked = !!pins[cb.dataset.pin]; });
}
(function wireUserscripts() {
  document.querySelectorAll('[data-us]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const us = { ...(prefs.userscripts || {}), [cb.dataset.us]: cb.checked };
      prefs.userscripts = us;
      await api.setPrefs({ userscripts: us });
      toast(cb.checked ? 'Enabled — reload the page.' : 'Disabled — reload the page.');
    });
  });
})();

(function wirePins() {
  document.querySelectorAll('[data-pin]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const pins = { ...(prefs.pinned || {}), [cb.dataset.pin]: cb.checked };
      prefs.pinned = pins;
      renderPins();
      await api.setPrefs({ pinned: pins });
    });
  });
  // "Open" buttons make unpinned tools reachable from Settings
  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', (e) => { e.preventDefault(); openPanel(b.dataset.open); });
  });
})();





// ── background (image / GIF) ──────────────────────────────────────
async function applyBg() {
  const el = $('chromeBg');
  const url = await api.bgUrl();
  const on = !!url && !!prefs.bgApplyChrome;
  document.body.classList.toggle('hasbg', on);
  el.style.backgroundImage = on ? ('url("' + url + '")') : 'none';
  el.style.opacity = on ? (Number(prefs.bgOpacity || 45) / 100) : 0;
  el.style.filter = prefs.bgBlur ? ('blur(' + prefs.bgBlur + 'px)') : 'none';
  const o = $('bgOpacityVal'), b = $('bgBlurVal');
  if (o) o.textContent = (prefs.bgOpacity || 45) + '%';
  if (b) b.textContent = (prefs.bgBlur || 0) + 'px';
}
$('bgPick').onclick = async () => {
  const r = await api.bgPick();
  if (r && r.ok) { toast('Background set.'); applyBg(); }
};
$('bgClear').onclick = async () => { await api.bgClear(); toast('Background cleared.'); applyBg(); };
['bgOpacityRange', 'bgBlurRange'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('input', () => { prefs[el.dataset.pref] = Number(el.value); applyBg(); });
});

// ── anonymity panel ───────────────────────────────────────────────
async function refreshAnon() {
  const sel = $('dohSel');
  if (sel && !sel.options.length) {
    (await api.anonDoh()).forEach((d) => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      sel.appendChild(o);
    });
    sel.value = prefs.dohProvider || 'quad9';
  }
  // manual host/port only matter when not using the Tor preset
  const manual = $('proxyManual');
  if (manual) manual.style.display = (prefs.proxyMode === 'tor') ? 'none' : 'flex';
}
$('newPrivate').onclick = () => { api.newPrivateTab(); closePanels(); };
$('anonApply').onclick = async () => {
  const r = await api.anonApply();
  $('anonResult').textContent = r && r.ok
    ? ('Applied. Routing: ' + (r.mode === 'direct' ? 'direct (no proxy)' : r.mode))
    : ('Could not apply: ' + ((r && r.error) || 'unknown'));
  toast(r && r.ok ? 'Network settings applied.' : 'Could not apply settings.', r && r.ok ? '' : 'err');
};
$('anonCheck').onclick = async () => {
  $('anonResult').textContent = 'Checking…';
  const r = await api.anonCheckIp();
  $('anonResult').textContent = r && r.ok
    ? ('Sites currently see: ' + r.ip)
    : ('Check failed: ' + ((r && r.error) || 'unknown'));
};
$('btnAnon').onclick = () => togglePanel('panelAnon');

// ── find in page ──────────────────────────────────────────────────
const findBar = $('findbar'), findInput = $('findInput');
let findTerm = '';
function openFind() {
  findBar.classList.add('on');
  findInput.focus(); findInput.select();
  if (findInput.value) doFind(true, false);
}
function closeFind() {
  findBar.classList.remove('on');
  $('findCount').textContent = '';
  api.findStop(false);
}
function doFind(forward, next) {
  const t = findInput.value;
  if (!t) { $('findCount').textContent = ''; api.findStop(false); return; }
  findTerm = t;
  api.findStart(t, forward, next);
}
findInput.addEventListener('input', () => doFind(true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, true); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findNext').onclick = () => doFind(true, true);
$('findPrev').onclick = () => doFind(false, true);
$('findClose').onclick = closeFind;
api.onFindResult((r) => {
  $('findCount').textContent = r.total ? (r.active + ' / ' + r.total) : 'no matches';
});
api.onOpenFind(openFind);

// ── history ───────────────────────────────────────────────────────
function whenTxt(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
  return new Date(ms).toLocaleDateString();
}
async function refreshHistory() {
  const list = await api.histSearch($('histSearch').value);
  const host = $('histList');
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = '<div class="mut pad">Nothing here.</div>'; return; }
  list.slice(0, 200).forEach((h) => {
    const row = document.createElement('div');
    row.className = 'histrow';
    row.innerHTML = '<div class="ht"><div class="t"></div><div class="u"></div></div>' +
                    '<span class="hw"></span><button class="btn mini">✕</button>';
    row.querySelector('.t').textContent = h.title || h.url;
    row.querySelector('.u').textContent = h.url;
    row.querySelector('.hw').textContent = whenTxt(h.at);
    row.querySelector('.ht').onclick = () => { api.newTab(h.url); closePanels(); };
    row.querySelector('button').onclick = async () => { await api.histRemove(h.url); refreshHistory(); };
    host.appendChild(row);
  });
}
$('histSearch').addEventListener('input', () => refreshHistory());
document.querySelectorAll('[data-clear]').forEach((b) => {
  b.onclick = async () => {
    await api.histClear(Number(b.dataset.clear));
    refreshHistory();
    toast('History cleared.');
  };
});
$('btnHistory').onclick = () => togglePanel('panelHistory');

// ── zoom ──────────────────────────────────────────────────────────
async function showZoom() { $('zoomVal').textContent = (await api.zoomGet()) + '%'; }
$('zoomIn').onclick = async () => { await api.zoomSet(1); showZoom(); };
$('zoomOut').onclick = async () => { await api.zoomSet(-1); showZoom(); };
$('zoomReset').onclick = async () => { await api.zoomSet(0); showZoom(); };

// ── import bookmarks ──────────────────────────────────────────────
$('importBm').onclick = async () => {
  const r = await api.importBookmarks();
  if (r && r.ok) { toast('Imported ' + r.count + ' bookmarks.'); renderBM(); }
  else toast((r && r.error) || 'Nothing to import.', 'err');
};

// ── things the main process asks the UI to do ─────────────────────
api.onDoBookmark(() => $('btnStar').click());
api.onOpenPanel((p) => openPanel(p.id));

// ── bookmarks bar ─────────────────────────────────────────────────
const bmMenu = $('bmMenu');
function closeMenu() { bmMenu.classList.remove('on'); bmMenu.innerHTML = ''; }
document.addEventListener('click', (e) => { if (!bmMenu.contains(e.target)) closeMenu(); }, true);

function showMenu(x, y, items) {
  bmMenu.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { const d = document.createElement('div'); d.className = 'sepm'; bmMenu.appendChild(d); return; }
    if (it.header) { const h = document.createElement('div'); h.className = 'hdr'; h.textContent = it.header; bmMenu.appendChild(h); return; }
    const el = document.createElement('div');
    el.className = 'mi' + (it.danger ? ' danger' : '');
    el.textContent = it.label;
    el.onclick = (ev) => { ev.stopPropagation(); closeMenu(); it.run && it.run(); };
    bmMenu.appendChild(el);
  });
  bmMenu.classList.add('on');
  const w = bmMenu.offsetWidth || 200;
  bmMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 8)) + 'px';
  bmMenu.style.top = y + 'px';
}

async function itemMenu(x, y, node) {
  const folders = await api.bmFolders();
  const items = [];
  if (node.type === 'link') {
    items.push({ label: 'Open', run: () => api.go(node.url) });
    items.push({ label: 'Open in new tab', run: () => api.newTab(node.url) });
    items.push({ sep: true });
  }
  items.push({ label: 'Rename…', run: () => startRename(node) });
  if (node.type === 'link') {
    const others = folders.filter((f) => f.id !== node.id);
    if (others.length) {
      items.push({ sep: true }, { header: 'Move to folder' });
      others.forEach((f) => items.push({ label: '📁 ' + f.title, run: async () => { await api.bmMoveTo(node.id, f.id); renderBM(); } }));
      items.push({ label: '↥ Bar (top level)', run: async () => { await api.bmMoveTo(node.id, null); renderBM(); } });
    }
  }
  items.push({ sep: true }, { label: 'Delete', danger: true, run: async () => { await api.bmRemove(node.id); renderBM(); syncStar(); } });
  showMenu(x, y, items);
}

// inline rename, so there is no blocking dialog
function startRename(node) {
  const el = document.querySelector('.bmitem[data-id="' + node.id + '"] .lb');
  if (!el) return;
  const input = document.createElement('input');
  input.className = 'num';
  input.style.cssText = 'width:130px;height:20px;font-size:12px;padding:0 6px';
  input.value = node.title;
  el.replaceWith(input);
  input.focus(); input.select();
  const commit = async () => { await api.bmRename(node.id, input.value.trim() || node.title); renderBM(); };
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderBM(); };
  input.onblur = commit;
}

async function renderBM() {
  const bar = $('bmbar');
  bar.classList.toggle('on', !!prefs.showBookmarksBar);
  if (!prefs.showBookmarksBar) return;
  const tree = await api.bmTree();
  const host = $('bmItems');
  host.innerHTML = '';
  if (!tree.length) {
    host.innerHTML = '<span class="bmempty">No bookmarks yet — press ☆ in the address bar to add this page.</span>';
    return;
  }
  tree.forEach((node) => {
    const el = document.createElement('div');
    el.className = 'bmitem';
    el.dataset.id = node.id;
    const icon = node.type === 'folder' ? '📁' : '🔖';
    el.innerHTML = '<span class="ic">' + icon + '</span><span class="lb"></span>';
    el.querySelector('.lb').textContent = node.title;
    el.title = node.type === 'folder' ? (node.children || []).length + ' item(s)' : node.url;
    el.onclick = (e) => {
      e.stopPropagation();
      if (node.type === 'link') return api.go(node.url);
      const kids = node.children || [];
      const r = el.getBoundingClientRect();
      if (!kids.length) return showMenu(r.left, r.bottom + 2, [{ label: '(empty folder)' }]);
      showMenu(r.left, r.bottom + 2, kids.map((k) => ({
        label: k.title, run: () => api.go(k.url),
      })).concat([{ sep: true }, { header: 'Folder' },
        { label: 'Rename folder…', run: () => startRename(node) },
        { label: 'Delete folder', danger: true, run: async () => { await api.bmRemove(node.id); renderBM(); } }]));
    };
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); itemMenu(e.clientX, e.clientY, node); };
    host.appendChild(el);
  });
}

$('bmNewFolder').onclick = async (e) => {
  e.stopPropagation();
  const host = $('bmItems');
  const input = document.createElement('input');
  input.className = 'num';
  input.style.cssText = 'width:140px;height:22px;font-size:12px;padding:0 6px';
  input.placeholder = 'Folder name';
  host.appendChild(input);
  input.focus();
  const commit = async () => {
    const v = input.value.trim();
    if (v) await api.bmAddFolder(v);
    renderBM();
  };
  input.onkeydown = (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') renderBM(); };
  input.onblur = commit;
};

// ── favorites ─────────────────────────────────────────────────────
async function refreshFavs() {
  const list = await api.favList();
  const host = $('favList');
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = '<div class="mut pad">No favorites yet. Use ☆ in the address bar.</div>'; return; }
  list.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<div class="meta"><div class="nm"></div><div class="sub"></div></div><button class="btn mini">✕</button>';
    row.querySelector('.nm').textContent = f.title || f.url;
    row.querySelector('.sub').textContent = f.url;
    row.querySelector('.meta').style.cursor = 'pointer';
    row.querySelector('.meta').onclick = () => { api.newTab(f.url); closePanels(); };
    row.querySelector('button').onclick = async () => { await api.favRemove(f.url); refreshFavs(); renderBM(); syncStar(); };
    host.appendChild(row);
  });
}
async function syncStar() {
  const on = await api.favIsSaved();
  const st = $('btnStar');
  if (st) { st.textContent = on ? '★' : '☆'; st.classList.toggle('on', on); st.title = on ? 'Saved to favorites' : 'Save to favorites'; }
}
$('btnStar').onclick = async () => {
  const r = await api.favAdd();
  if (r && r.error) return toast(r.error, 'err');
  toast(r.already ? 'Already bookmarked.' : 'Bookmarked.');
  syncStar(); renderBM();
};
$('favAdd').onclick = async () => { await api.favAdd(); refreshFavs(); syncStar(); renderBM(); toast('Bookmarked.'); };
$('btnFavs').onclick = () => togglePanel('panelFavs');

// ── theme ─────────────────────────────────────────────────────────
function applyTheme() {
  const t = prefs.theme || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'rgb') {
    // hand the accent over to the keyframe animation
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent2');
  } else {
    const a = prefs.accent || '#e63946';
    document.documentElement.style.setProperty('--accent', a);
    document.documentElement.style.setProperty('--accent2', lighten(a, 22));
  }
  // the accent picker is meaningless while the rainbow is running
  const sw = document.querySelector('[data-pref="accent"]');
  if (sw) sw.disabled = (t === 'rgb');
}
function lighten(hex, pct) {
  try {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const cl = (v) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * (pct / 100))));
    return '#' + [cl((n >> 16) & 255), cl((n >> 8) & 255), cl(n & 255)]
      .map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch (e) { return hex; }
}

// ── Control: limiters + hot tabs ──────────────────────────────────
function gxLabels() {
  const cpu = Number(prefs.cpuLimit) || 100;
  const ram = Number(prefs.ramLimit) || 0;
  const net = Number(prefs.netLimit) || 0;
  const c = $('cpuVal'), r = $('ramVal'), n = $('netVal');
  if (c) c.textContent = cpu >= 100 ? '100% (full)' : cpu + '%';
  if (r) r.textContent = ram ? (ram >= 1000 ? (ram / 1000).toFixed(1) + ' GB' : ram + ' MB') : 'Off';
  if (n) n.textContent = net ? net + ' Mbps' : 'Unlimited';
}
let gxTimer = null;
async function refreshGX() {
  gxLabels();
  const hot = await api.hotTabs();
  const mem = $('gxMem');
  if (mem) mem.textContent = (hot.totalMb >= 1000 ? (hot.totalMb / 1000).toFixed(1) + ' GB' : hot.totalMb + ' MB') + ' in use';
  const host = $('hotList');
  host.innerHTML = '';
  if (!hot.rows.length) { host.innerHTML = '<div class="mut pad">No tabs.</div>'; }
  hot.rows.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'hot';
    el.innerHTML = '<span class="hn"></span><span class="hc"></span><span class="hm"></span><button></button>';
    el.querySelector('.hn').textContent = (t.suspended ? '💤 ' : '') + (t.title || 'Tab');
    el.querySelector('.hc').textContent = t.cpu ? t.cpu + '%' : '—';
    el.querySelector('.hm').textContent = t.memMb ? t.memMb + ' MB' : '';
    const b = el.querySelector('button');
    b.textContent = t.suspended ? 'Wake' : 'Suspend';
    b.onclick = async () => { if (t.suspended) await api.activateTab(t.id); else await api.suspendTab(t.id); refreshGX(); };
    host.appendChild(el);
  });
  clearTimeout(gxTimer);
  if ($('panelGX').classList.contains('open')) gxTimer = setTimeout(refreshGX, 2500);
}
// live labels while dragging, save on release
['cpuRange', 'ramRange', 'netRange'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    prefs[el.dataset.pref] = Number(el.value);
    gxLabels();
  });
});


// live theme preview while choosing
(function () {
  const sel = document.querySelector('[data-pref="theme"]');
  if (sel) sel.addEventListener('change', () => { prefs.theme = sel.value; applyTheme(); });
  const sw = document.querySelector('[data-pref="accent"]');
  if (sw) sw.addEventListener('input', () => { prefs.accent = sw.value; applyTheme(); });
  const rst = document.getElementById('resetAccent');
  if (rst) rst.onclick = () => { prefs.accent = '#e63946'; applyTheme(); api.setPrefs({ accent: '#e63946' }); };
})();

// ── AI panel (does nothing at all unless the user switched AI on) ──
async function refreshAI(msg) {
  const st = await api.aiStatus();
  const body = $('aiBody');
  if (!st.enabled) {
    body.innerHTML = '<div class="mut pad">AI is <b>off</b>.<br><br>Nothing AI-related runs and no page content leaves this machine while it is off.<br><br>Turn it on in Settings if you want it.</div>';
    $('aiSummarize').disabled = true;
    return;
  }
  $('aiSummarize').disabled = false;
  if (!st.hasKey) {
    body.innerHTML = '<div class="mut pad">AI is on, but no API key is set.<br><br>Add your provider key in Settings.</div>';
    $('aiSummarize').disabled = true;
    return;
  }
  body.innerHTML = msg || '<div class="mut pad">Ready. Summarise the page you are on, and the text is sent to your provider only when you ask.</div>';
}
$('aiSummarize').onclick = async () => {
  await refreshAI('<div class="mut pad">Reading the page…</div>');
  const r = await api.aiAsk('Summarise this page in a few clear bullet points.');
  if (r && r.text) {
    const out = document.createElement('div');
    out.className = 'ai-out';
    out.textContent = r.text;
    $('aiBody').innerHTML = '';
    $('aiBody').appendChild(out);
  } else {
    await refreshAI('<div class="mut pad">' + ((r && r.error) || 'Something went wrong.') + '</div>');
  }
};
$('aiSettings').onclick = () => openPanel('panelSettings');

// ── toast ─────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text, kind) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

// ── events ────────────────────────────────────────────────────────
api.onTabs((s) => { state = s; renderTabs(); });
api.onNav((n) => { nav = n; renderNav(); syncStar(); });
api.onPrefs((p) => { prefs = p; renderPrefs(); });
api.onDownloads((list) => { if ($('panelDownloads').classList.contains('open')) refreshDownloads(list); });
api.onPrompt(showPrompt);
api.onToast((t) => toast(t.text, t.kind));
api.onFocusUrl(() => { url.focus(); url.select(); });

(async function init() {
  bindPrefs();
  prefs = await api.getPrefs(); renderPrefs();
  state = await api.tabState(); renderTabs();
  nav = await api.navState(); renderNav();
  renderPins(); syncStar(); renderBM();
  // main pushes nav on every real change, so this is only a safety net
  setInterval(async () => { nav = await api.navState(); renderNav(); }, 5000);
})();

// ── deep search ───────────────────────────────────────────────────
// One query against every index at once. Sources that refuse to answer say
// so on the line — a rate-limited engine looks identical to an empty result
// otherwise, and that is exactly the kind of silence worth naming.
let deepPicked = null;   // null = every source

function openDeep(prefill) {
  closePanels();
  openPanel('panelDeep');
  const q = $('deepQ');
  if (prefill) q.value = prefill;
  q.focus();
  q.select();
}

async function runDeep() {
  const q = $('deepQ').value.trim();
  if (!q) return;
  const list = $('deepList');
  const status = $('deepSources');
  status.textContent = 'Searching every index…';
  list.replaceChildren();

  let res;
  try {
    res = await api.deepSearch(q, deepPicked);
  } catch (e) {
    status.textContent = 'Search failed: ' + (e && e.message ? e.message : e);
    return;
  }

  const ok = res.sources.filter((s) => s.ok);
  const bad = res.sources.filter((s) => !s.ok);
  status.replaceChildren();
  const line = document.createElement('div');
  line.textContent = res.results.length + ' results from ' + ok.length + ' of '
    + res.sources.length + ' sources'
    + (ok.length ? ' — ' + ok.map((s) => s.name + ' ' + s.count).join(', ') : '');
  status.appendChild(line);
  if (bad.length) {
    const warn = document.createElement('div');
    warn.style.color = 'var(--warn)';
    warn.textContent = 'no answer: ' + bad.map((s) => s.name + ' (' + (s.error || 'failed') + ')').join(', ');
    status.appendChild(warn);
  }

  if (!res.results.length) {
    const none = document.createElement('div');
    none.className = 'mut pad';
    none.textContent = 'Nothing came back. Try fewer words, or a bare domain for the archive sources.';
    list.appendChild(none);
    return;
  }

  for (const r of res.results) {
    const row = document.createElement('div');
    row.className = 'row deep';
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'deepTitle';
    a.textContent = r.title;
    a.title = r.url;
    a.onclick = (e) => { e.preventDefault(); api.newTab(r.url); };
    const meta = document.createElement('div');
    meta.className = 'mut';
    meta.style.fontSize = '11px';
    // Two independent indexes agreeing is the strongest signal available.
    meta.textContent = r.sources.join(' + ') + ' · ' + r.url.slice(0, 80);
    row.appendChild(a);
    row.appendChild(meta);
    if (r.snippet) {
      const sn = document.createElement('div');
      sn.style.fontSize = '11px';
      sn.style.opacity = '0.85';
      sn.textContent = r.snippet.slice(0, 220);
      row.appendChild(sn);
    }
    list.appendChild(row);
  }
}

async function pickDeepSources() {
  const all = await api.deepSources();
  const list = $('deepList');
  list.replaceChildren();
  const head = document.createElement('div');
  head.className = 'mut';
  head.style.marginBottom = '6px';
  head.textContent = 'Choose which indexes to search. Unticked sources are skipped.';
  list.appendChild(head);
  for (const s of all) {
    const lab = document.createElement('label');
    lab.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !deepPicked || deepPicked.includes(s.id);
    cb.onchange = () => {
      const ids = all.filter((x) => document.getElementById('deepsrc-' + x.id).checked).map((x) => x.id);
      deepPicked = ids.length === all.length ? null : ids;
    };
    cb.id = 'deepsrc-' + s.id;
    const txt = document.createElement('span');
    const strong = document.createElement('b');
    strong.textContent = s.name;
    const why = document.createElement('div');
    why.className = 'mut';
    why.style.fontSize = '11px';
    why.textContent = s.why;
    txt.appendChild(strong);
    txt.appendChild(why);
    lab.appendChild(cb);
    lab.appendChild(txt);
    list.appendChild(lab);
  }
}

$('deepGo').onclick = runDeep;
$('deepPick').onclick = pickDeepSources;
$('deepQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') runDeep(); });
