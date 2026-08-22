/**
 * Browsing history — stored locally, searchable, and easy to wipe.
 *
 * Kept deliberately simple: an append-style JSON log capped at a sane size,
 * de-duplicated per URL so revisiting a page bumps it rather than spamming
 * the list. Never leaves the machine.
 *
 * Two things here are shaped by measurement rather than taste:
 *
 *   • Lookups go through a Map, not a scan. add() runs on every navigation
 *     and setTitle() several times per page; both used to walk the whole
 *     list looking for a matching URL, which is 5000 string comparisons on a
 *     full history, on the navigation path.
 *   • Each entry carries a prepared lowercase haystack. Search used to
 *     lowercase every title and URL on every keystroke — two fresh string
 *     allocations per entry per key, which is where a big history turns
 *     typing in the address bar into work.
 */
const fs = require('fs');
const path = require('path');

let FILE = '';
let list = [];              // newest first
const byUrl = new Map();    // url -> the entry object held in `list`
let dirty = false;
const MAX = 5000;

// What search actually matches against, built once when an entry changes.
function haystack(h) {
  h._s = ((h.title || '') + ' ' + h.url).toLowerCase();
  return h;
}

function reindex() {
  byUrl.clear();
  list.forEach((h) => { haystack(h); byUrl.set(h.url, h); });
}

function install(dataDir) {
  FILE = path.join(dataDir, 'history.json');
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch (e) { list = []; }
  reindex();
  setInterval(flush, 15000);
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    // The prepared haystack is derived data — rebuilt on load, never stored.
    const out = list.slice(0, MAX).map(({ _s, ...rest }) => rest);
    fs.writeFileSync(FILE, JSON.stringify(out));
  } catch (e) {}
}

function add(url, title) {
  if (!url || /^(about:|chrome:|devtools:|data:)/i.test(url)) return;
  const now = Date.now();
  const existing = byUrl.get(url);
  if (existing) {
    existing.at = now;
    existing.visits = (existing.visits || 1) + 1;
    if (title) existing.title = title;
    haystack(existing);
    // Move it to the front. Only ever a pointer shuffle, and only for a page
    // that was actually revisited.
    const i = list.indexOf(existing);
    if (i > 0) { list.splice(i, 1); list.unshift(existing); }
  } else {
    const entry = haystack({ url, title: title || url, at: now, visits: 1 });
    list.unshift(entry);
    byUrl.set(url, entry);
    while (list.length > MAX) {
      const dropped = list.pop();
      if (dropped) byUrl.delete(dropped.url);
    }
  }
  dirty = true;
}

function setTitle(url, title) {
  if (!url || !title) return;
  const h = byUrl.get(url);
  if (h && h.title !== title) { h.title = title; haystack(h); dirty = true; }
}

function search(q, limit = 300) {
  const s = String(q || '').toLowerCase().trim();
  const src = s ? list.filter((h) => h._s.includes(s)) : list;
  return src.slice(0, limit);
}

function remove(url) {
  const h = byUrl.get(url);
  if (!h) return;
  byUrl.delete(url);
  const i = list.indexOf(h);
  if (i !== -1) list.splice(i, 1);
  dirty = true;
}

function clear(sinceMs) {
  if (!sinceMs) list = [];
  else { const cut = Date.now() - sinceMs; list = list.filter((h) => h.at < cut); }
  reindex();
  dirty = true;
  flush();
}

// Omnibar suggestions: most-visited / most-recent matches for what's typed.
// Stops scanning once it has plenty to rank, so a common prefix on a full
// history does not walk all 5000 entries before returning eight of them.
function suggest(q, limit = 8) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return [];
  const hits = [];
  const enough = limit * 8;
  for (let i = 0; i < list.length; i++) {
    if (list[i]._s.includes(s)) {
      hits.push(list[i]);
      if (hits.length >= enough) break;
    }
  }
  return hits
    .sort((a, b) => (b.visits || 1) - (a.visits || 1) || b.at - a.at)
    .slice(0, limit)
    .map((h) => ({ url: h.url, title: h.title }));
}

module.exports = { install, add, setTitle, search, remove, clear, suggest, flush };
