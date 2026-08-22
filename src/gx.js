/**
 * Control — the Opera GX-style resource governor, done for real.
 *
 *   • CPU limiter     — throttles page execution (CDP Emulation.setCPUThrottlingRate)
 *   • Network limiter — caps per-tab bandwidth  (CDP Network.emulateNetworkConditions)
 *   • RAM limiter     — watches real process memory and suspends the biggest
 *                       idle tabs when the browser crosses your ceiling
 *   • Hot tabs        — live per-tab CPU/RAM, so you can kill the pig
 *   • Force dark      — dark-mode any site
 *   • Pop-out video   — picture-in-picture on the active tab
 *
 * The limiters are applied per-tab as tabs are created, and re-applied when
 * the user moves a slider.
 */
const { app } = require('electron');

const attached = new Map();   // tabId -> { wc, ok }
let getPrefs = () => ({});
let onSuspend = () => {};
let getTabs = () => [];

function install(opts) {
  getPrefs = opts.getPrefs;
  onSuspend = opts.onSuspend || (() => {});
  getTabs = opts.getTabs || (() => []);
  setInterval(enforceRam, 15000);
}

// Is anything actually being limited? Attaching the debugger is not free —
// enabling its Network domain puts every request and every response chunk
// through the debugging pipe, which is real load-time cost on a heavy page.
// So the governor stays off the wire until a slider is actually moved.
function limitsActive(p) {
  const cpu = Number((p || {}).cpuLimit) || 100;
  const net = Number((p || {}).netLimit) || 0;
  return cpu < 100 || net > 0;
}

// ── attach CDP to a tab so we can govern it ───────────────────────
function bindTab(tabId, wc) {
  attached.set(tabId, { wc, ok: false });
  if (limitsActive(getPrefs())) attachCdp(tabId);
  wc.on('destroyed', () => attached.delete(tabId));
}

function attachCdp(tabId) {
  const a = attached.get(tabId);
  if (!a || a.ok) return false;
  try {
    if (!a.wc.debugger.isAttached()) a.wc.debugger.attach('1.3');
    a.ok = true;
    return true;
  } catch (e) {
    a.ok = false;
    return false;
  }
}

// Put the tab back to full speed and let go of the debugger entirely.
async function detachCdp(tabId) {
  const a = attached.get(tabId);
  if (!a || !a.ok) return;
  try { await a.wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch (e) {}
  try { await a.wc.debugger.sendCommand('Network.disable', {}); } catch (e) {}
  try { a.wc.debugger.detach(); } catch (e) {}
  a.ok = false;
}

function unbind(tabId) {
  const a = attached.get(tabId);
  if (a && a.ok) { try { a.wc.debugger.detach(); } catch (e) {} }
  attached.delete(tabId);
}

// ── apply the current limits to one tab ───────────────────────────
async function apply(tabId) {
  const a = attached.get(tabId);
  if (!a) return;
  const p = getPrefs() || {};

  // Nothing to govern: make sure we are not holding the debugger open.
  if (!limitsActive(p)) {
    if (a.ok) await detachCdp(tabId);
    return;
  }
  if (!a.ok && !attachCdp(tabId)) return;
  const wc = a.wc;

  // CPU: 1 = full speed, higher = slower. Slider is "max %" so invert it.
  const cpuPct = Math.max(10, Math.min(100, Number(p.cpuLimit) || 100));
  const rate = cpuPct >= 100 ? 1 : +(100 / cpuPct).toFixed(2);
  try { await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate }); } catch (e) {}

  // Network: cap in Mbps (0/blank = unlimited).
  const mbps = Number(p.netLimit) || 0;
  try {
    if (mbps > 0) {
      const bps = (mbps * 1000000) / 8;
      await wc.debugger.sendCommand('Network.enable', {});
      await wc.debugger.sendCommand('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: bps, uploadThroughput: bps,
      });
    } else {
      // A CPU limit is set but no network cap — leave the Network domain
      // alone rather than enabling it just to say "unlimited".
      await wc.debugger.sendCommand('Network.disable', {});
    }
  } catch (e) {}
}

function applyAll() { for (const [id] of attached) apply(id); }

// ── RAM ceiling ───────────────────────────────────────────────────
// When the browser's total private memory crosses the limit, suspend the
// least-recently-used tabs until it is back under.
function enforceRam() {
  const p = getPrefs() || {};
  const limitMb = Number(p.ramLimit) || 0;
  if (!limitMb) return;
  const used = totalMemoryMb();
  if (used <= limitMb) return;
  const tabs = getTabs()
    .filter((t) => !t.active && !t.suspended && !t.pinned)
    .sort((a, b) => a.lastActive - b.lastActive);
  for (const t of tabs) {
    onSuspend(t.id);
    if (totalMemoryMb() <= limitMb) break;
  }
}

function totalMemoryMb() {
  try {
    return Math.round(app.getAppMetrics().reduce((s, m) => s + ((m.memory && m.memory.workingSetSize) || 0), 0) / 1024);
  } catch (e) { return 0; }
}

// ── hot tabs (task manager) ───────────────────────────────────────
function hotTabs(tabList) {
  let metrics = [];
  try { metrics = app.getAppMetrics(); } catch (e) {}
  const byPid = new Map(metrics.map((m) => [m.pid, m]));
  const rows = [];
  for (const t of tabList) {
    let pid = 0;
    try { pid = t.wc.getOSProcessId(); } catch (e) {}
    const m = byPid.get(pid);
    rows.push({
      id: t.id, title: t.title, suspended: !!t.suspended,
      cpu: m && m.cpu ? +m.cpu.percentCPUUsage.toFixed(1) : 0,
      memMb: m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : 0,
    });
  }
  return {
    totalMb: totalMemoryMb(),
    rows: rows.sort((a, b) => b.memMb - a.memMb),
  };
}

// ── force dark ────────────────────────────────────────────────────
const DARK_CSS = `
  html { filter: invert(1) hue-rotate(180deg) !important; background: #111 !important; }
  img, video, picture, canvas, svg, iframe, [style*="background-image"] {
    filter: invert(1) hue-rotate(180deg) !important;
  }
`;
async function setDark(wc, on) {
  try {
    if (on) {
      if (wc.__darkKey) return;
      wc.__darkKey = await wc.insertCSS(DARK_CSS);
    } else if (wc.__darkKey) {
      await wc.removeInsertedCSS(wc.__darkKey);
      wc.__darkKey = null;
    }
  } catch (e) {}
}

// ── pop-out video (picture-in-picture) ────────────────────────────
async function popOut(wc) {
  try {
    const r = await wc.executeJavaScript(`(async () => {
      const v = [...document.querySelectorAll('video')]
        .sort((a,b) => (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight))[0];
      if (!v) return 'no-video';
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'closed'; }
      await v.requestPictureInPicture();
      return 'ok';
    })()`, true);
    return r;
  } catch (e) { return 'error'; }
}

module.exports = { install, bindTab, unbind, apply, applyAll, hotTabs, setDark, popOut, totalMemoryMb };
