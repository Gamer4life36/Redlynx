/**
 * Built-in media downloader.
 *
 * The thing no mainstream browser ships: see a video or a gallery on the page
 * you are on, and pull it down properly — with a real queue, retries, and
 * merged audio/video — instead of hunting for a sketchy "downloader" site.
 *
 * Engines: yt-dlp (video, 1700+ sites) and gallery-dl (image galleries), with
 * ffmpeg for muxing. Detection happens in the page (preload) rather than via
 * session.webRequest, because the ad blocker already owns that hook.
 */
const { ipcMain, app } = require('electron');
const path = require('path');
const EXE = process.platform === 'win32' ? '.exe' : '';
const fs = require('fs');
const { spawn } = require('child_process');

const NO_WINDOW = process.platform === 'win32' ? 0x08000000 : 0; // CREATE_NO_WINDOW

let cfg = { dataDir: '', getPrefs: () => ({}), sendUI: () => {}, pushNav: () => {} };
const found = new Map();   // tabId -> Map(url -> item)
const queue = [];          // pending/active download items
let seq = 1;
let running = 0;
const MAX_PARALLEL = 2;

// ── engine discovery ──────────────────────────────────────────────
// In a packaged build the engines sit in resources/engines; running from
// source they sit beside the app. REDLYNX_ENGINES points at any folder, which
// is how a machine that already has them avoids keeping a second copy.
//
// This list used to end with an absolute path to one particular machine's
// GrabQueue install. It worked there and nowhere else: an installed copy
// found no engines at all, and the downloader then did nothing without ever
// saying why.
function engineDir() {
  const candidates = [
    process.env.REDLYNX_ENGINES,
    process.resourcesPath ? path.join(process.resourcesPath, 'engines') : null,
    path.join(app.getAppPath(), 'engines'),
    path.join(path.dirname(process.execPath), 'engines'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'yt-dlp' + EXE))) return c; } catch (e) {}
  }
  return null;
}

// Which engines are actually present, so the UI can name what is missing
// instead of failing silently when a download is started.
function engineStatus() {
  const d = engineDir();
  const has = (n) => {
    try { return !!d && fs.existsSync(path.join(d, n + EXE)); } catch (e) { return false; }
  };
  return {
    dir: d,
    ytdlp: has('yt-dlp'),
    gallerydl: has('gallery-dl'),
    ffmpeg: has('ffmpeg'),          // only needed to merge separate streams
  };
}
function enginePath(name) {
  const d = engineDir();
  return d ? path.join(d, name + EXE) : null;
}
function enginesReady() { return !!engineDir(); }

// ── found media per tab ───────────────────────────────────────────
function watchTab(tabId, wc) {
  found.set(tabId, new Map());
  // Per-webContents IPC: we know exactly which tab reported this, so a page
  // cannot claim media on behalf of another tab.
  try {
    wc.ipc.on('page:media', (_e, items) => {
      (Array.isArray(items) ? items : []).slice(0, 200).forEach((it) => addFound(tabId, it));
    });
  } catch (e) {}
}
function clearFound(tabId) { const m = found.get(tabId); if (m) m.clear(); cfg.pushNav(); }
function foundCount(tabId) { const m = found.get(tabId); return m ? m.size : 0; }
function foundList(tabId) { const m = found.get(tabId); return m ? [...m.values()] : []; }

function addFound(tabId, item) {
  if (!item || !item.url) return;
  if (/^(data|blob):/i.test(item.url)) return;
  let m = found.get(tabId);
  if (!m) { m = new Map(); found.set(tabId, m); }
  if (m.has(item.url)) return;
  m.set(item.url, {
    url: item.url,
    kind: item.kind || 'file',          // video | stream | image | audio | file
    title: item.title || '',
    width: item.width || 0,
    height: item.height || 0,
  });
  cfg.pushNav();
}

// ── the queue ─────────────────────────────────────────────────────
function outDir() {
  const p = (cfg.getPrefs() || {}).downloadDir || path.join(app.getPath('downloads'), 'Redlynx');
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}

function pushItem(item) {
  const rec = {
    id: seq++, url: item.url, kind: item.kind || 'video', title: item.title || item.url,
    status: 'queued', progress: 0, speed: '', eta: '', size: '', file: '', error: '',
    engine: item.engine || (item.kind === 'image' ? 'gallery' : 'video'), retries: 0,
  };
  queue.push(rec);
  emit();
  pump();
  return rec.id;
}

function emit() { cfg.sendUI('downloads', queue.slice(-60)); }

function pump() {
  if (running >= MAX_PARALLEL) return;
  const next = queue.find((q) => q.status === 'queued');
  if (!next) return;
  run(next);
  if (running < MAX_PARALLEL) pump();
}

function run(rec) {
  const dir = outDir();
  const isGallery = rec.engine === 'gallery';
  const exe = enginePath(isGallery ? 'gallery-dl' : 'yt-dlp');
  if (!exe || !fs.existsSync(exe)) {
    rec.status = 'failed';
    rec.error = 'Download engine missing (yt-dlp/gallery-dl not found)';
    emit();
    return;
  }

  const args = isGallery
    ? ['-d', dir, rec.url]
    : ['--newline', '--no-playlist', '--no-mtime',
       '--ffmpeg-location', engineDir(),
       '--print', 'after_move:IC_PATH\t%(filepath)s',
       '--print', 'after_move:IC_ID\t%(id)s',
       '--no-simulate',
       '-o', path.join(dir, '%(title).150B [%(id)s].%(ext)s'),
       '-f', 'bv*+ba/b',
       rec.url];

  rec.status = 'downloading';
  running++;
  emit();

  let proc;
  try {
    proc = spawn(exe, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  } catch (e) {
    rec.status = 'failed'; rec.error = String(e.message || e); running--; emit(); pump(); return;
  }
  rec._proc = proc;

  const PROG = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/;
  let tail = [];
  let files = 0;
  let vidId = '';

  const onLine = (line) => {
    line = String(line).trim();
    if (!line) return;
    tail.push(line); if (tail.length > 10) tail.shift();

    if (isGallery) {
      if (!/^\[|^ERROR|^WARNING/.test(line)) { files++; rec.size = files + ' file(s)'; emit(); }
      return;
    }
    if (line.startsWith('IC_PATH\t')) { rec.file = line.split('\t')[1]; return; }
    if (line.startsWith('IC_ID\t')) { vidId = line.split('\t')[1]; return; }
    if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) { rec.status = 'converting'; emit(); return; }
    const m = PROG.exec(line);
    if (m) {
      rec.status = 'downloading';
      rec.progress = parseFloat(m[1]) || 0;
      rec.size = m[2] || rec.size;
      rec.speed = m[3] || '';
      rec.eta = m[4] || '';
      emit();
    }
  };

  let buf = '';
  const feed = (chunk) => {
    buf += chunk.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    parts.forEach(onLine);
  };
  proc.stdout.on('data', feed);
  proc.stderr.on('data', feed);

  proc.on('close', (code) => {
    running--;
    rec._proc = null;
    if (rec.status === 'canceled') { emit(); pump(); return; }
    if (code === 0) {
      rec.status = 'done'; rec.progress = 100; rec.speed = ''; rec.eta = '';
      // yt-dlp mangles emoji in its printed path — resolve the real file by id.
      if (!isGallery && vidId && (!rec.file || !fs.existsSync(rec.file))) {
        try {
          const hit = fs.readdirSync(dir).filter((f) => f.includes('[' + vidId + ']'))
            .map((f) => path.join(dir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
          if (hit) rec.file = hit;
        } catch (e) {}
      }
      if (isGallery) rec.file = dir;
    } else {
      const err = tail.slice().reverse().find((l) => /ERROR/i.test(l)) || tail[tail.length - 1] || ('exit ' + code);
      // A page yt-dlp cannot read may still be a gallery — try the other engine once.
      if (!isGallery && /Unsupported URL/i.test(err) && rec.retries === 0) {
        rec.retries++; rec.engine = 'gallery'; rec.status = 'queued'; rec.error = '';
        emit(); pump(); return;
      }
      rec.status = 'failed';
      rec.error = err.slice(0, 300);
    }
    emit();
    pump();
  });
}

function cancel(id) {
  const rec = queue.find((q) => q.id === id);
  if (!rec) return;
  rec.status = 'canceled';
  if (rec._proc) { try { rec._proc.kill(); } catch (e) {} }
  if (rec._native) { try { rec._native.cancel(); } catch (e) {} }
  emit();
}
function retry(id) {
  const rec = queue.find((q) => q.id === id);
  if (!rec) return;
  rec.status = 'queued'; rec.error = ''; rec.progress = 0; rec.retries = 0;
  emit(); pump();
}


// ── ordinary browser downloads (PDF, zip, installer, right-click save) ──
// These used to fall on the floor entirely; now they share the queue and the
// same panel as media grabs.
function trackNative(item) {
  const dir = outDir();
  const name = item.getFilename() || 'download';
  const dest = path.join(dir, name);
  try { item.setSavePath(uniquePath(dest)); } catch (e) {}
  const rec = {
    id: seq++, url: item.getURL(), kind: 'file', title: name,
    status: 'downloading', progress: 0, speed: '', eta: '', size: '',
    file: '', error: '', engine: 'browser', retries: 0, _native: item,
  };
  queue.push(rec);
  emit();
  const total = item.getTotalBytes() || 0;
  let last = Date.now(), lastBytes = 0;
  item.on('updated', (_e, state) => {
    if (state === 'interrupted') { rec.status = 'failed'; rec.error = 'Interrupted'; return emit(); }
    if (item.isPaused()) return;
    const got = item.getReceivedBytes();
    const now = Date.now();
    if (now - last > 400) {
      const bps = ((got - lastBytes) / (now - last)) * 1000;
      rec.speed = human(bps) + '/s';
      if (total && bps > 0) {
        const secs = Math.max(0, (total - got) / bps);
        rec.eta = secs > 60 ? Math.round(secs / 60) + 'm' : Math.round(secs) + 's';
      }
      last = now; lastBytes = got;
    }
    rec.progress = total ? (got / total) * 100 : 0;
    rec.size = total ? human(total) : human(got);
    emit();
  });
  item.once('done', (_e, state) => {
    rec._native = null;
    if (state === 'completed') {
      rec.status = 'done'; rec.progress = 100; rec.speed = ''; rec.eta = '';
      rec.file = item.getSavePath();
    } else if (rec.status !== 'canceled') {
      rec.status = 'failed';
      rec.error = state === 'cancelled' ? 'Canceled' : 'Download failed';
    }
    emit();
  });
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, -ext.length || undefined);
  let i = 1;
  while (fs.existsSync(base + ' (' + i + ')' + ext)) i++;
  return base + ' (' + i + ')' + ext;
}
function human(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

// Queue a URL from anywhere (context menu, media panel, drag-drop).
function enqueue(item) {
  return pushItem({
    url: item.url,
    kind: item.kind || 'video',
    title: item.title || item.url,
    engine: item.kind === 'image' ? 'gallery' : 'video',
  });
}

// ── wiring ────────────────────────────────────────────────────────
function install(options) {
  cfg = { ...cfg, ...options };

  ipcMain.handle('media:list', (_e, tabId) => ({
    enginesReady: enginesReady(),
    engines: engineStatus(),
    items: foundList(tabId),
  }));
  ipcMain.handle('media:grabPage', (_e, payload) => pushItem({ url: payload.url, kind: 'video', title: payload.title, engine: 'video' }));
  ipcMain.handle('media:grab', (_e, item) => pushItem({
    url: item.url, kind: item.kind, title: item.title,
    engine: item.kind === 'image' ? 'gallery' : 'video',
  }));
  ipcMain.handle('dl:list', () => queue.slice(-60));
  ipcMain.handle('dl:cancel', (_e, id) => cancel(id));
  ipcMain.handle('dl:retry', (_e, id) => retry(id));
  ipcMain.handle('dl:dir', () => outDir());
  ipcMain.handle('dl:enginesReady', () => enginesReady());
  ipcMain.handle('dl:engines', () => engineStatus());
}

module.exports = { install, watchTab, clearFound, foundCount, foundList, addFound, enginesReady, engineStatus, enqueue, trackNative };
