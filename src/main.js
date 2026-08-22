/**
 * Redlynx — a stronger browser.
 *
 * Same Chromium engine as Chrome, with the things Chrome won't give you:
 *   • a real media downloader (yt-dlp + gallery-dl) built into the browser
 *   • ad + tracker blocking at the network layer, on by default
 *   • power tab management (suspend, session restore, search)
 *   • privacy hardening, and NOTHING sensitive saved without asking first
 */
const { app, BaseWindow, WebContentsView, ipcMain, shell, session, Menu, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (e) => console.error('[redlynx]', e));
process.on('unhandledRejection', (e) => console.error('[redlynx]', e));
function blog() {}   // boot tracing retired


const Blocker = require('./blocker');
const Downloads = require('./downloads');
const Privacy = require('./privacy');
const GX = require('./gx');
const History = require('./history');
const Extensions = require('./extensions');
const Updater = require('./updater');
const Reader = require('./reader');
const Menus = require('./menus');
const Anon = require('./anon');
const Userscripts = require('./userscripts');

// Internal scheme so the new tab page and user backgrounds load without
// punching a file:// hole in the UI's content-security policy.
protocol.registerSchemesAsPrivileged([{
  scheme: 'redlynx',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ── performance flags ─────────────────────────────────────────────
// GPU rasterisation + zero-copy give smoother scroll/paint; the rest trims
// features Redlynx never uses so they cost neither memory nor startup time.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,ParallelDownloading');
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider');
app.commandLine.appendSwitch('disable-background-timer-throttling', 'false');

const UI_BASE = 80;                // 40 tabstrip + 40 omnibar
const BM_BAR = 32;                 // bookmarks strip when shown
function uiHeight() { return UI_BASE + (prefs.showBookmarksBar ? BM_BAR : 0); }
const ENGINES = {
  google:     { name: 'Google',     home: 'https://www.google.com',      q: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', home: 'https://duckduckgo.com',      q: 'https://duckduckgo.com/?q=' },
  bing:       { name: 'Bing',       home: 'https://www.bing.com',        q: 'https://www.bing.com/search?q=' },
  brave:      { name: 'Brave',      home: 'https://search.brave.com',    q: 'https://search.brave.com/search?q=' },
  startpage:  { name: 'Startpage',  home: 'https://www.startpage.com',   q: 'https://www.startpage.com/sp/search?query=' },
};
function engine() { return ENGINES[prefs.searchEngine] || ENGINES.google; }

// ── connection warming ────────────────────────────────────────────
// Most of the wait before a search is not the search: it is the DNS lookup,
// the TCP handshake and the TLS negotiation that have to finish before the
// request can even be sent. Doing that work while the user is still reaching
// for the keyboard takes it off the critical path, so pressing Enter reuses a
// socket that is already open. This is what Chrome does when you focus its
// omnibox. No query text is involved — it is a bare HEAD to the engine's own
// home origin, and it only happens for the engine the user has chosen.
const warmedAt = new Map();          // origin -> when we last warmed it
const WARM_TTL = 45000;              // Chromium keeps idle sockets ~90s

function warmOrigin(origin) {
  if (!origin) return;
  const now = Date.now();
  if (now - (warmedAt.get(origin) || 0) < WARM_TTL) return;
  warmedAt.set(origin, now);
  let host = '';
  try { host = new URL(origin).hostname; } catch (e) { return; }
  const ses = session.fromPartition('persist:main');
  try { ses.resolveHost(host).catch(() => {}); } catch (e) {}
  try {
    const req = net.request({ method: 'HEAD', url: origin, session: ses });
    req.on('response', (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.end();
  } catch (e) {}
}

function warmSearchEngine() { warmOrigin(engine().home); }

// ── Google's AI Overview ──────────────────────────────────────────
// Google generates the overview after the results and streams it in, so the
// page reflows and the first real result sits a long way down while you wait
// — measured at y=804 with one, against y=222 without.
//
// Rather than hide it after the fact, ask Google not to make one. udm=14 is
// its own "Web" results mode: no overview is generated at all, so there is no
// wait and no reserved space to collapse. That also means no fighting with
// class names that change every few weeks. The trade is that Web mode is
// links only — no inline image, video or shopping blocks.
function searchUrl(query) {
  const e = engine();
  const base = e.q + encodeURIComponent(query);
  if (prefs.hideAiOverview === false) return base;
  if (e !== ENGINES.google) return base;        // udm is a Google parameter
  return base + '&udm=14';
}
function homeUrl() { return (prefs.homePage && prefs.homePage.trim()) || engine().home; }
// New tabs land on Redlynx's own page (customisable background, top sites),
// unless the user would rather go straight to their home page.
function newTabUrl() { return prefs.newTabMode === 'home' ? homeUrl() : 'redlynx://newtab'; }
const DATA_DIR = path.join(app.getPath('userData'), 'redlynx');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const FAVS_FILE = path.join(DATA_DIR, 'favorites.json');

let win = null;          // BaseWindow
let chrome = null;       // WebContentsView holding our UI
const tabs = new Map();  // id -> tab record
let activeId = null;
let tabSeq = 1;

// ── prefs ─────────────────────────────────────────────────────────
const DEFAULT_PREFS = {
  blockAds: true,
  blockTrackers: true,
  httpsOnly: true,
  blockThirdPartyCookies: true,
  askBeforeSaving: true,       // never store sensitive data silently
  suspendIdleTabs: true,
  suspendAfterMin: 30,
  downloadDir: '',
  aiEnabled: false,            // AI is OFF until the user turns it on
  aiKey: '',                   // provider key; nothing works without it
  // Control (GX-style resource governor)
  cpuLimit: 100,               // max % of CPU speed pages may use
  ramLimit: 0,                 // MB ceiling for the whole browser (0 = off)
  netLimit: 0,                 // Mbps cap per tab (0 = unlimited)
  forceDark: false,            // dark-mode any site
  // Toolbar: nothing is pinned by default — a clean bar you opt into.
  pinned: { favorites: false, downloads: true, gx: false, ai: false, pop: false, shield: true, suspend: false, media: true, aioverview: true, reader: true },
  // Anonymity
  proxyEnabled: false,
  proxyMode: 'manual',        // manual | tor
  proxyScheme: 'socks5',      // socks5 | http | https
  proxyHost: '',
  proxyPort: '',
  dohEnabled: true,           // encrypted DNS on by default
  dohProvider: 'quad9',
  blockWebRTC: true,          // stop WebRTC leaking your real IP past a proxy
  searchEngine: 'google',     // used for the omnibar AND the home button
  homePage: '',               // blank = the search engine's home
  // Background / new tab
  bgFile: '',                 // image or GIF copied into userData
  bgApplyChrome: true,        // let it show through the toolbar
  bgApplyNewTab: true,        // and behind the new tab page
  bgOpacity: 45,              // % — keeps UI text readable
  bgBlur: 0,                  // px
  newTabMode: 'redlynx',      // redlynx | home
  showBookmarksBar: true,     // Chrome-style bookmarks strip with folders
  userscripts: { classicImages: true, maxQuality: true },   // per-site usability fixes
  hideAiOverview: true,        // Google's AI Overview — off by default, it delays the real results
  autofillPasswords: true,     // put a saved password back in; saving still asks first
  cleanPages: true,           // strip page footers / sticky clutter
  theme: 'dark',              // dark | midnight | light
  accent: '#e63946',           // UI accent colour
  uiSounds: false,             // browser sound effects
};
function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch (e) { return { ...DEFAULT_PREFS }; }
  const out = { ...DEFAULT_PREFS, ...saved };
  // A flat spread replaces these wholesale, so a tool added after someone's
  // prefs were written would never appear for them. Merge the nested objects
  // key by key, with anything they have chosen winning.
  ['pinned', 'userscripts'].forEach((k) => {
    out[k] = { ...(DEFAULT_PREFS[k] || {}), ...(saved[k] || {}) };
  });
  return out;
}
function savePrefs(p) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); } catch (e) {}
}
let prefs = loadPrefs();


// ── Clean pages ───────────────────────────────────────────────────
// Strips the junk that clings to the edges of a page: site footers, sticky
// promo bars, cookie nags, "open in app" interstitials. Toggleable, because
// on some sites the footer is genuinely useful navigation.
const CLEAN_CSS = `
  /* site footers (semantic + Google's non-semantic one) */
  footer, [role="contentinfo"], .fbar, #fbar, #footcnt, #footer, .site-footer,
  /* sticky bottom bars, promos and app interstitials */
  [class*="sticky-bottom"], [class*="bottom-bar"], [class*="bottom-banner"],
  [class*="cookie-banner"], [class*="cookie-consent"], [id*="cookie-banner"],
  [class*="newsletter-popup"], [class*="app-banner"], [class*="smart-banner"],
  [class*="floating-cta"], [class*="notification-bar"] {
    display: none !important;
  }
  /* reclaim the space those bars reserved */
  body { padding-bottom: 0 !important; margin-bottom: 0 !important; }
`;
// ── Google's AI Overview ──────────────────────────────────────────
// It streams in after the results, so the page reflows and the first real
// result gets pushed a long way down while you wait — measured at 1194px
// tall, putting the first organic link at y=804 instead of y≈170.
//
// Hiding it is a layout decision, not a block: the CSS goes in before the
// block arrives, so the results sit at the top from the start and nothing
// jumps. #m-x-content is the container, and it is absent entirely on queries
// that return no overview, so this cannot swallow ordinary results.
// Fallback for search pages we did not build the URL for — typing into
// Google's own box, or following a search link. Hiding #m-x-content alone
// leaves ~384px of empty wrapper still holding the space open, so the whole
// subtree that contains it goes too. Every element that matches is a few
// hundred pixels tall and none of them contain the results list, which sits
// far below; scoping to #rcnt keeps the :has() cheap.
const AI_OVERVIEW_CSS = `
  #rcnt div:has(#m-x-content),
  #m-x-content,
  div[data-subtree="aio"],
  [aria-label="Show more AI Overview"] { display: none !important; }
`;

async function applyAiOverview(wc) {
  try {
    const url = wc.getURL() || '';
    const isSearch = /^https?:\/\/(www\.)?google\.[a-z.]+\/search/i.test(url);
    if (prefs.hideAiOverview !== false && isSearch) {
      if (wc.__aioKey) return;
      wc.__aioKey = await wc.insertCSS(AI_OVERVIEW_CSS);
    } else if (wc.__aioKey) {
      await wc.removeInsertedCSS(wc.__aioKey);
      wc.__aioKey = null;
    }
  } catch (e) {}
}

async function applyClean(wc) {
  try {
    if (prefs.cleanPages) {
      if (wc.__cleanKey) return;
      wc.__cleanKey = await wc.insertCSS(CLEAN_CSS);
    } else if (wc.__cleanKey) {
      await wc.removeInsertedCSS(wc.__cleanKey);
      wc.__cleanKey = null;
    }
  } catch (e) {}
}



// ── backgrounds ───────────────────────────────────────────────────
const BG_DIR = path.join(DATA_DIR, 'backgrounds');
function bgUrl() {
  return prefs.bgFile ? ('redlynx://bg/' + encodeURIComponent(prefs.bgFile)) : '';
}
function serveInternal(ses) {
  const { pathToFileURL } = require('url');   // handles Windows paths correctly
  const serve = (file) => {
    try {
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    } catch (e) {
      return new Response('error', { status: 500 });
    }
  };
  const handler = (request) => {
    const u = new URL(request.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    if (u.hostname === 'newtab') return serve(path.join(__dirname, 'ui', 'newtab.html'));
    // basename() on both keeps a crafted path from escaping the folder
    if (u.hostname === 'bg') return serve(path.join(BG_DIR, path.basename(rel)));
    if (u.hostname === 'asset') return serve(path.join(__dirname, 'ui', path.basename(rel)));
    return new Response('not found', { status: 404 });
  };
  // Tabs live in the persist:main partition, so the handler must be registered
  // there — the global protocol module only covers the default session.
  try { ses.protocol.handle('redlynx', handler); } catch (e) { console.error('[redlynx] scheme(ses):', e.message); }
  try { protocol.handle('redlynx', handler); } catch (e) {}
}

// ── bookmarks: a real tree, so the bar can hold folders ───────────
const BM_FILE = path.join(DATA_DIR, 'bookmarks.json');
let bmSeq = 1;
function loadBM() {
  try {
    const t = JSON.parse(fs.readFileSync(BM_FILE, 'utf8'));
    if (Array.isArray(t)) { bmSeq = Math.max(1, ...flatIds(t)) + 1; return t; }
  } catch (e) {}
  // migrate the old flat favourites file, if any
  try {
    const old = JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8'));
    if (Array.isArray(old) && old.length) {
      const t = old.map((f) => ({ id: bmSeq++, type: 'link', title: f.title || f.url, url: f.url }));
      saveBM(t);
      return t;
    }
  } catch (e) {}
  return [];
}
function flatIds(nodes, out = []) {
  nodes.forEach((n) => { out.push(Number(n.id) || 0); if (n.children) flatIds(n.children, out); });
  return out.length ? out : [0];
}
function saveBM(tree) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BM_FILE, JSON.stringify(tree, null, 2)); } catch (e) {}
}
function bmFind(nodes, id, parent = null) {
  for (const n of nodes) {
    if (n.id === id) return { node: n, list: nodes, parent };
    if (n.children) { const r = bmFind(n.children, id, n); if (r) return r; }
  }
  return null;
}
function bmFlatLinks(nodes, path = '', out = []) {
  nodes.forEach((n) => {
    if (n.type === 'folder') bmFlatLinks(n.children || [], (path ? path + ' / ' : '') + n.title, out);
    else out.push({ id: n.id, title: n.title, url: n.url, folder: path });
  });
  return out;
}

// ── favorites ─────────────────────────────────────────────────────
function loadFavs() { try { return JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8')); } catch (e) { return []; } }
function saveFavs(list) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FAVS_FILE, JSON.stringify(list, null, 2)); } catch (e) {} }

// ── layout ────────────────────────────────────────────────────────
// The chrome is normally just the strip at the top, with the page filling the
// rest. That works until the chrome needs to draw *over* the page — a panel,
// or the "save this password?" prompt. Those were clipped to an 80px strip and
// buried underneath the page view as well, since tab views are added to the
// window after the chrome and so sit above it.
//
// While an overlay is open the chrome takes the whole window and moves to the
// front. Its page is transparent below the strip, so the site still shows
// through and the prompt reads as floating over it.
let overlayOpen = false;

// Set while a page is in fullscreen. The chrome is a separate view sitting
// above the page rather than part of it, so nothing hides it on its own —
// without this, a fullscreen video fills only the area under the toolbar and
// the strip stays on screen, which is not fullscreen at all.
let fullscreenTabId = null;

function layout() {
  if (!win) return;
  const b = win.getContentBounds();

  if (fullscreenTabId !== null) {
    const fs = tabs.get(fullscreenTabId);
    if (fs && fs.view) {
      if (chrome) chrome.setVisible(false);
      fs.view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
      return;
    }
    fullscreenTabId = null;          // that tab went away; fall through
  }

  const h = uiHeight();
  if (chrome) {
    chrome.setVisible(true);
    chrome.setBounds(overlayOpen
      ? { x: 0, y: 0, width: b.width, height: b.height }
      : { x: 0, y: 0, width: b.width, height: h });
  }
  const t = tabs.get(activeId);
  if (t && t.view) t.view.setBounds({ x: 0, y: h, width: b.width, height: Math.max(0, b.height - h) });
}

function enterFullscreen(id) {
  fullscreenTabId = id;
  try { win.setFullScreen(true); } catch (e) {}
  const t = tabs.get(id);
  // The page must be the topmost view, or the chrome would still cover it.
  if (t && t.view) { try { win.contentView.addChildView(t.view); } catch (e) {} }
  layout();
}

function leaveFullscreen(id) {
  if (id != null && fullscreenTabId !== id) return;
  fullscreenTabId = null;
  try { if (win.isFullScreen()) win.setFullScreen(false); } catch (e) {}
  layout();
  raiseChromeIfOverlay();
}

// Raise the chrome above the page. addChildView on a view that is already a
// child re-appends it, which is what puts it on top.
function raiseChrome() {
  if (!win || !chrome) return;
  try { win.contentView.addChildView(chrome); } catch (e) {}
}

// Coming out of fullscreen re-stacked the views, so put the chrome back on
// top if something was open over the page when we went in.
function raiseChromeIfOverlay() { if (overlayOpen) raiseChrome(); }

function setOverlay(on) {
  if (overlayOpen === !!on) return;
  overlayOpen = !!on;
  if (overlayOpen) {
    layout();
    raiseChrome();          // order matters: size it, then bring it forward
  } else {
    layout();
    // Hand the click surface back to the page.
    const t = tabs.get(activeId);
    if (t && t.view) { try { win.contentView.addChildView(t.view); } catch (e) {} }
  }
}

function sendUI(channel, payload) { try { if (chrome) chrome.webContents.send(channel, payload); } catch (e) {} }

function tabState() {
  return {
    activeId,
    tabs: [...tabs.values()].map((t) => ({
      id: t.id, title: t.title || 'New tab', url: t.url || '',
      suspended: !!t.suspended, pinned: !!t.pinned, loading: !!t.loading, private: !!t.private,
    })),
  };
}
function pushTabs() { sendUI('tabs', tabState()); }

function navState() {
  const t = tabs.get(activeId);
  if (!t) return { url: '', canBack: false, canFwd: false, loading: false, secure: false, blocked: 0 };
  const wc = t.view.webContents;
  const u = (t.suspended ? (t.suspendedUrl || t.url) : wc.getURL()) || t.url || '';
  const nh = wc.navigationHistory;
  return {
    url: u,
    canBack: nh ? nh.canGoBack() : false,
    canFwd: nh ? nh.canGoForward() : false,
    loading: !!t.loading,
    secure: u.startsWith('https://'),
    blocked: Blocker.countFor(activeId),
    media: Downloads.foundCount(activeId),
  };
}
function pushNav() { sendUI('nav', navState()); }

// ── tabs ──────────────────────────────────────────────────────────
function createTab(url, opts) {
  url = url || newTabUrl();
  const background = !!(opts && opts.background);
  const id = tabSeq++;
  const priv = !!(opts && opts.private);
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-page.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // No "persist:" prefix means the whole partition lives in memory and
      // dies with the tab — no cookies, cache or storage left behind.
      partition: priv ? ('private-' + id + '-' + Date.now()) : 'persist:main',
      spellcheck: false,
    },
  });
  const lazy = !!(opts && opts.suspended);
  const t = {
    id, view, url,
    title: (opts && opts.title) || (lazy ? url : 'New tab'),
    suspended: lazy, suspendedUrl: lazy ? url : null,
    pinned: !!(opts && opts.pinned),
    lastActive: Date.now(), loading: !lazy, private: priv,
  };
  tabs.set(id, t);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: u }) => { createTab(u, {}); return { action: 'deny' }; });
  wc.on('page-title-updated', (_e, title) => { t.title = title; if (!t.private) History.setTitle(wc.getURL(), title); pushTabs(); });
  wc.on('did-start-loading', () => { t.loading = true; pushTabs(); if (t.id === activeId) pushNav(); });
  wc.on('did-stop-loading', () => { t.loading = false; t.url = wc.getURL(); pushTabs(); if (t.id === activeId) pushNav(); });
  wc.on('did-navigate', (_e, u) => {
    t.url = u; Blocker.reset(id); Downloads.clearFound(id);
    if (!t.private) History.add(u, t.title);
    if (t.id === activeId) pushNav();
  });
  wc.on('did-navigate-in-page', (_e, u) => { t.url = u; if (t.id === activeId) pushNav(); });

  wc.on('found-in-page', (_e, r) => sendUI('find-result', { active: r.activeMatchOrdinal, total: r.matches }));

  // The new tab page is sandboxed, so the browser hands it its config after
  // load, and translates its search submissions into a real query.
  wc.on('did-finish-load', () => {
    const u = wc.getURL() || '';
    if (!u.startsWith('redlynx://newtab')) return;
    const sites = [];
    const seen = new Map();
    History.search('', 800).forEach((h) => {
      try {
        const host = new URL(h.url).hostname.replace(/^www\./, '');
        const cur = seen.get(host);
        if (!cur || (h.visits || 1) > cur.visits) {
          seen.set(host, { url: h.url, title: h.title || host, host, visits: h.visits || 1 });
        }
      } catch (e) {}
    });
    [...seen.values()].sort((a, b) => b.visits - a.visits).slice(0, 12).forEach((x) => sites.push(x));
    const cfg = {
      bg: bgUrl() && prefs.bgApplyNewTab ? bgUrl() : '',
      opacity: prefs.bgOpacity, blur: prefs.bgBlur, sites,
    };
    wc.executeJavaScript(
      'window.__redlynxInit && window.__redlynxInit(' + JSON.stringify(cfg) + ')'
    ).catch(() => {});
  });

  // Turn the new tab page's search into a real query on the chosen engine.
  wc.on('will-navigate', (e, target) => {
    const m = /REDLYNX_SEARCH(.*)$/.exec(target || '');
    if (!m) return;
    e.preventDefault();
    wc.loadURL(searchUrl(decodeURIComponent(m[1]))).catch(() => {});
  });

  Downloads.watchTab(id, wc);
  Blocker.bindTab(id, wc);
  GX.bindTab(id, wc);
  Menus.attach(id, wc);
  Anon.harden(wc);

  // Keyboard power without a menu bar.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    if (k === 'f12' || (ctrl && input.shift && k === 'i')) { wc.toggleDevTools(); e.preventDefault(); }
    else if (ctrl && (k === '=' || k === '+')) { wc.setZoomLevel(wc.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (ctrl && k === '-') { wc.setZoomLevel(wc.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (ctrl && k === '0') { wc.setZoomLevel(0); e.preventDefault(); }
    else if (ctrl && k === 'r') { wc.reload(); e.preventDefault(); }
    else if (ctrl && k === 't') { createTab(newTabUrl(), {}); e.preventDefault(); }
    else if (ctrl && k === 'w') { closeTab(id); e.preventDefault(); }
    else if (ctrl && k === 'l') { sendUI('focus-url', {}); e.preventDefault(); }
    // Ctrl+K reaches the chrome even while the page holds focus, which is the
    // whole point of a palette: it has to work from wherever you are.
    else if (ctrl && k === 'k') { sendUI('palette', {}); e.preventDefault(); }
    else if (k === 'f5') { wc.reload(); e.preventDefault(); }
    else if (k === 'f11') {
      if (fullscreenTabId === id) leaveFullscreen(id); else enterFullscreen(id);
      e.preventDefault();
    }
    else if (k === 'escape' && fullscreenTabId === id) {
      // Only ours to handle if the page is not itself in fullscreen — when it
      // is, the page gets Escape and its own leave event brings us back.
      wc.executeJavaScript('!!document.fullscreenElement', true)
        .then((pageOwns) => { if (!pageOwns) leaveFullscreen(id); })
        .catch(() => leaveFullscreen(id));
    }
    else if (input.alt && k === 'arrowleft') { const nh = wc.navigationHistory; if (nh && nh.canGoBack()) nh.goBack(); e.preventDefault(); }
    else if (input.alt && k === 'arrowright') { const nh = wc.navigationHistory; if (nh && nh.canGoForward()) nh.goForward(); e.preventDefault(); }
  });
  // Inserted CSS belongs to the document that was showing when it went in, so
  // it is gone the moment a new one commits. The keys have to be dropped with
  // it, or the "already inserted" guards below skip re-inserting and the
  // styling silently applies to the first page in a tab and nothing after it.
  // A video going fullscreen: take the window fullscreen too and let the page
  // have the whole of it.
  wc.on('enter-html-full-screen', () => enterFullscreen(id));
  wc.on('leave-html-full-screen', () => leaveFullscreen(id));

  wc.on('did-start-navigation', (_e, _u, isInPage, isMainFrame) => {
    if (isInPage || !isMainFrame) return;
    wc.__cleanKey = null;
    wc.__aioKey = null;
    if (fullscreenTabId === id) leaveFullscreen(id);
  });
  wc.on('dom-ready', () => {
    applyClean(wc);
    applyAiOverview(wc);
    Userscripts.apply(wc, wc.getURL() || '', prefs);
  });
  // Google Images swaps results in without a reload, so re-apply on in-page nav.
  wc.on('did-navigate-in-page', (_e, u) => Userscripts.apply(wc, u || '', prefs));
  wc.on('did-finish-load', () => { if (prefs.forceDark) GX.setDark(wc, true); applyClean(wc); applyAiOverview(wc); });

  win.contentView.addChildView(view);
  if (background || lazy) { view.setVisible(false); pushTabs(); }
  else setActive(id);
  // A lazily-restored tab costs nothing until you click it.
  if (!lazy) wc.loadURL(url).catch(() => {});
  return id;
}

function setActive(id) {
  const t = tabs.get(id);
  if (!t) return;
  for (const [, other] of tabs) { if (other.view) other.view.setVisible(other.id === id); }
  activeId = id;
  t.lastActive = Date.now();
  if (t.suspended) resumeTab(id);
  layout();
  pushTabs();
  pushNav();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  try { win.contentView.removeChildView(t.view); } catch (e) {}
  try { GX.unbind(id); } catch (e) {}
  try { t.view.webContents.close(); } catch (e) {}
  tabs.delete(id);
  Downloads.clearFound(id);
  if (activeId === id) {
    const keys = [...tabs.keys()];
    const next = keys.length ? keys[keys.length - 1] : null;
    activeId = null;
    if (next) setActive(next); else createTab(newTabUrl(), {});
  }
  pushTabs();
  saveSession();
}

// Power tabs: suspend an idle tab to free its RAM, keeping its strip entry.
function suspendTab(id) {
  const t = tabs.get(id);
  if (!t || t.suspended || id === activeId) return;
  t.suspendedUrl = t.view.webContents.getURL() || t.url;
  t.suspended = true;
  try { t.view.webContents.loadURL('about:blank'); } catch (e) {}
  pushTabs();
}
function resumeTab(id) {
  const t = tabs.get(id);
  if (!t || !t.suspended) return;
  t.suspended = false;
  const u = t.suspendedUrl || t.url;
  if (u && u !== 'about:blank') t.view.webContents.loadURL(u).catch(() => {});
  pushTabs();
}
setInterval(() => {
  if (!prefs.suspendIdleTabs) return;
  const cutoff = Date.now() - (Number(prefs.suspendAfterMin) || 30) * 60000;
  for (const [, t] of tabs) {
    if (t.id !== activeId && !t.suspended && !t.pinned && t.lastActive < cutoff) suspendTab(t.id);
  }
}, 60000);

// ── session save / restore ────────────────────────────────────────
function saveSession() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const ordered = [...tabs.values()].filter((t) => !t.private);
    const open = ordered
      .map((t) => ({
        url: t.suspended ? (t.suspendedUrl || t.url) : (t.view.webContents.getURL() || t.url),
        title: t.title || '',
        pinned: !!t.pinned,
        active: t.id === activeId,
      }))
      .filter((x) => x.url && x.url !== 'about:blank');
    const activeIndex = Math.max(0, open.findIndex((x) => x.active));
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ tabs: open, activeIndex, at: Date.now() }));
  } catch (e) {}
}
function restoreSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (s && Array.isArray(s.tabs) && s.tabs.length) {
      const active = Math.min(Math.max(0, s.activeIndex || 0), s.tabs.length - 1);
      // Every tab comes back, but only the one you were on actually loads —
      // so reopening 40 tabs costs about what reopening 1 does.
      s.tabs.forEach((x, i) => createTab(x.url, {
        background: i !== active,
        suspended: i !== active,
        title: x.title,
        pinned: x.pinned,
      }));
      const ids = [...tabs.keys()];
      if (ids[active] != null) setActive(ids[active]);
      return true;
    }
  } catch (e) {}
  return false;
}
setInterval(saveSession, 30000);
app.on('before-quit', saveSession);

// ── window ────────────────────────────────────────────────────────
function createWindow() {
  blog('createWindow start');
  win = new BaseWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1115', title: 'Redlynx',
    autoHideMenuBar: true,
  });
  chrome = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { chrome.setBackgroundColor('#00000000'); } catch (e) {}
  blog('BaseWindow made'); win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html')).then(()=>blog('ui loaded')).catch(e=>blog('ui load FAIL: '+e.message));
  win.on('resize', layout);
  // Leaving fullscreen by any route — the OS chrome, a window control — has
  // to put the toolbar back.
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', () => {
    // Exiting via the OS or a window control leaves the page still believing
    // it is fullscreen, which would letterbox the video in the restored view.
    const was = fullscreenTabId;
    fullscreenTabId = null;
    layout();
    const t = was != null ? tabs.get(was) : null;
    if (t && t.view) {
      t.view.webContents
        .executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true)
        .catch(() => {});
    }
  });
  win.on('close', saveSession);
  chrome.webContents.on('did-finish-load', () => {
    sendUI('prefs', prefs);
    if (!tabs.size) { if (!restoreSession()) createTab(newTabUrl(), {}); }
    layout();
  });
}


// ── local automation endpoint (development only) ──────────────────
// Enabled solely when REDLYNX_DEBUG is set, bound to loopback. Lets the
// browser be driven and inspected while building page-level features.
function startDebugServer() {
  if (!process.env.REDLYNX_DEBUG) return;
  const http = require('http');
  const activeWc = () => { const t = tabs.get(activeId); return t ? t.view.webContents : null; };
  const body = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  http.createServer(async (req, res) => {
    const wc = activeWc();
    try {
      if (req.url === '/nav') {
        const b = await body(req);
        if (!wc) return send(res, 400, { error: 'no tab' });
        await wc.loadURL(b.url);
        return send(res, 200, { ok: true, url: wc.getURL() });
      }
      if (req.url === '/js') {
        const b = await body(req);
        if (!wc) return send(res, 400, { error: 'no tab' });
        const out = await wc.executeJavaScript(b.code, true);
        return send(res, 200, { ok: true, result: out });
      }
      if (req.url === '/shot') {
        if (!wc) return send(res, 400, { error: 'no tab' });
        const img = await wc.capturePage();
        const file = path.join(DATA_DIR, 'shot.png');
        fs.writeFileSync(file, img.toPNG());
        return send(res, 200, { ok: true, file });
      }
      if (req.url === '/ui') {
        const b = await body(req);
        const out = await chrome.webContents.executeJavaScript(b.code, true);
        return send(res, 200, { ok: true, result: out });
      }
      if (req.url === '/blocker') {
        const b = await body(req);
        if (b.range) Blocker.setScriptletRange(b.range);
        if (b.styles) return send(res, 200, { ok: true, styles: Blocker.stylesFor(b.url) });
        if (b.dump !== undefined) {
          Blocker.setScriptletRange([0, 9999]);
          const all = Blocker.scriptletsFor(b.url || 'https://www.youtube.com/watch?v=x');
          const one = String(all[b.dump] || '');
          // the scriptlet name and its arguments sit at the very end
          return send(res, 200, { ok: true, index: b.dump, tail: one.slice(-260) });
        }
        const probe = b.url ? Blocker.scriptletsFor(b.url) : [];
        return send(res, 200, {
          ok: true, status: Blocker.status(),
          probeUrl: b.url || null,
          scriptCount: probe.length,
          sample: probe.map((x, i) => {
            const src = String(x);
            const tail = src.slice(-900);
            const call = /([A-Za-z_$][\w$]*)\(\[`([^`]*)`(?:,\s*`([^`]*)`)?/.exec(tail);
            return i + ': ' + (call ? call[1] + '(' + (call[2] || '') + (call[3] ? ' , ' + call[3] : '') + ')' : '?')
                     + '  [len ' + src.length + ']';
          }),
        });
      }
      if (req.url === '/emit') {
        const b = await body(req);
        sendUI(String(b.channel || ''), b.payload || {});
        return send(res, 200, { ok: true, sent: b.channel });
      }
      if (req.url === '/gpu') {
        return send(res, 200, {
          ok: true,
          features: app.getGPUFeatureStatus(),
          info: await app.getGPUInfo('basic').catch(() => null),
        });
      }
      if (req.url === '/info') {
        return send(res, 200, { ok: true, url: wc ? wc.getURL() : null, tabs: tabs.size });
      }
      send(res, 404, { error: 'unknown' });
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
    }
  }).listen(8790, '127.0.0.1', () => console.log('[redlynx] debug endpoint on 127.0.0.1:8790'));
}

app.whenReady().then(async () => {
  blog('app ready');
  // Minimal by design: no native File/Edit/View menu bar at all.
  Menu.setApplicationMenu(null);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!prefs.downloadDir) { prefs.downloadDir = path.join(app.getPath('downloads'), 'Redlynx'); savePrefs(prefs); }
  blog('getting session');
  const ses = session.fromPartition('persist:main');
  Privacy.install(ses, () => prefs, DATA_DIR, sendUI); blog('privacy ok');
  Downloads.install({ dataDir: DATA_DIR, getPrefs: () => prefs, sendUI, pushNav }); blog('downloads ok');
  fs.mkdirSync(BG_DIR, { recursive: true });
  serveInternal(ses);
  History.install(DATA_DIR);
  Anon.install(() => prefs);
  Anon.applyProxy(ses);
  Menus.install({
    newTab: (u, o) => createTab(u, o || {}),
    download: (u, kind) => Downloads.enqueue({ url: u, kind }),
    popOut: () => { const t = tabs.get(activeId); if (t) GX.popOut(t.view.webContents); },
    searchFor: (text) => createTab(searchUrl(text), {}),
    bookmark: () => sendUI('do-bookmark', {}),
    openPanel: (id) => sendUI('open-panel', { id }),
    find: () => sendUI('open-find', {}),
  });
  // Ordinary file downloads (PDF, zip, installer…) — previously these fell on
  // the floor; now they land in the same queue as media grabs.
  ses.on('will-download', (event, item) => Downloads.trackNative(item));
  GX.install({
    getPrefs: () => prefs,
    onSuspend: (id) => suspendTab(id),
    getTabs: () => [...tabs.values()].map((t) => ({
      id: t.id, active: t.id === activeId, suspended: !!t.suspended,
      pinned: !!t.pinned, lastActive: t.lastActive,
    })),
  });
  // Window first — the blocker's filter lists can take a moment to fetch on a
  // cold start, and the browser must never wait on that to open.
  createWindow();
  startDebugServer();
  // The first search of a session is the one most likely to feel slow.
  setTimeout(warmSearchEngine, 1200);
  Blocker.install(ses, () => prefs, DATA_DIR, pushNav)
    .then(() => pushNav())
    .catch((e) => console.error('[blocker] install failed:', e && e.message));
  // Extensions have to be re-loaded on every boot; Electron does not persist
  // them across restarts the way Chrome does.
  Updater.install((ch, payload) => sendUI(ch, payload));
  Extensions.install(ses, DATA_DIR)
    .then((r) => {
      if (r.items.length) console.log('[extensions] loaded', r.items.map((x) => x.name).join(', '));
    })
    .catch((e) => console.error('[extensions] install failed:', e && e.message));
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { saveSession(); if (process.platform !== 'darwin') app.quit(); });

// ── IPC from the browser chrome UI ────────────────────────────────
// ── reader mode ───────────────────────────────────────────────────
ipcMain.handle('reader:toggle', async () => {
  const t = tabs.get(activeId);
  if (!t || !t.view) return { ok: false, error: 'no tab' };
  const wc = t.view.webContents;
  if (await Reader.isOn(wc)) return { ...Reader.clear(wc), on: false };
  const r = await Reader.apply(wc);
  return { ...r, on: !!r.ok };
});
ipcMain.handle('reader:state', async () => {
  const t = tabs.get(activeId);
  if (!t || !t.view) return false;
  return Reader.isOn(t.view.webContents);
});

// ── updates ───────────────────────────────────────────────────────
ipcMain.handle('update:status', () => Updater.status());
ipcMain.handle('update:check', () => Updater.check());
ipcMain.handle('update:download', () => Updater.download());
ipcMain.handle('update:install', () => Updater.installNow());

// ── extensions ────────────────────────────────────────────────────
ipcMain.handle('ext:list', () => Extensions.list());
ipcMain.handle('ext:remove', (_e, id) => Extensions.remove(id));
ipcMain.handle('ext:add', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose an unpacked extension folder',
    message: 'Pick the folder that contains manifest.json',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return Extensions.add(r.filePaths[0]);
});

ipcMain.handle('tab:new', (_e, url) => createTab(url || newTabUrl(), {}));
ipcMain.handle('tab:close', (_e, id) => closeTab(id));

// Tab order is the Map's insertion order, so reordering means rebuilding it.
// Session restore walks the same order, which is what makes a drag survive a
// restart rather than snapping back.
ipcMain.handle('tab:move', (_e, { id, toIndex }) => {
  const ids = [...tabs.keys()];
  const from = ids.indexOf(id);
  if (from < 0) return false;
  ids.splice(from, 1);
  const to = Math.max(0, Math.min(ids.length, Number(toIndex) || 0));
  ids.splice(to, 0, id);
  const rebuilt = ids.map((k) => [k, tabs.get(k)]);
  tabs.clear();
  rebuilt.forEach(([k, v]) => tabs.set(k, v));
  pushTabs();
  saveSession();
  return true;
});
ipcMain.handle('tab:activate', (_e, id) => setActive(id));
ipcMain.handle('tab:suspend', (_e, id) => suspendTab(id));
ipcMain.handle('tab:pin', (_e, id) => { const t = tabs.get(id); if (t) { t.pinned = !t.pinned; pushTabs(); } });
ipcMain.handle('tab:suspendOthers', () => {
  for (const [, t] of tabs) if (t.id !== activeId && !t.pinned) suspendTab(t.id);
  return true;
});
ipcMain.handle('tab:state', () => tabState());
ipcMain.handle('nav:state', () => navState());
ipcMain.handle('nav:go', (_e, input) => {
  const t = tabs.get(activeId); if (!t) return;
  let u = String(input || '').trim();
  if (!u) return;
  const hasScheme = /^[a-z]+:\/\//i.test(u);
  const looksDomain = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(u) && !/\s/.test(u);
  if (!hasScheme && !looksDomain) u = searchUrl(u);
  else if (!hasScheme) u = (prefs.httpsOnly !== false ? 'https://' : 'http://') + u;
  t.view.webContents.loadURL(u).catch(() => {});
});
ipcMain.handle('nav:back', () => { const t = tabs.get(activeId); if (t && t.view.webContents.navigationHistory) t.view.webContents.navigationHistory.goBack(); });
ipcMain.handle('nav:forward', () => { const t = tabs.get(activeId); if (t && t.view.webContents.navigationHistory) t.view.webContents.navigationHistory.goForward(); });
ipcMain.handle('nav:reload', () => { const t = tabs.get(activeId); if (t) t.view.webContents.reload(); });
ipcMain.handle('nav:stop', () => { const t = tabs.get(activeId); if (t) t.view.webContents.stop(); });
ipcMain.handle('nav:home', () => { const t = tabs.get(activeId); if (t) t.view.webContents.loadURL(homeUrl()); });

ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', (_e, patch) => {
  prefs = { ...prefs, ...patch };
  savePrefs(prefs);
  Blocker.refresh(prefs);
  Anon.applyDns();
  Anon.applyProxy(session.fromPartition('persist:main'));
  for (const [, t] of tabs) { try { Anon.harden(t.view.webContents); } catch (e) {} }
  GX.applyAll();
  for (const [, t] of tabs) {
    try { GX.setDark(t.view.webContents, !!prefs.forceDark); } catch (e) {}
    try {
      const wc = t.view.webContents;
      if (!prefs.cleanPages && wc.__cleanKey) { wc.removeInsertedCSS(wc.__cleanKey); wc.__cleanKey = null; }
      else if (prefs.cleanPages) applyClean(wc);
    } catch (e) {}
  }
  sendUI('prefs', prefs);
  layout();
  pushNav();
  return prefs;
});
// ── AI (off by default) ───────────────────────────────────────────
// Nothing here runs, and no page text leaves the machine, unless the user
// has switched AI on AND clicked an AI action themselves.
ipcMain.handle('ai:status', () => ({ enabled: !!prefs.aiEnabled, hasKey: !!(prefs.aiKey || '').trim() }));
ipcMain.handle('ai:ask', async (_e, payload) => {
  if (!prefs.aiEnabled) return { error: 'AI is turned off. Turn it on in Settings.' };
  const key = (prefs.aiKey || '').trim();
  if (!key) return { error: 'Add your API key in Settings to use AI features.' };
  const t = tabs.get(activeId);
  if (!t) return { error: 'No page open.' };
  let text = '';
  try {
    text = await t.view.webContents.executeJavaScript(
      "(document.body ? document.body.innerText : '').slice(0, 12000)", true);
  } catch (e) { return { error: 'Could not read this page.' }; }
  const question = (payload && payload.question) || 'Summarise this page in a few clear bullet points.';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 700,
        messages: [{ role: 'user', content: question + String.fromCharCode(10,10) + 'PAGE:' + String.fromCharCode(10) + text }],
      }),
    });
    const j = await r.json();
    if (j && j.content && j.content[0] && j.content[0].text) return { text: j.content[0].text };
    return { error: (j && j.error && j.error.message) || 'No response from the AI provider.' };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ── Control: hot tabs, pop-out video ──────────────────────────────
ipcMain.handle('gx:hot', () => GX.hotTabs([...tabs.values()].map((t) => ({
  id: t.id, title: t.title, suspended: !!t.suspended, wc: t.view.webContents,
}))));
ipcMain.handle('gx:popout', async () => {
  const t = tabs.get(activeId);
  if (!t) return 'no-tab';
  return GX.popOut(t.view.webContents);
});
ipcMain.handle('gx:memory', () => GX.totalMemoryMb());

ipcMain.handle('block:status', () => Blocker.status());
ipcMain.handle('block:refresh', async () => {
  const r = await Blocker.refreshLists();
  pushNav();
  return r;
});

ipcMain.handle('fav:list', () => bmFlatLinks(loadBM()));
ipcMain.handle('fav:add', (_e, parentId) => {
  const t = tabs.get(activeId);
  if (!t) return { error: 'no tab' };
  const url = t.view.webContents.getURL() || t.url;
  if (!url || url === 'about:blank') return { error: 'nothing to save' };
  const tree = loadBM();
  if (bmFlatLinks(tree).some((f) => f.url === url)) return { ok: true, already: true };
  const node = { id: bmSeq++, type: 'link', title: t.title || url, url };
  if (parentId) {
    const hit = bmFind(tree, parentId);
    if (hit && hit.node.type === 'folder') { hit.node.children = hit.node.children || []; hit.node.children.push(node); }
    else tree.push(node);
  } else tree.push(node);
  saveBM(tree);
  return { ok: true };
});
ipcMain.handle('fav:remove', (_e, url) => {
  const tree = loadBM();
  const strip = (nodes) => nodes.filter((n) => {
    if (n.type === 'folder') { n.children = strip(n.children || []); return true; }
    return n.url !== url;
  });
  saveBM(strip(tree));
  return true;
});
ipcMain.handle('fav:isSaved', () => {
  const t = tabs.get(activeId);
  if (!t) return false;
  const url = t.view.webContents.getURL() || t.url;
  return bmFlatLinks(loadBM()).some((f) => f.url === url);
});

// ── bookmarks bar / folder management ──
ipcMain.handle('bm:import', () => {
  const local = app.getPath('appData').replace(/Roaming$/i, 'Local');
  const candidates = [
    path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
    path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks'),
  ];
  const src = candidates.find((f) => { try { return fs.existsSync(f); } catch (e) { return false; } });
  if (!src) return { ok: false, error: 'No Chrome/Edge/Brave bookmarks found' };

  let data;
  try { data = JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch (e) { return { ok: false, error: 'Could not read the bookmarks file' }; }

  const tree = loadBM();
  const seen = new Set(bmFlatLinks(tree).map((f) => f.url));
  let count = 0;
  // Chrome's format nests {type:'url'|'folder', name, url, children}
  const walk = (node, into) => {
    (node.children || []).forEach((c) => {
      if (c.type === 'folder') {
        const folder = { id: bmSeq++, type: 'folder', title: c.name || 'Folder', children: [] };
        walk(c, folder.children);
        if (folder.children.length) into.push(folder);
      } else if (c.type === 'url' && c.url && !seen.has(c.url)) {
        seen.add(c.url);
        into.push({ id: bmSeq++, type: 'link', title: c.name || c.url, url: c.url });
        count++;
      }
    });
  };
  const roots = (data.roots && [data.roots.bookmark_bar, data.roots.other]) || [];
  roots.filter(Boolean).forEach((r) => walk(r, tree));
  saveBM(tree);
  return { ok: true, count, from: path.basename(path.dirname(path.dirname(path.dirname(src)))) };
});

ipcMain.handle('userscripts:list', () => Userscripts.list());

// The chrome tells us when it is showing something over the page, so the view
// can be grown and raised to match.
ipcMain.on('ui:overlay', (_e, on) => setOverlay(!!on));

// The omnibar is focused or being typed into — open the connection now so
// pressing Enter does not have to wait for DNS and TLS.
ipcMain.on('ui:warm', (_e, target) => {
  if (target && /^https?:\/\//i.test(target)) {
    try { warmOrigin(new URL(target).origin); } catch (e) { warmSearchEngine(); }
  } else {
    warmSearchEngine();
  }
});

// Answered synchronously: the page preload is blocked on this at document
// start, waiting for the scriptlets it has to run before the site's own code.
ipcMain.on('rlx:scriptlets', (e, url) => {
  let out = [];
  try { out = Blocker.scriptletsFor(String(url || '')); } catch (err) {}
  e.returnValue = out;
});

ipcMain.handle('bg:pick', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose a background',
    properties: ['openFile'],
    filters: [{ name: 'Images & GIFs', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const src = r.filePaths[0];
  const name = Date.now() + '-' + path.basename(src).replace(/[^\w.-]/g, '_');
  try {
    fs.mkdirSync(BG_DIR, { recursive: true });
    fs.copyFileSync(src, path.join(BG_DIR, name));   // copied in, so it survives moves
    prefs.bgFile = name;
    savePrefs(prefs);
    sendUI('prefs', prefs);
    return { ok: true, url: bgUrl() };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('bg:clear', () => {
  prefs.bgFile = '';
  savePrefs(prefs);
  sendUI('prefs', prefs);
  return true;
});
ipcMain.handle('bg:url', () => bgUrl());
ipcMain.handle('newtab:topSites', () => {
  const seen = new Map();
  History.search('', 800).forEach((h) => {
    try {
      const host = new URL(h.url).hostname.replace(/^www\./, '');
      const cur = seen.get(host);
      if (!cur || (h.visits || 1) > cur.visits) {
        seen.set(host, { url: h.url, title: h.title || host, host, visits: h.visits || 1 });
      }
    } catch (e) {}
  });
  return [...seen.values()].sort((a, b) => b.visits - a.visits).slice(0, 12);
});

ipcMain.handle('tab:newPrivate', (_e, url) => createTab(url || homeUrl(), { private: true }));
ipcMain.handle('anon:apply', async () => {
  Anon.applyDns();
  const r = await Anon.applyProxy(session.fromPartition('persist:main'));
  for (const [, t] of tabs) { try { Anon.harden(t.view.webContents); } catch (e) {} }
  return r;
});
ipcMain.handle('anon:checkIp', () => Anon.checkIp(session.fromPartition('persist:main')));
ipcMain.handle('anon:doh', () => Anon.dohList());

ipcMain.handle('hist:search', (_e, q) => History.search(q));
ipcMain.handle('hist:suggest', (_e, q) => History.suggest(q));

// ── omnibar suggestions ───────────────────────────────────────────
// One ranked list, so the dropdown does not have to fetch and merge three
// sources on every keystroke. The first row is always what Enter would do
// right now, so the list never disagrees with the keyboard.
ipcMain.handle('omni:suggest', (_e, raw) => {
  const q = String(raw || '').trim();
  if (!q) return [];
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = (item.url || '').replace(/\/+$/, '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  const hasScheme = /^[a-z]+:\/\//i.test(q);
  const looksDomain = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(q) && !/\s/.test(q);

  // What Enter does, spelled out.
  if (hasScheme || looksDomain) {
    const url = hasScheme ? q : 'https://' + q;
    push({ kind: 'url', title: q, url, sub: 'Open this address' });
  } else {
    push({ kind: 'search', title: q, url: searchUrl(q), sub: 'Search with ' + engine().name });
  }

  const needle = q.toLowerCase();
  // Bookmarks first: the user kept these on purpose.
  try {
    loadBM().forEach((n) => {
      if (out.length > 3 || n.type === 'folder' || !n.url) return;
      if ((n.title || '').toLowerCase().includes(needle) || n.url.toLowerCase().includes(needle)) {
        push({ kind: 'bookmark', title: n.title || n.url, url: n.url, sub: 'Bookmark' });
      }
    });
  } catch (e) {}

  try {
    History.suggest(q, 8).forEach((h) => {
      if (out.length >= 9) return;
      push({ kind: 'history', title: h.title || h.url, url: h.url, sub: hostOf(h.url) });
    });
  } catch (e) {}

  return out.slice(0, 9);
});

function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return u; }
}
ipcMain.handle('hist:remove', (_e, url) => { History.remove(url); return true; });
ipcMain.handle('hist:clear', (_e, sinceMs) => { History.clear(sinceMs); return true; });

ipcMain.handle('find:start', (_e, { text, forward = true, findNext = false }) => {
  const t = tabs.get(activeId);
  if (!t || !text) return 0;
  return t.view.webContents.findInPage(text, { forward, findNext, matchCase: false });
});
ipcMain.handle('find:stop', (_e, keep) => {
  const t = tabs.get(activeId);
  if (t) t.view.webContents.stopFindInPage(keep ? 'keepSelection' : 'clearSelection');
});

ipcMain.handle('engines:list', () => Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name })));
ipcMain.handle('zoom:set', (_e, dir) => {
  const t = tabs.get(activeId);
  if (!t) return 100;
  const wc = t.view.webContents;
  if (dir === 0) wc.setZoomLevel(0);
  else wc.setZoomLevel(wc.getZoomLevel() + (dir > 0 ? 0.5 : -0.5));
  return Math.round(wc.getZoomFactor() * 100);
});
ipcMain.handle('zoom:get', () => {
  const t = tabs.get(activeId);
  return t ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100;
});
ipcMain.handle('page:print', () => {
  const t = tabs.get(activeId);
  if (t) t.view.webContents.print({}, () => {});
});

ipcMain.handle('bm:tree', () => loadBM());
ipcMain.handle('bm:addFolder', (_e, name) => {
  const tree = loadBM();
  tree.push({ id: bmSeq++, type: 'folder', title: String(name || 'New folder').slice(0, 40), children: [] });
  saveBM(tree);
  return true;
});
ipcMain.handle('bm:rename', (_e, { id, title }) => {
  const tree = loadBM();
  const hit = bmFind(tree, id);
  if (!hit) return false;
  hit.node.title = String(title || '').slice(0, 80) || hit.node.title;
  saveBM(tree);
  return true;
});
ipcMain.handle('bm:remove', (_e, id) => {
  const tree = loadBM();
  const hit = bmFind(tree, id);
  if (!hit) return false;
  hit.list.splice(hit.list.indexOf(hit.node), 1);
  saveBM(tree);
  return true;
});
// Move a bookmark into a folder (or back out to the bar with folderId = null).
ipcMain.handle('bm:moveTo', (_e, { id, folderId }) => {
  const tree = loadBM();
  const hit = bmFind(tree, id);
  if (!hit) return false;
  hit.list.splice(hit.list.indexOf(hit.node), 1);
  if (folderId) {
    const dest = bmFind(tree, folderId);
    if (dest && dest.node.type === 'folder') { dest.node.children = dest.node.children || []; dest.node.children.push(hit.node); }
    else tree.push(hit.node);
  } else tree.push(hit.node);
  saveBM(tree);
  return true;
});
ipcMain.handle('bm:folders', () => loadBM().filter((n) => n.type === 'folder').map((f) => ({ id: f.id, title: f.title })));

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openExternal', (_e, u) => shell.openExternal(u));
