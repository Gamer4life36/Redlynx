/**
 * Runs inside every web page (sandboxed, isolated world).
 *
 * Two jobs, and nothing else — it exposes no API to the page:
 *   1. Spot downloadable media so the browser can offer to grab it.
 *   2. Notice when a credential/payment value is submitted, so the browser can
 *      ASK whether to save it. The value is never written anywhere by this
 *      script; it only travels to the main process, which prompts first.
 */
const { ipcRenderer } = require('electron');

// ── 0. Arm uBlock Origin's scriptlets, before the page runs ────────
// YouTube's ads are scheduled inside the player response its own inline
// script assigns on the way down, so a scriptlet that prunes that object has
// to be running *first*. The blocker library injects its scriptlets over IPC
// from the main process, and that round-trip loses the race every time — by
// the time the script arrives, ytInitialPlayerResponse already exists.
//
// A preload runs before any page script, so this asks for the scriptlets
// synchronously and injects them the way a real extension does: as a <script>
// element in the page's own world, executed on the spot. sendSync blocks, but
// only for one local call at document start.
(function armScriptlets() {
  let scripts = [];
  try {
    scripts = ipcRenderer.sendSync('rlx:scriptlets', location.href) || [];
  } catch (e) { return; }
  if (!scripts.length) return;

  // YouTube (and a growing number of sites) send
  // "require-trusted-types-for 'script'", which refuses a plain string
  // assigned to script.textContent. A policy of our own satisfies that
  // without weakening the page's — we are handing it code we produced.
  let asScript = (s) => s;
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      const pol = window.trustedTypes.createPolicy('rlx-scriptlets', {
        createScript: (s) => s,
      });
      asScript = (s) => pol.createScript(s);
    }
  } catch (e) {}

  let done = 0;
  const inject = (code) => {
    // A <script> element runs synchronously in the page's own world the
    // moment it is attached, which is what makes this beat the site's code.
    const el = document.createElement('script');
    // Each scriptlet is wrapped in its own function scope. They are compiled
    // to run one per injection, and every one of them declares the same
    // top-level names — "scriptletGlobals" plus a set of helpers. Injected as
    // plain sibling scripts they share a global scope, so the second one
    // silently replaces the first one's helpers while the first one's hooks
    // are still installed and calling them. That mismatch is what took the
    // page down: individually any of these is fine, any two together were not.
    el.textContent = asScript('(function(){' + code + '\n})();');
    const host = document.documentElement || document.head || document.body;
    if (!host) return false;
    host.appendChild(el);
    el.remove();                   // it has already run; leave no trace
    done++;
    return true;
  };

  const runAll = () => {
    scripts.forEach((code) => { try { inject(code); } catch (e) {} });
  };

  try {
    if (document && document.documentElement) {
      runAll();
    } else {
      // Nothing to attach to yet — take the first moment there is one.
      const mo = new MutationObserver(() => {
        if (!document.documentElement) return;
        mo.disconnect();
        runAll();
      });
      mo.observe(document, { childList: true, subtree: true });
    }
  } catch (e) {}
})();

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v|ogv|avi|flv|ts|m3u8|mpd)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|opus|ogg)(\?|#|$)/i;

const seen = new Set();
let pendingItems = [];
let flushTimer = null;

function kindOf(url) {
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return 'stream';
  if (VIDEO_EXT.test(url)) return 'video';
  if (AUDIO_EXT.test(url)) return 'audio';
  if (IMAGE_EXT.test(url)) return 'image';
  return null;
}

function push(url, kind, extra) {
  if (!url || seen.has(url)) return;
  if (/^(data|blob|about):/i.test(url)) return;
  let abs = url;
  try { abs = new URL(url, location.href).href; } catch (e) { return; }
  if (seen.has(abs)) return;
  seen.add(abs);
  pendingItems.push({ url: abs, kind: kind || kindOf(abs) || 'file', ...(extra || {}) });
  if (!flushTimer) flushTimer = setTimeout(flush, 400);
}

function flush() {
  flushTimer = null;
  if (!pendingItems.length) return;
  const items = pendingItems.splice(0, pendingItems.length);
  try { ipcRenderer.send('page:media', items); } catch (e) {}
}

function scanDom() {
  try {
    document.querySelectorAll('video').forEach((v) => {
      if (v.currentSrc) push(v.currentSrc, 'video', { width: v.videoWidth, height: v.videoHeight });
      if (v.src) push(v.src, 'video');
      v.querySelectorAll && v.querySelectorAll('source[src]').forEach((s) => push(s.src, 'video'));
    });
    document.querySelectorAll('audio').forEach((a) => {
      if (a.currentSrc) push(a.currentSrc, 'audio');
      if (a.src) push(a.src, 'audio');
    });
    // Only images worth grabbing — skip icons/spacers.
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w >= 240 && h >= 240 && img.currentSrc) push(img.currentSrc, 'image', { width: w, height: h });
    });
  } catch (e) {}
}

// Anything the page actually fetched that looks like media — this is what
// catches HLS streams and XHR-loaded video that never appear in the markup.
function scanNetwork() {
  try {
    if (!performance || !performance.getEntriesByType) return;
    performance.getEntriesByType('resource').forEach((e) => {
      const k = kindOf(e.name);
      if (k) push(e.name, k);
    });
  } catch (e) {}
}

function scanAll() { scanDom(); scanNetwork(); }

window.addEventListener('DOMContentLoaded', () => {
  scanAll();
  setTimeout(scanAll, 1500);
  setTimeout(scanAll, 4000);
  try {
    const mo = new MutationObserver(() => { clearTimeout(window.__icScan); window.__icScan = setTimeout(scanAll, 700); });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'currentSrc'] });
  } catch (e) {}
});
window.addEventListener('load', () => setTimeout(scanAll, 800));

// Only keep scanning while the tab is actually on screen, and back off the
// longer a page sits idle — a pinned background tab should cost nothing.
let idleRounds = 0;
function tick() {
  if (document.hidden) return schedule(4000);
  const before = seen.size;
  scanNetwork();
  idleRounds = seen.size === before ? Math.min(idleRounds + 1, 5) : 0;
  schedule(3000 + idleRounds * 4000);      // 3s hot -> 23s idle
}
let timer = null;
function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(400); });
schedule(3000);

// ── sensitive values: ask before anything is saved ────────────────
const CARD_RE = /^[\d ]{13,23}$/;
function looksLikeCard(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  // Luhn — avoids prompting on order numbers and the like.
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function reportSensitive(form) {
  try {
    const pw = form.querySelector('input[type="password"]');
    const inputs = [...form.querySelectorAll('input')];
    let kind = null, value = '', username = '';

    if (pw && pw.value) {
      kind = 'password';
      value = pw.value;
      const u = inputs.find((i) => /user|email|login|account/i.test(i.name + ' ' + i.id + ' ' + i.autocomplete) && i.type !== 'password');
      username = (u && u.value) || '';
    } else {
      const card = inputs.find((i) => (/cc-number|card/i.test(i.autocomplete + ' ' + i.name + ' ' + i.id)) && CARD_RE.test(i.value) && looksLikeCard(i.value));
      if (card) { kind = 'card'; value = card.value; }
    }
    if (!kind) return;
    ipcRenderer.send('page:sensitive', { kind, value, username, host: location.host, url: location.href });
  } catch (e) {}
}

document.addEventListener('submit', (e) => {
  if (e.target && e.target.tagName === 'FORM') reportSensitive(e.target);
}, true);
// Many sites submit via JS instead of a real form submit.
document.addEventListener('click', (e) => {
  try {
    const btn = e.target.closest && e.target.closest('button, input[type="submit"]');
    if (!btn) return;
    const form = btn.closest('form');
    if (form && form.querySelector('input[type="password"]')) setTimeout(() => reportSensitive(form), 60);
  } catch (err) {}
}, true);
