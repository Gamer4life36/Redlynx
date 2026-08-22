/**
 * Ad + tracker blocking, at the network layer.
 *
 * Runs the Ghostery/Cliqz engine against a curated list stack rather than the
 * generic prebuilt one, because YouTube is a special case: it serves ads from
 * the same domain as the video, so only the dedicated uBlock Origin lists
 * (filters.txt + quick-fixes.txt especially) actually shift them. quick-fixes
 * is where uBO ships counter-patches within hours of YouTube changing things,
 * which is why "Refresh filter lists" exists in the Protection panel.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── the list stack ────────────────────────────────────────────────
const LISTS = [
  // Core ads + privacy
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  // uBlock Origin's own filters — these carry the YouTube-specific rules
  'https://ublockorigin.github.io/uAssets/filters/filters.txt',
  'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
  'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
  'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
  'https://ublockorigin.github.io/uAssets/filters/badware.txt',
  'https://ublockorigin.github.io/uAssets/filters/annoyances.txt',
  // AdGuard base (minus EasyList, which we already have) + known ad servers
  'https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
];

let ElectronBlocker = null;
let fetchResources = null;
let blocker = null;
let resourceCount = 0;
let resourcesFile = '';
let boundSession = null;
let enabled = true;
let pushNav = () => {};
let cacheFile = '';
let lastLoad = { at: 0, source: 'none' };
let lastError = '';

const counts = new Map();      // tabId -> blocked since last navigation
const wcToTab = new Map();     // webContents.id -> tabId
let total = 0;

function countFor(tabId) { return counts.get(tabId) || 0; }
function reset(tabId) { counts.set(tabId, 0); }
function totalBlocked() { return total; }
function status() { return { ...lastLoad, enabled, lists: LISTS.length, scriptlets: resourceCount, active: !!(blocker && blocker.__on), error: lastError }; }

function bindTab(tabId, wc) {
  try { wcToTab.set(wc.id, tabId); } catch (e) {}
  counts.set(tabId, 0);
}

// Node ships fetch natively — no polyfill dependency needed.
const fetchFn = (...args) => fetch(...args);

// ── uBlock Origin's resources ─────────────────────────────────────
// The filter lists are only half of what stops a YouTube ad. YouTube serves
// its ads from the same domain as the video itself, so there is no request to
// block; uBO handles it with *scriptlet* rules instead — "+js(json-prune, ...)"
// and friends, which patch the player's own response data in the page.
//
// Those rules name a scriptlet but do not contain it. The bodies live in
// uBO's resources file, and an engine built with fromLists() has none of them
// loaded, which leaves every +js(...) rule in the lists inert. Fetching the
// resources is what actually arms them.
async function loadResources(b) {
  if (!b || !fetchResources) return 0;
  let text = null;
  try { text = fs.readFileSync(resourcesFile, 'utf8'); } catch (e) {}
  if (!text) {
    try {
      text = await fetchResources(fetchFn);
      fs.writeFileSync(resourcesFile, text);
    } catch (e) {
      console.error('[blocker] could not fetch uBO resources:', e && e.message);
      return 0;
    }
  }
  try {
    const sum = crypto.createHash('sha1').update(text).digest('hex');
    b.updateResources(text, sum);
    resourceCount = (b.resources && b.resources.scriptlets) ? b.resources.scriptlets.length : 0;
    return resourceCount;
  } catch (e) {
    console.error('[blocker] resources rejected:', e && e.message);
    return 0;
  }
}

async function build({ useCache = true } = {}) {
  const caching = useCache ? {
    path: cacheFile,
    read: async (p) => fs.promises.readFile(p),
    write: async (p, buf) => fs.promises.writeFile(p, buf),
  } : undefined;

  // Preferred: our curated stack (best YouTube coverage).
  try {
    const b = await ElectronBlocker.fromLists(fetchFn, LISTS, { enableCompression: true }, caching);
    lastLoad = { at: Date.now(), source: 'curated (' + LISTS.length + ' lists)' };
    return b;
  } catch (e1) {
    console.error('[blocker] curated lists failed:', e1 && e1.message);
  }
  // Fallbacks so the browser is never left unprotected.
  try {
    const b = await ElectronBlocker.fromPrebuiltFull(fetchFn);
    lastLoad = { at: Date.now(), source: 'prebuilt full' };
    return b;
  } catch (e2) {}
  try {
    const b = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn);
    lastLoad = { at: Date.now(), source: 'prebuilt ads+tracking' };
    return b;
  } catch (e3) {}
  try {
    lastLoad = { at: Date.now(), source: 'empty (offline)' };
    return ElectronBlocker.empty();
  } catch (e4) { return null; }
}

async function install(ses, getPrefs, dataDir, onChange) {
  pushNav = onChange || (() => {});
  const prefs = getPrefs();
  enabled = prefs.blockAds !== false || prefs.blockTrackers !== false;
  // Cache name is tied to the list stack — changing LISTS invalidates it.
  cacheFile = path.join(dataDir, 'blocker-engine-v2.bin');
  resourcesFile = path.join(dataDir, 'ubo-resources.json');
  // Drop the engine built from the previous list set.
  try { fs.unlinkSync(path.join(dataDir, 'blocker-engine.bin')); } catch (e) {}

  try {
    ({ ElectronBlocker, fetchResources } = require('@ghostery/adblocker-electron'));
  } catch (e) {
    console.error('[blocker] library unavailable:', e.message);
    return;
  }

  blocker = await build({ useCache: true });
  if (!blocker) return;
  // Arms the +js(...) rules — without this, YouTube ads get through.
  await loadResources(blocker);
  boundSession = ses;
  wireCounter();
  if (enabled) enable();
}

function wireCounter() {
  if (!blocker || blocker.__counted) return;
  blocker.__counted = true;
  blocker.on('request-blocked', (request) => {
    total++;
    const tabId = wcToTab.get(request.tabId);
    if (tabId != null) counts.set(tabId, (counts.get(tabId) || 0) + 1);
    pushNav();
  });
}

// Inert on Electron 35+, which is where registerPreloadScript arrived, and
// kept only because of what its absence did.
//
// The library calls it as the *first* thing in enableBlockingInSession. On 33
// it did not exist, so the call threw before reaching the network filters and
// the entire blocker silently did nothing — no cosmetic filtering, no request
// blocking, a shield that always read zero — because the throw was swallowed
// by a bare catch. That is a failure worth keeping a guard against, and it
// costs nothing when the API is present.
function shimPreloadApi(ses) {
  if (!ses || typeof ses.registerPreloadScript === 'function') return;
  ses.registerPreloadScript = ({ filePath }) => {
    const current = typeof ses.getPreloads === 'function' ? ses.getPreloads() : [];
    if (!current.includes(filePath)) ses.setPreloads([...current, filePath]);
    return filePath;                       // stands in for the handle
  };
  ses.unregisterPreloadScript = (id) => {
    try { ses.setPreloads(ses.getPreloads().filter((p) => p !== id)); } catch (e) {}
  };
}

// Split the library's cosmetic work in two: keep its CSS hiding, drop its
// scriptlet injection.
//
// Its injection runs every scriptlet for a page as a separate top-level
// script, and they all declare the same names — "scriptletGlobals" plus a set
// of helpers. The later ones replace the earlier ones' helpers while the
// earlier ones' hooks are still installed and calling them, and on YouTube
// that mismatch stops the app rendering its results entirely.
//
// The preload injects the same scriptlets at document start instead, each in
// its own function scope, which both avoids the collision and lands early
// enough to prune the ad payload before the page's inline scripts read it.
function takeOverCosmetics() {
  const { ipcMain } = require('electron');
  const CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
  try { ipcMain.removeHandler(CHANNEL); } catch (e) {}
  ipcMain.handle(CHANNEL, (event, url, msg) => {
    if (!blocker || !enabled) return;
    let hostname = '', domain = '';
    try {
      hostname = new URL(url).hostname;
      domain = require('tldts-experimental').parse(url).domain || '';
    } catch (e) { return; }
    const isFirstRun = msg === undefined;
    try {
      const { active, styles } = blocker.getCosmeticsFilters({
        domain, hostname, url,
        classes: msg && msg.classes,
        hrefs: msg && msg.hrefs,
        ids: msg && msg.ids,
        getBaseRules: isFirstRun,
        getInjectionRules: false,        // the preload owns these
        getExtendedRules: false,
        getRulesFromHostname: isFirstRun,
        getRulesFromDOM: !isFirstRun,
      });
      if (active === false) return;
      if (styles && styles.length) {
        event.sender.insertCSS(styles, { cssOrigin: 'user' });
      }
    } catch (e) {}
  });
}

function enable() {
  if (!blocker || !boundSession || blocker.__on) return;
  try {
    shimPreloadApi(boundSession);
    blocker.enableBlockingInSession(boundSession);
    takeOverCosmetics();
    blocker.__on = true;
  } catch (e) {
    // Never swallow this again: if it throws, the browser is running with no
    // ad blocking at all, and silence is how that goes unnoticed.
    lastError = String((e && e.message) || e);
    console.error('[blocker] enableBlockingInSession failed:', lastError);
  }
}
function disable() {
  if (!blocker || !boundSession || !blocker.__on) return;
  try { blocker.disableBlockingInSession(boundSession); blocker.__on = false; } catch (e) {}
}

function refresh(prefs) {
  enabled = prefs.blockAds !== false || prefs.blockTrackers !== false;
  if (enabled) enable(); else disable();
}

// Pull fresh lists on demand — the answer when YouTube changes tactics.
async function refreshLists() {
  if (!ElectronBlocker) return { ok: false, error: 'blocker unavailable' };
  const wasOn = blocker && blocker.__on;
  try { if (wasOn) disable(); } catch (e) {}
  try { fs.unlinkSync(cacheFile); } catch (e) {}
  // The scriptlets go stale the same way the lists do — this is the button
  // people press when YouTube has changed tactics, so refresh both.
  try { fs.unlinkSync(resourcesFile); } catch (e) {}
  const fresh = await build({ useCache: true });
  if (!fresh) return { ok: false, error: 'could not rebuild' };
  blocker = fresh;
  await loadResources(blocker);
  scriptletCache.clear();          // built from the old engine
  wireCounter();
  if (enabled) enable();
  return { ok: true, ...status() };
}

// The scriptlets a page needs, for the preload to inject at document start.
// The library's own injection path arrives too late to beat a site's inline
// scripts, which is exactly what YouTube's ad scheduling relies on.
// Normally null, meaning "all of them". The dev endpoint can narrow this to
// a window of indexes, which is how a rule that breaks a site gets found.
let scriptletRange = null;
function setScriptletRange(r) {
  scriptletRange = Array.isArray(r) ? r : [0, 0];
  scriptletCache.clear();          // cached answers used the old window
  return scriptletRange;
}

// The preload asks for this synchronously on every frame, and a page with a
// dozen iframes asks a dozen times for the same hostname. The answer only
// depends on the host, so compute it once and hand back the same array.
const scriptletCache = new Map();
function cacheKey(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}

function scriptletsFor(url) {
  if (!blocker || !enabled) return [];
  const key = cacheKey(url);
  if (scriptletCache.has(key)) return scriptletCache.get(key);
  const out = computeScriptlets(url);
  // Bounded so a long session cannot grow it without limit.
  if (scriptletCache.size > 400) scriptletCache.clear();
  scriptletCache.set(key, out);
  return out;
}

// Rules that measurably break a page when injected at document start.
//
// uBlock Origin ships these and they are fine in the extension, but ours land
// at a slightly different point relative to the page's own bootstrap and this
// one leaves YouTube waiting on an ad slot that can never fill: bisected to a
// single rule, 12.5s before the first frame against 0.4s without it, on every
// run. Ad blocking is not weakened by dropping it — adPlacements and
// playerAds are what actually schedule the ads and both are still pruned.
// Matched as plain substrings — the compiled rule text contains a literal
// backslash before the dot, which a regex would only obscure.
const SCRIPTLET_SKIP = [
  {
    why: 'set-constant on adSlots stalls YouTube playback ~12s',
    hit: (code) => code.indexOf('setConstant') !== -1 &&
                   code.indexOf('ytInitialPlayerResponse') !== -1 &&
                   code.indexOf('adSlots') !== -1,
  },
];

function computeScriptlets(url) {
  if (!blocker || !enabled) return [];
  let hostname = '';
  let domain = '';
  try {
    hostname = new URL(url).hostname;
    try {
      domain = require('tldts-experimental').parse(url).domain || '';
    } catch (e) {
      // Good enough when tldts is unavailable: last two labels.
      const bits = hostname.split('.');
      domain = bits.slice(-2).join('.');
    }
  } catch (e) { return []; }
  if (!hostname) return [];
  try {
    const { active, scripts } = blocker.getCosmeticsFilters({
      domain, hostname, url,
      getBaseRules: false,          // styles are handled by the library
      getInjectionRules: true,      // +js(...) rules — the point of this
      getRulesFromHostname: true,
      getExtendedRules: false,
      getRulesFromDOM: false,
    });
    if (active === false) return [];
    const all = (scripts || []).filter(
      (code) => !SCRIPTLET_SKIP.some((s) => s.hit(code))
    );
    return scriptletRange ? all.slice(scriptletRange[0], scriptletRange[1]) : all;
  } catch (e) { return []; }
}

// Diagnostic: what cosmetic CSS the engine would hide on a given page.
function stylesFor(url) {
  if (!blocker) return { err: 'no engine' };
  let hostname = '', domain = '';
  try {
    hostname = new URL(url).hostname;
    domain = require('tldts-experimental').parse(url).domain || '';
  } catch (e) { return { err: 'bad url' }; }
  try {
    const r = blocker.getCosmeticsFilters({
      domain, hostname, url,
      getBaseRules: true, getInjectionRules: false,
      getRulesFromHostname: true, getExtendedRules: true, getRulesFromDOM: false,
    });
    const css = r.styles || '';
    return {
      active: r.active,
      length: css.length,
      hasAdSlot: css.indexOf('ytd-ad-slot-renderer') !== -1,
      hasPyv: css.indexOf('ytd-search-pyv-renderer') !== -1,
      css: css,
    };
  } catch (e) { return { err: String(e && e.message) }; }
}

module.exports = {
  install, refresh, refreshLists, status, scriptletsFor, setScriptletRange, stylesFor,
  countFor, reset, bindTab, totalBlocked, isEnabled: () => enabled,
};
