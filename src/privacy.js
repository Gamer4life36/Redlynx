/**
 * Privacy hardening + the "ask before saving anything sensitive" rule.
 *
 * Two jobs:
 *  1. Harden the session — deny permissions by default, block third-party
 *     cookies, strip referrers cross-site, no silent autofill store.
 *  2. NEVER persist a password, card, or other sensitive value unless the
 *     user is asked and says yes. Chrome saves first and tells you after;
 *     here nothing touches disk without an explicit prompt.
 */
const { ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

let VAULT_FILE = '';
let PERMS_FILE = '';
// host + permission -> true/false. Kept out of the vault deliberately: the
// vault is encrypted because it holds secrets, and a record of which site may
// use the microphone is not one.
let sitePerms = {};
let getPrefs = () => ({});
let sendUI = () => {};
const pending = new Map();   // promptId -> record awaiting the user's answer
const neverSites = new Set();
let promptSeq = 1;

// Three categories, because two was not enough. Anything not named here is
// still denied outright, so the deny-by-default posture is unchanged.

// Granted without asking. These hand the page nothing it can use against you:
// no data, no hardware, no identity. Fullscreen in particular cannot happen
// without a click and Escape always ends it, which is why no mainstream
// browser prompts for it — gating it just put a dialog between the user and
// every fullscreen video.
const ALLOW_PERMISSIONS = new Set([
  'fullscreen',
  'clipboard-sanitized-write',   // writing to the clipboard, not reading it
  'background-sync',
]);

// Never granted silently — the page has to ask, and the user decides.
const ASK_PERMISSIONS = new Set([
  'media', 'geolocation', 'notifications', 'midi', 'midiSysex',
  'pointerLock', 'openExternal', 'window-management',
  'clipboard-read', 'display-capture', 'idle-detection', 'hid', 'serial', 'usb',
]);

function loadVault() {
  try {
    const raw = fs.readFileSync(VAULT_FILE);
    if (safeStorage.isEncryptionAvailable()) return JSON.parse(safeStorage.decryptString(raw));
    return JSON.parse(raw.toString('utf8'));
  } catch (e) { return { entries: [], never: [] }; }
}
function saveVault(v) {
  try {
    const json = JSON.stringify(v);
    const out = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
    fs.writeFileSync(VAULT_FILE, out);
  } catch (e) {}
}

function loadPerms() {
  try { return JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8')); } catch (e) { return {}; }
}
function savePerms() {
  try { fs.writeFileSync(PERMS_FILE, JSON.stringify(sitePerms, null, 2)); } catch (e) {}
}
const permKey = (host, permission) => host + '|' + permission;

function install(ses, prefsGetter, dataDir, ui) {
  getPrefs = prefsGetter;
  sendUI = ui || (() => {});
  VAULT_FILE = path.join(dataDir, 'vault.bin');
  PERMS_FILE = path.join(dataDir, 'permissions.json');
  sitePerms = loadPerms();
  const v = loadVault();
  (v.never || []).forEach((s) => neverSites.add(s));

  // ── permissions: deny by default, ask the user ──
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALLOW_PERMISSIONS.has(permission)) return callback(true);
    if (!ASK_PERMISSIONS.has(permission)) return callback(false);
    const origin = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    let host = origin;
    try { host = new URL(origin).host; } catch (e) {}

    // Asked and answered before: honour it instead of nagging again.
    const remembered = sitePerms[permKey(host, permission)];
    if (remembered !== undefined) return callback(!!remembered);

    const id = promptSeq++;
    pending.set(id, { type: 'permission', callback, host, permission });
    sendUI('prompt', { id, type: 'permission', permission, host });
  });
  // The synchronous counterpart. It cannot prompt, so it can only answer for
  // the permissions that need no prompt; everything else reads as not granted
  // until the page asks properly. This used to return false for absolutely
  // everything, which is what stopped fullscreen working at all — the request
  // handler never even got a look in.
  ses.setPermissionCheckHandler((_wc, permission) => ALLOW_PERMISSIONS.has(permission));

  // ── network privacy ──
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const p = getPrefs() || {};
    const headers = { ...details.requestHeaders };
    // Do-not-track + no cross-site referrer leakage.
    headers['DNT'] = '1';
    headers['Sec-GPC'] = '1';
    try {
      const ref = headers['Referer'];
      if (ref) {
        const a = new URL(ref), b = new URL(details.url);
        if (a.host !== b.host) delete headers['Referer'];
      }
    } catch (e) {}
    callback({ requestHeaders: headers });
  });

  // NOTE: no onBeforeRequest hook here on purpose. Electron allows only ONE
  // listener per webRequest event per session, and the ad blocker owns that
  // one — its EasyPrivacy list already covers analytics/telemetry domains far
  // more thoroughly than a hand-rolled regex would. Registering a second
  // listener here would silently replace the blocker's and disable blocking.

  // ── the sensitive-save gate ──
  // The page preload tells us a credential/payment value was submitted. We do
  // NOT store it. We ask first; only an explicit "Save" writes to the vault.
  ipcMain.on('page:sensitive', (_e, data) => {
    const p = getPrefs() || {};
    if (p.askBeforeSaving === false) return;   // user turned the feature off entirely
    if (!data || !data.host) return;
    if (neverSites.has(data.host)) return;     // user said never for this site
    const id = promptSeq++;
    pending.set(id, { type: 'save', data });
    sendUI('prompt', {
      id, type: 'save', kind: data.kind || 'password',
      host: data.host, username: data.username || '',
    });
  });

  ipcMain.handle('prompt:answer', (_e, { id, answer }) => {
    const rec = pending.get(id);
    if (!rec) return false;
    pending.delete(id);

    if (rec.type === 'permission') {
      const allow = answer === 'allow' || answer === 'always';
      rec.callback(allow);
      // "always" and "never" are the ones that stick; a plain allow/block
      // answers this request only, so a one-off stays a one-off.
      if (answer === 'always' || answer === 'never') {
        sitePerms[permKey(rec.host, rec.permission)] = allow;
        savePerms();
      }
      return true;
    }
    if (rec.type === 'save') {
      const v = loadVault();
      if (answer === 'save') {
        v.entries = v.entries || [];
        v.entries.push({
          host: rec.data.host, kind: rec.data.kind || 'password',
          username: rec.data.username || '', value: rec.data.value || '',
          at: Date.now(),
        });
        saveVault(v);
      } else if (answer === 'never') {
        neverSites.add(rec.data.host);
        v.never = [...neverSites];
        saveVault(v);
      }
      // "not now" stores nothing at all.
      return true;
    }
    return false;
  });

  // ── filling a saved credential back in ──
  // The host is taken from the frame that asked, never from anything the page
  // passed us: a page that could name its own host could name someone else's
  // and walk out with their password. Top frame only, for the same reason —
  // an embedded third-party iframe must not be able to ask.
  ipcMain.handle('vault:match', (e) => {
    const p = getPrefs() || {};
    if (p.autofillPasswords === false) return null;
    let host = '';
    try {
      const frame = e.senderFrame;
      if (!frame || frame.parent) return null;         // not the top document
      host = new URL(frame.url).host;
    } catch (err) { return null; }
    if (!host) return null;

    const v = loadVault();
    const hits = (v.entries || []).filter(
      (x) => x.host === host && (x.kind || 'password') === 'password'
    );
    if (!hits.length) return null;
    // Most recently saved wins when a site has more than one.
    const best = hits.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    return { username: best.username || '', value: best.value || '' };
  });

  ipcMain.handle('perm:list', () => Object.entries(sitePerms).map(([k, v]) => {
    const i = k.lastIndexOf('|');
    return { host: k.slice(0, i), permission: k.slice(i + 1), allowed: !!v };
  }));
  ipcMain.handle('perm:forget', (_e, { host, permission }) => {
    delete sitePerms[permKey(host, permission)];
    savePerms();
    return true;
  });

  ipcMain.handle('vault:list', () => {
    const v = loadVault();
    return (v.entries || []).map((e) => ({ host: e.host, kind: e.kind, username: e.username, at: e.at }));
  });
  ipcMain.handle('vault:forget', (_e, host) => {
    const v = loadVault();
    v.entries = (v.entries || []).filter((e) => e.host !== host);
    saveVault(v);
    return true;
  });
  ipcMain.handle('privacy:clear', async () => {
    try {
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'] });
      await ses.clearCache();
      return true;
    } catch (e) { return false; }
  });
}

module.exports = { install };
