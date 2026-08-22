/**
 * Browsing history — stored locally, searchable, and easy to wipe.
 *
 * Kept deliberately simple: an append-style JSON log capped at a sane size,
 * de-duplicated per URL so revisiting a page bumps it rather than spamming
 * the list. Never leaves the machine.
 */
const fs = require('fs');
const path = require('path');

let FILE = '';
let list = [];          // newest first
let dirty = false;
const MAX = 5000;

function install(dataDir) {
  FILE = path.join(dataDir, 'history.json');
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch (e) { list = []; }
  setInterval(flush, 15000);
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(FILE, JSON.stringify(list.slice(0, MAX))); } catch (e) {}
}

function add(url, title) {
  if (!url || /^(about:|chrome:|devtools:|data:)/i.test(url)) return;
  const now = Date.now();
  const i = list.findIndex((h) => h.url === url);
  if (i !== -1) {
    list[i].at = now;
    list[i].visits = (list[i].visits || 1) + 1;
    if (title) list[i].title = title;
    const [item] = list.splice(i, 1);
    list.unshift(item);
  } else {
    list.unshift({ url, title: title || url, at: now, visits: 1 });
    if (list.length > MAX) list.length = MAX;
  }
  dirty = true;
}

function setTitle(url, title) {
  if (!url || !title) return;
  const h = list.find((x) => x.url === url);
  if (h && h.title !== title) { h.title = title; dirty = true; }
}

function search(q, limit = 300) {
  const s = String(q || '').toLowerCase().trim();
  const src = s ? list.filter((h) =>
    (h.title || '').toLowerCase().includes(s) || h.url.toLowerCase().includes(s)) : list;
  return src.slice(0, limit);
}

function remove(url) { list = list.filter((h) => h.url !== url); dirty = true; }
function clear(sinceMs) {
  if (!sinceMs) list = [];
  else { const cut = Date.now() - sinceMs; list = list.filter((h) => h.at < cut); }
  dirty = true;
  flush();
}

// Omnibar suggestions: most-visited / most-recent matches for what's typed.
function suggest(q, limit = 8) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return [];
  return list
    .filter((h) => (h.title || '').toLowerCase().includes(s) || h.url.toLowerCase().includes(s))
    .sort((a, b) => (b.visits || 1) - (a.visits || 1) || b.at - a.at)
    .slice(0, limit)
    .map((h) => ({ url: h.url, title: h.title }));
}

module.exports = { install, add, setTitle, search, remove, clear, suggest, flush };
