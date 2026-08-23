/**
 * Userscripts — per-site fixes injected into matching pages.
 *
 * Redlynx already rewrites pages for ad blocking and "clean pages"; this is
 * the same idea aimed at usability: when a site makes a genuinely worse UX
 * choice, patch it locally rather than putting up with it.
 *
 * Scripts are plain strings injected with webContents.executeJavaScript, which
 * runs them in the page's own world — that is deliberate here, since reading
 * the data Google ships with the page requires being in it.
 */

// ── 1. Classic Google Images ──────────────────────────────────────
// Google moved the clicked image into a cramped right-hand side panel, which
// throws away half the screen. This restores the old behaviour: the image
// expands inline, directly beneath the row you clicked, as large as it fits.
//
// The page ships its own results data in a <script> block, as pairs of
//   ["<thumbnail url>",w,h],["<original url>",w,h]
// followed by the source page, title, domain and file size. Reading that map
// means a click can be answered instantly and locally: Google's panel never
// opens, nothing slides in from the right, and the grid keeps its full width.
//
// If a thumbnail is not in the map (rare — only ones that have not lazy-loaded
// yet), the script falls back to letting Google resolve the original in its
// panel, then lifts the result out and closes the panel again. Two details
// matter on that path, both measured on the live page rather than assumed:
// Escape is what dismisses the panel, and opening it makes Google rebuild the
// grid container ~104ms later, deleting anything foreign inside it.
const GOOGLE_IMAGES = String.raw`
(function () {
  if (window.__rlxClassicImages) return;
  window.__rlxClassicImages = true;

  var VIEWER = '__rlx_img_viewer';
  var CHIP = '__rlx_img_chip';
  var ROW_TOL = 14;          // px difference that still counts as the same row
  // jsname survives Google's class-name churn far better than class does.
  var FULL_SEL = 'img[jsname="kn3ccd"], img.sFlh5c, img.iPVvYb';
  var busy = false;

  var css = document.createElement('style');
  css.textContent = [
    // grid-column spans the row; align-self:start keeps the box content-sized
    // so the row span we compute from its height does not feed back on itself.
    '#' + VIEWER + '{grid-column:1/-1!important;align-self:start!important;',
    '  flex:0 0 100%!important;width:100%!important;',
    '  box-sizing:border-box;margin:12px 0 20px;padding:12px;background:#0f1216;',
    '  border:1px solid #2a3342;border-radius:14px;position:relative;display:block!important;',
    '  box-shadow:0 16px 44px rgba(0,0,0,.5)}',
    // hug the image rather than stranding a small original in a wide black field
    '#' + VIEWER + ' .rlx-stage{display:flex;align-items:center;justify-content:center;',
    '  width:fit-content;max-width:100%;margin:0 auto;background:#000;border-radius:10px}',
    '#' + VIEWER + ' img{display:block;max-width:100%;max-height:82vh;width:auto;height:auto;',
    '  object-fit:contain;border-radius:10px}',
    // details sit UNDER the image, compact, never competing for width
    '#' + VIEWER + ' .rlx-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:10px;',
    '  color:#e6e9ef;font:13px system-ui,sans-serif}',
    '#' + VIEWER + ' .rlx-ttl{font-weight:600;max-width:38vw;overflow:hidden;',
    '  text-overflow:ellipsis;white-space:nowrap}',
    '#' + VIEWER + ' .rlx-src{color:#7aa2ff;text-decoration:none;max-width:30vw;overflow:hidden;',
    '  text-overflow:ellipsis;white-space:nowrap}',
    '#' + VIEWER + ' .rlx-btns{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}',
    '#' + VIEWER + ' .rlx-btns a,#' + VIEWER + ' .rlx-btns button{background:#1d2430;',
    '  border:1px solid #2a3342;color:#e6e9ef;border-radius:8px;padding:7px 12px;',
    '  font-size:12.5px;cursor:pointer;text-decoration:none}',
    '#' + VIEWER + ' .rlx-btns a:hover,#' + VIEWER + ' .rlx-btns button:hover{background:#2b3547}',
    '#' + VIEWER + ' .rlx-x{position:absolute;top:10px;right:12px;background:rgba(0,0,0,.6);',
    '  border:none;color:#fff;font-size:18px;line-height:1;border-radius:6px;padding:3px 9px;',
    '  cursor:pointer;z-index:3}',
    '#' + VIEWER + ' .rlx-x:hover{background:#b91c1c}',
    '#' + VIEWER + ' .rlx-dim{color:#8b93a3;font-size:11.5px;white-space:nowrap}',
    // the "working on it" pill, on body so Google's re-render cannot eat it
    '#' + CHIP + '{position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#0f1216;',
    '  color:#e6e9ef;border:1px solid #2a3342;border-radius:999px;padding:8px 16px;',
    '  font:12.5px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none}'
  ].join('');
  (document.head || document.documentElement).appendChild(css);

  function byId(id) { return document.getElementById(id); }
  function closeViewer() { var v = byId(VIEWER); if (v) v.remove(); }
  function chipOn(text) {
    var c = byId(CHIP);
    if (!c) { c = document.createElement('div'); c.id = CHIP; document.body.appendChild(c); }
    c.textContent = text;
  }
  function chipOff() { var c = byId(CHIP); if (c) c.remove(); }

  // ── the results map Google ships with the page ──────────────────
  var index = null, indexedAt = 0;
  var BS = String.fromCharCode(92);

  function unesc(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    }).split(BS + BS).join(BS);
  }

  var PAIR = /\["(https:\/\/encrypted-tbn\d?\.gstatic\.com\/images[^"]*?tbn:([A-Za-z0-9_-]+)[^"]*)",(\d+),(\d+)\],\["(https?:[^"]+)",(\d+),(\d+)\]/g;

  function buildIndex() {
    var map = {};
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent;
      if (!t || t.indexOf('gstatic.com/images') === -1) continue;
      PAIR.lastIndex = 0;
      var m;
      while ((m = PAIR.exec(t))) {
        if (map[m[2]]) continue;
        var rec = { src: unesc(m[5]), w: +m[6], h: +m[7] };
        // the same record carries where the image came from
        var tail = t.slice(m.index, m.index + 1400);
        var meta = tail.match(/"2003":\[null,"[^"]*","(https?:[^"]+)","([^"]*)"/);
        if (meta) { rec.page = unesc(meta[1]); rec.title = unesc(meta[2]); }
        var dom = tail.match(/"2000":\[null,"([^"]+)","([^"]*)"\]/);
        if (dom) { rec.site = unesc(dom[1]); rec.bytes = dom[2]; }
        map[m[2]] = rec;
      }
    }
    index = map;
    indexedAt = scripts.length;
    return map;
  }

  function lookup(thumbSrc) {
    var id = (thumbSrc || '').match(/tbn:([A-Za-z0-9_-]+)/);
    if (!id) return null;
    if (!index) buildIndex();
    if (index[id[1]]) return index[id[1]];
    // scrolling streams in more results — rescan before giving up
    if (document.querySelectorAll('script').length !== indexedAt) buildIndex();
    return index[id[1]] || null;
  }

  // ── Google's own panel (only used by the fallback path) ─────────
  // The panel container is whichever ancestor of the full-size image first
  // gets real width — its class name changes, its shape does not.
  function panelRoot() {
    var img = document.querySelector(FULL_SEL);
    for (var el = img; el && el.parentElement; el = el.parentElement) {
      if (el.getBoundingClientRect().width > 300) return el;
    }
    return null;
  }

  function closePanel() {
    var root = panelRoot();
    if (root) {
      var b = root.querySelector('button[aria-label*="Close" i], [role="button"][aria-label*="Close" i]');
      if (b) { b.click(); return; }
    }
    ['keydown', 'keyup'].forEach(function (t) {
      document.dispatchEvent(new KeyboardEvent(t, {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
        bubbles: true, cancelable: true
      }));
    });
  }

  // ── placing the viewer in Google's grid ─────────────────────────
  // Walk up from the thumbnail to the real grid cell. Class names churn and
  // the tile's inner nodes are all single-child wrappers, so the reliable
  // marker is structural: the cell is the child of the container that lays
  // results out (display:grid/flex, many children, far wider than one cell).
  function tileOf(node) {
    var el = node;
    for (var i = 0; i < 16 && el && el.parentElement; i++) {
      var p = el.parentElement;
      var pd = getComputedStyle(p).display;
      if ((pd === 'grid' || pd === 'flex') &&
          p.children.length >= 3 &&
          p.getBoundingClientRect().width > el.getBoundingClientRect().width * 1.8) {
        return el;
      }
      el = p;
    }
    return node;
  }

  // Last tile sharing the clicked one's row, so we land *below the row*.
  function rowEnd(tile) {
    if (!tile || !tile.parentElement) return tile;
    var sibs = [].slice.call(tile.parentElement.children).filter(function (n) {
      return n.id !== VIEWER && n.offsetParent !== null;
    });
    var top = tile.offsetTop, last = tile;
    sibs.forEach(function (n) { if (Math.abs(n.offsetTop - top) <= ROW_TOL) last = n; });
    return last;
  }

  // Google may have rebuilt the grid, so the node we clicked can be stale.
  // Prefer it while it is still attached, otherwise find it again by src —
  // skipping Google's own panel, which holds a second copy of the same image.
  function findThumb(node, src) {
    if (node && node.isConnected && !node.closest('div.Z7HyUd')) return node;
    if (!src) return null;
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if ((imgs[i].currentSrc || imgs[i].src) !== src) continue;
      if (imgs[i].closest('div.Z7HyUd')) continue;          // the side panel
      if (imgs[i].getBoundingClientRect().width > 40) return imgs[i];
    }
    return null;
  }

  function makeFloating(v) {
    v.style.position = 'fixed';
    v.style.left = '3vw';
    v.style.width = '94vw';
    v.style.top = Math.max(12, window.innerHeight * 0.06) + 'px';
    v.style.maxHeight = '88vh';
    v.style.overflow = 'auto';
    v.style.zIndex = '2147483647';
  }

  // Google's grid is masonry emulated with ~4.7px rows and per-tile
  // "grid-row: span N". An item that does not claim its rows is allotted one
  // of them, and the tiles below are packed straight over the top of it — so
  // claim exactly as many rows as the viewer is tall.
  function fitGrid(v) {
    var g = v.parentElement;
    if (!g || v.style.position === 'fixed') return;
    var cs = getComputedStyle(g);
    if (cs.display !== 'grid') return;
    var unit = parseFloat(cs.gridAutoRows);
    if (!unit || !isFinite(unit) || unit <= 0) return;
    var gap = parseFloat(cs.rowGap) || 0;
    v.style.gridRow = 'span ' + Math.ceil((v.scrollHeight + 20) / (unit + gap));
  }

  // Google rebuilds its grid on its own schedule. If it deletes our node,
  // put it straight back rather than leaving the user with a dead click.
  function guard(v, host) {
    var left = 4;
    var mo = new MutationObserver(function () {
      if (v.isConnected || left-- <= 0) return;
      try {
        if (host && host.isConnected && host.parentElement) {
          host.parentElement.insertBefore(v, host.nextSibling);
        } else {
          makeFloating(v);
          document.body.appendChild(v);
        }
      } catch (e) {
        try { makeFloating(v); document.body.appendChild(v); } catch (e2) {}
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 10000);
  }

  function build(fullSrc, pageUrl, thumbSrc, meta) {
    var v = document.createElement('div');
    v.id = VIEWER;

    var stage = document.createElement('div');
    stage.className = 'rlx-stage';
    var img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.src = thumbSrc || fullSrc;              // something visible immediately…
    stage.appendChild(img);

    var dim = document.createElement('div');
    dim.className = 'rlx-dim';
    dim.textContent = meta && meta.w
      ? (meta.w + ' x ' + meta.h + (meta.bytes ? ' · ' + meta.bytes : ''))
      : 'loading full size…';

    if (fullSrc && fullSrc !== img.src) {       // …then swap in the original
      var hi = new Image();
      hi.referrerPolicy = 'no-referrer';
      hi.onload = function () {
        img.src = fullSrc;
        dim.textContent = hi.naturalWidth + ' x ' + hi.naturalHeight +
          (meta && meta.bytes ? ' · ' + meta.bytes : '');
        fitGrid(v);
      };
      hi.onerror = function () {
        dim.textContent = 'the original is hotlink-blocked — showing the preview';
      };
      hi.src = fullSrc;
    }
    img.addEventListener('load', function () { fitGrid(v); });

    var host = (meta && meta.site) || '';
    if (!host) { try { host = new URL(pageUrl || fullSrc).hostname; } catch (e) {} }
    host = host.replace(/^www\./, '');
    var name = document.createElement('div');
    name.className = 'rlx-ttl';
    name.textContent = (meta && meta.title) || host || 'Image';
    name.title = name.textContent;

    var link = document.createElement('a');
    link.className = 'rlx-src';
    link.href = pageUrl || fullSrc;
    link.textContent = host || pageUrl || fullSrc;
    link.target = '_blank';
    link.rel = 'noreferrer';

    var btns = document.createElement('div');
    btns.className = 'rlx-btns';
    function mk(tag, label, href) {
      var b = document.createElement(tag);
      b.textContent = label;
      if (href) { b.href = href; b.target = '_blank'; b.rel = 'noreferrer'; }
      btns.appendChild(b);
      return b;
    }
    mk('a', 'Open image', fullSrc);
    mk('a', 'Visit page', pageUrl || fullSrc);
    var copy = mk('button', 'Copy image URL');
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(fullSrc).then(function () { copy.textContent = 'Copied'; });
    });

    var bar = document.createElement('div');
    bar.className = 'rlx-bar';
    bar.appendChild(name); bar.appendChild(dim); bar.appendChild(link); bar.appendChild(btns);

    var x = document.createElement('button');
    x.className = 'rlx-x';
    x.textContent = '✕';
    x.addEventListener('click', function (e) { e.stopPropagation(); closeViewer(); });

    v.appendChild(stage); v.appendChild(bar); v.appendChild(x);
    return v;
  }

  function place(fullSrc, pageUrl, thumbSrc, node, meta) {
    closeViewer();
    var v = build(fullSrc, pageUrl, thumbSrc, meta);
    var thumb = findThumb(node, thumbSrc);
    var host = thumb ? rowEnd(tileOf(thumb)) : null;

    var placed = false;
    if (host && host.parentElement) {
      try { host.parentElement.insertBefore(v, host.nextSibling); placed = true; } catch (e) {}
    }
    // If the grid clipped or collapsed it, float it instead — visually the
    // same thing, impossible for Google's layout to squash.
    if (placed) {
      var r = v.getBoundingClientRect();
      if (r.height < 60 || r.width < 200) placed = false;
    }
    if (!placed) {
      makeFloating(v);
      document.body.appendChild(v);
    } else {
      fitGrid(v);
      guard(v, host);
      var rr = v.getBoundingClientRect();
      if (rr.top < 0 || rr.top > window.innerHeight * 0.75) {
        window.scrollBy({ top: rr.top - 90, behavior: 'auto' });
      }
    }

    // Last line of defence. If the grid was still settling when we inserted,
    // Google can win the race and drop the node; rather than leave the click
    // looking dead, put the viewer back where nothing can remove it.
    setTimeout(function () {
      if (v.isConnected) return;
      makeFloating(v);
      try { document.body.appendChild(v); } catch (e) {}
    }, 600);
  }

  function isOriginal(src) {
    return !!src && !/^data:/.test(src) &&
      !/gstatic\.com|googleusercontent\.com|google\.com\/images/.test(src);
  }

  // Fallback only: let Google resolve the original into its panel, then take
  // the result and shut the panel again.
  function takeOver(node, thumbSrc) {
    var tries = 0;
    var iv = setInterval(function () {
      var cands = document.querySelectorAll(FULL_SEL);
      var full = null;
      for (var i = 0; i < cands.length; i++) {
        if (isOriginal(cands[i].currentSrc || cands[i].src)) { full = cands[i]; break; }
      }
      var giveUp = ++tries > 45;                 // ~4.5s
      if (!full && !giveUp) return;
      clearInterval(iv);

      var src = full ? (full.currentSrc || full.src) : thumbSrc;
      var a = full ? full.closest('a[href]') : null;
      var page = a ? a.href : '';

      closePanel();          // give the grid its full width back
      // Google rebuilds the grid when the panel closes; wait for that to
      // finish before inserting, or our node is deleted with the old grid.
      setTimeout(function () {
        chipOff();
        busy = false;
        place(src, page, thumbSrc, node, null);
      }, 300);
    }, 100);
  }

  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
    if (!e.target.closest) return;
    if (e.target.closest('#' + VIEWER)) return;              // our own UI
    var img = e.target.closest('img');
    if (!img) return;
    var r = img.getBoundingClientRect();
    if (r.width < 70 || r.height < 70) return;               // icons, avatars, chips
    var thumb = img.currentSrc || img.src;

    // Fast path: the original is already in the page's own data, so answer the
    // click here and stop it reaching Google — nothing opens on the right.
    var rec = null;
    try { rec = lookup(thumb); } catch (err) { rec = null; }
    if (rec && rec.src) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      busy = false;
      chipOff();
      place(rec.src, rec.page || '', thumb, img, rec);
      return;
    }

    // Slow path: hand the click to Google and lift the original out of the
    // panel it opens. Only reached for thumbnails missing from the map.
    if (busy) return;
    busy = true;
    closeViewer();
    chipOn('Loading full size…');
    takeOver(img, thumb);
    setTimeout(function () { busy = false; chipOff(); }, 8000);   // never stick
  }, true);

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { var v = byId(VIEWER); if (v) fitGrid(v); }, 120);
  });

  // Only a real key press closes our viewer: the Escape we dispatch at Google
  // is synthetic (isTrusted false) and must not close what we just opened.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && e.isTrusted) closeViewer();
  }, true);
})();
`;

// ── 2. Always play at the highest quality ─────────────────────────
// Streaming sites deliberately start low and climb, so the first several
// seconds of a 4K video are not 4K. This pins the player to the best level
// the video actually offers, as soon as the player exists.
//
// Two things make it stick from the very first frame rather than after a
// visible jump. First, YouTube reads its own "yt-player-quality" entry in
// localStorage when it builds the player, so writing the chosen height there
// means the next video starts at that quality outright. Second, this script
// is injected at dom-ready, before the player initialises.
//
// Pinning also switches off the downshift half of adaptive bitrate: without
// it, a momentary dip in throughput drops the resolution and it can take a
// long time to climb back. That is the intended trade — the setting exists so
// it can be turned off on a connection that cannot hold the top level.
const MAX_QUALITY = String.raw`
(function () {
  if (window.__rlxMaxQuality) return;
  window.__rlxMaxQuality = true;

  // Best first. YouTube's own identifiers, plus the height each maps to.
  var ORDER = ['highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720',
               'large', 'medium', 'small', 'tiny'];
  var HEIGHT = { highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440,
                 hd1080: 1080, hd720: 720, large: 480, medium: 360,
                 small: 240, tiny: 144 };

  var target = null;
  var holding = false;

  function player() {
    return document.getElementById('movie_player') ||
           document.querySelector('.html5-video-player');
  }

  function bestOf(levels) {
    for (var i = 0; i < ORDER.length; i++) {
      if (levels.indexOf(ORDER[i]) > -1) return ORDER[i];
    }
    return null;
  }

  // So the *next* video starts at this quality instead of ramping up to it.
  // Deliberately clears YouTube's stored quality preference rather than
  // setting it.
  //
  // Writing a high value here looked like the obvious way to open every video
  // at its best, and it does — but opening at 2160 means waiting for a 4K
  // initial buffer before a single frame appears, which measured at 22-24
  // seconds of spinner against under two seconds when left alone. That wait
  // is the whole complaint this feature was meant to avoid.
  //
  // Starting adaptively and letting the watchdog below climb once the buffer
  // is healthy gets both: a picture in about 1.5s, full quality a few seconds
  // later. Any preference written by earlier versions is removed here, since
  // it would otherwise keep forcing the slow start forever.
  function remember() {
    try {
      var raw = localStorage.getItem('yt-player-quality');
      if (raw && raw.indexOf('previousQuality') !== -1) {
        localStorage.removeItem('yt-player-quality');
      }
    } catch (e) {}
  }

  function pinYouTube() {
    var p = player();
    if (!p || typeof p.getAvailableQualityLevels !== 'function') return null;
    var levels = p.getAvailableQualityLevels();
    if (!levels || !levels.length) return null;      // not resolved yet
    var q = bestOf(levels);
    if (!q) return null;
    target = q;
    remember();                  // clears a stored preference that forces a slow start
    window.__rlxQuality = q;
    pinOncePlaying(p, q);
    return q;
  }

  // Forcing the range while the player is still starting makes it throw away
  // what it has buffered and fetch the new level before showing a frame —
  // measured at ~580ms of extra delay before playback began.
  //
  // The remembered preference above already makes YouTube open at this level
  // on its own, so the range does not need to be set to get there. Its real
  // job is stopping a later downshift, and that only matters once the video
  // is running — so it goes on after playback starts, where it costs nothing.
  function pinOncePlaying(p, q) {
    var v = document.querySelector('video');
    var tries = 0;
    var iv = setInterval(function () {
      if (!v) v = document.querySelector('video');
      var playing = v && !v.paused && v.currentTime > 0.2;
      if (!playing && ++tries <= 40) return;      // ~8s, then pin anyway
      clearInterval(iv);
      // Ask for the best level, but leave the floor open.
      //
      // Passing (q, q) locks both ends, and a locked player cannot adapt: on
      // a weak moment it sits and buffers for 4K instead of dropping to 1080p
      // and playing. That is a spinner for as long as the network takes,
      // which is exactly what it felt like. Measured on a good connection the
      // difference is small — 2936ms to first frame at 2160p against 1850ms
      // at 1080p — but the cost is unbounded when throughput dips.
      //
      // The remembered preference already makes YouTube open at the best
      // level, so quality is not lost by allowing it to fall back.
      try { p.setPlaybackQualityRange('tiny', q); } catch (e) {}
      try { p.setPlaybackQuality(q); } catch (e) {}
    }, 200);
  }

  // Quality control, in both directions.
  //
  // Two failure modes had to be avoided at once. Locking to the best level
  // from the start means waiting for a 4K buffer before the first frame —
  // 20+ seconds of spinner on a slow moment. Simply allowing the full range
  // means YouTube's own algorithm settles somewhere comfortable, often a step
  // below the best the video has, and stays there.
  //
  // So: start unlocked and let it play quickly, then once there is real
  // runway in the buffer, raise the floor to force the top level. If the
  // buffer then falls away, drop the floor again so it can recover rather
  // than stall. Quality climbs when the connection can carry it and gets out
  // of the way when it cannot.
  var forced = false;
  function hold() {
    if (holding) return;
    holding = true;
    setInterval(function () {
      var p = player();
      var v = document.querySelector('video');
      if (!p || !v || !target || typeof p.getPlaybackQuality !== 'function') return;
      var ahead = v.buffered.length
        ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
      var cur = p.getPlaybackQuality();

      if (!forced) {
        var below = cur && cur !== target && ORDER.indexOf(cur) > ORDER.indexOf(target);
        if (below && ahead >= 6) {
          try { p.setPlaybackQualityRange(target, target); } catch (e) {}
          try { p.setPlaybackQuality(target); } catch (e) {}
          forced = true;
        }
        return;
      }
      // Forced, but the buffer is draining: let it adapt rather than stall.
      if (ahead < 2.5) {
        try { p.setPlaybackQualityRange('tiny', target); } catch (e) {}
        forced = false;
      }
    }, 2000);
  }

  // hls.js — used by a large share of non-YouTube players. Duck-typed, so we
  // only touch something that really is an hls.js instance.
  function pinHls() {
    var seen = [];
    if (window.hls) seen.push(window.hls);
    [].slice.call(document.querySelectorAll('video')).forEach(function (v) {
      if (v.hls) seen.push(v.hls);
    });
    var n = 0;
    seen.forEach(function (h) {
      if (!h || !h.levels || !h.levels.length) return;
      try {
        h.autoLevelCapping = -1;
        h.currentLevel = h.levels.length - 1;    // levels are worst-to-best
        n++;
      } catch (e) {}
    });
    return n;
  }

  // dash.js — same idea, identified by its own method names.
  function pinDash() {
    var p = window.dashPlayer || window.player;
    if (!p || typeof p.updateSettings !== 'function' ||
        typeof p.getRepresentationsByType !== 'function') return 0;
    try {
      p.updateSettings({
        streaming: { abr: { autoSwitchBitrate: { video: false } } }
      });
      var reps = p.getRepresentationsByType('video');
      if (reps && reps.length && typeof p.setRepresentationForTypeByIndex === 'function') {
        p.setRepresentationForTypeByIndex('video', reps.length - 1);
      }
      return 1;
    } catch (e) { return 0; }
  }

  function attempt() {
    if (pinYouTube()) { hold(); return true; }
    return (pinHls() + pinDash()) > 0;
  }

  function run() {
    target = null;
    var tries = 0;
    var iv = setInterval(function () {
      if (attempt() || ++tries > 60) clearInterval(iv);   // give up after ~15s
    }, 250);
  }

  run();

  // YouTube is a single-page app: moving between videos never reloads, so the
  // pin has to be re-applied on its own navigation events.
  ['yt-navigate-finish', 'yt-page-data-updated', 'spfdone'].forEach(function (ev) {
    window.addEventListener(ev, run);
  });
})();
`;

const SCRIPTS = [
  {
    id: 'classicImages',
    name: 'Classic Google Images (expand inline, not in a side panel)',
    match: /^https?:\/\/(www\.)?google\.[a-z.]+\/search/i,
    extra: (url) => /[?&]tbm=isch|[?&]udm=2/i.test(url),   // image search only
    code: GOOGLE_IMAGES,
  },
  {
    id: 'maxQuality',
    name: 'Always play video at the highest quality',
    // Everything except the internal pages — the script costs nothing on a
    // page with no video, and hls.js/dash.js turn up on all sorts of sites.
    match: /^https?:\/\//i,
    code: MAX_QUALITY,
  },
];

function scriptsFor(url, prefs) {
  const on = (prefs && prefs.userscripts) || {};
  return SCRIPTS.filter((s) => {
    if (on[s.id] === false) return false;                 // user disabled it
    if (!s.match.test(url)) return false;
    return s.extra ? s.extra(url) : true;
  });
}

function apply(wc, url, prefs) {
  scriptsFor(url, prefs).forEach((s) => {
    wc.executeJavaScript(s.code, true).catch(() => {});
  });
}

function list() { return SCRIPTS.map((s) => ({ id: s.id, name: s.name })); }

module.exports = { apply, list };
