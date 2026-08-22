/**
 * Chrome extension support.
 *
 * Electron can load unpacked extensions into a session, which is what turns a
 * browser with good built-ins into one with an ecosystem — password managers,
 * Dark Reader, SponsorBlock, and anything else you already trust.
 *
 * Two honest limits, both worth knowing before you rely on this:
 *
 *   • Only *unpacked* extensions load. There is no Chrome Web Store install
 *     here, so a .crx has to be unzipped to a folder first. The folder must
 *     contain the manifest.json.
 *   • Electron implements a subset of the extension APIs. Content scripts,
 *     storage, messaging and most of the common surface work; anything
 *     reaching for chrome.tabs internals, devtools panels, or the newer MV3
 *     service-worker corners may not. An extension that needs something
 *     missing usually fails loudly in its own console rather than silently.
 *
 * Paths are remembered so the same set loads on the next launch. A folder that
 * has been moved or deleted is reported rather than dropped quietly, so a
 * missing extension never looks like a working one.
 */
const path = require('path');
const fs = require('fs');

let store = '';                  // where the remembered list lives
let boundSession = null;
const loaded = new Map();        // id -> { id, name, version, path }
const failures = [];             // { path, error }

function readList() {
  try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch (e) { return []; }
}
function writeList(paths) {
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(paths, null, 2));
  } catch (e) {}
}

function describe(ext, dir) {
  return {
    id: ext.id,
    name: (ext.manifest && ext.manifest.name) || ext.name || path.basename(dir),
    version: (ext.manifest && ext.manifest.version) || ext.version || '',
    path: dir,
  };
}

async function loadOne(dir) {
  if (!boundSession) return { ok: false, error: 'no session' };
  try {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      return { ok: false, error: 'no manifest.json in that folder' };
    }
    const ext = await boundSession.extensions.loadExtension(dir, { allowFileAccess: true });
    const info = describe(ext, dir);
    loaded.set(info.id, info);
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function install(ses, dataDir) {
  boundSession = ses;
  store = path.join(dataDir, 'extensions.json');
  failures.length = 0;

  for (const dir of readList()) {
    const r = await loadOne(dir);
    if (!r.ok) {
      failures.push({ path: dir, error: r.error });
      console.error('[extensions] could not load', dir, '-', r.error);
    }
  }
  return list();
}

async function add(dir) {
  const r = await loadOne(dir);
  if (!r.ok) return r;
  const paths = readList();
  if (!paths.includes(dir)) {
    paths.push(dir);
    writeList(paths);
  }
  return r;
}

async function remove(id) {
  const info = loaded.get(id);
  if (!info) return { ok: false, error: 'not loaded' };
  try { boundSession.extensions.removeExtension(id); } catch (e) {}
  loaded.delete(id);
  writeList(readList().filter((p) => p !== info.path));
  return { ok: true };
}

function list() {
  return {
    items: [...loaded.values()],
    failures: [...failures],
  };
}

module.exports = { install, add, remove, list };
