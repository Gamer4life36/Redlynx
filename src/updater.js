/**
 * Update checking.
 *
 * A browser that cannot update itself is the one thing on this list with a
 * real security cost: whatever is installed is what stays installed, holes
 * included. The filter lists refresh themselves; the application could not.
 *
 * Two deliberate choices:
 *
 *   • Nothing is installed behind the user's back. An update is downloaded
 *     only after they say yes, and applied only on quit. A browser replacing
 *     itself mid-session is how you lose a tab full of typing.
 *   • A missing or unreachable feed is not an error worth shouting about.
 *     Running from source, or before anything has been published, there is no
 *     release to find — that is the normal state during development, so it is
 *     reported as "no update" rather than a failure dialog.
 */
const { app } = require('electron');

let updater = null;
let sendUI = () => {};
let state = { status: 'idle', version: '', notes: '', error: '' };

function load() {
  if (updater) return updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    return null;
  }
  // We drive the whole thing explicitly.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;

  updater.on('update-available', (info) => {
    state = { status: 'available', version: info.version || '', notes: String(info.releaseNotes || '').slice(0, 2000), error: '' };
    push();
  });
  updater.on('update-not-available', () => {
    state = { status: 'current', version: app.getVersion(), notes: '', error: '' };
    push();
  });
  updater.on('download-progress', (p) => {
    state = { ...state, status: 'downloading', percent: Math.round(p.percent || 0) };
    push();
  });
  updater.on('update-downloaded', (info) => {
    state = { status: 'ready', version: info.version || '', notes: '', error: '' };
    push();
  });
  updater.on('error', (err) => {
    const msg = String((err && err.message) || err);
    // No feed yet, or running unpackaged: not a failure the user needs.
    const benign = /ENOTFOUND|ENOENT|404|no published versions|dev-app-update|not signed/i.test(msg);
    state = benign
      ? { status: 'current', version: app.getVersion(), notes: '', error: '' }
      : { status: 'error', version: '', notes: '', error: msg.slice(0, 300) };
    push();
  });
  return updater;
}

function push() { try { sendUI('update', status()); } catch (e) {} }

function install(ui) {
  sendUI = ui || (() => {});
  // A quiet look on startup, well after the window is up and doing its work.
  setTimeout(() => { check({ silent: true }); }, 25000);
}

function status() {
  return {
    ...state,
    current: app.getVersion(),
    packaged: app.isPackaged,
  };
}

async function check() {
  const u = load();
  if (!u) {
    state = { status: 'error', version: '', notes: '', error: 'updater unavailable' };
    return status();
  }
  if (!app.isPackaged) {
    // electron-updater refuses to run from source, and rightly so — there is
    // nothing to replace. Say that plainly instead of surfacing its error.
    state = { status: 'unpackaged', version: app.getVersion(), notes: '', error: '' };
    return status();
  }
  state = { ...state, status: 'checking', error: '' };
  push();
  try { await u.checkForUpdates(); } catch (e) { /* handled by the error event */ }
  return status();
}

async function download() {
  const u = load();
  if (!u || !app.isPackaged) return status();
  state = { ...state, status: 'downloading', percent: 0 };
  push();
  try { await u.downloadUpdate(); } catch (e) { /* handled by the error event */ }
  return status();
}

// Applied on quit by default; this is for "restart and do it now".
function installNow() {
  const u = load();
  if (!u || !app.isPackaged) return false;
  try { u.quitAndInstall(false, true); return true; } catch (e) { return false; }
}

module.exports = { install, check, download, installNow, status };
