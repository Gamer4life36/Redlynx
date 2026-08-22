/**
 * Reader mode.
 *
 * Strips a page back to the thing you actually came for: the article, at a
 * comfortable measure, on a background that is not a fight.
 *
 * Extraction is Mozilla's Readability — the same engine Firefox uses. That is
 * a deliberate choice over a hand-rolled heuristic: picking article text out
 * of arbitrary markup is a genuinely hard problem, and every home-grown
 * attempt ends up shipping half a navigation menu.
 *
 * The library runs against a *clone* of the document, because it mutates what
 * it is given while scoring. Turning reader mode off is a plain reload, which
 * is both simpler and more honest than trying to stash and restore a page's
 * original DOM.
 */
const fs = require('fs');
const path = require('path');

let librarySource = null;

function library() {
  if (librarySource !== null) return librarySource;
  try {
    const file = path.join(
      __dirname, '..', 'node_modules', '@mozilla', 'readability', 'Readability.js'
    );
    // The file ends with a CommonJS export that would throw in a page, so the
    // whole thing is wrapped and the constructor handed back explicitly.
    librarySource = '(function(){var module={};' + fs.readFileSync(file, 'utf8')
      + '\nreturn module.exports;})()';
  } catch (e) {
    librarySource = '';
  }
  return librarySource;
}

// Runs in the page. Returns a short status string so the caller can say
// something useful when a page has no article in it.
function script() {
  const lib = library();
  if (!lib) return null;
  return `
(function () {
  try {
    if (document.documentElement.getAttribute('data-rlx-reader')) return 'already';
    var Readability = ${lib};
    var article = new Readability(document.cloneNode(true)).parse();
    if (!article || !article.content || article.length < 400) return 'no-article';

    var title = article.title || document.title || '';
    var byline = article.byline || '';
    var site = article.siteName || location.hostname.replace(/^www\\./, '');
    var mins = Math.max(1, Math.round((article.length || 0) / 1100));

    document.documentElement.setAttribute('data-rlx-reader', '1');
    // replaceChildren rather than innerHTML: sites that send
    // "require-trusted-types-for 'script'" also guard innerHTML, and YouTube
    // is one of them. Nothing here needs to parse a string anyway.
    // Clearing head drops the <title> with everything else, which would leave
    // the tab reading "New tab" for an article that plainly has a name.
    document.head.replaceChildren();
    var ttl = document.createElement('title');
    ttl.textContent = title;
    document.head.appendChild(ttl);
    var st = document.createElement('style');
    st.textContent = [
      ':root{color-scheme:dark}',
      'html,body{margin:0;background:#14171c;color:#e7e9ee}',
      '.rlx-read{max-width:44rem;margin:0 auto;padding:56px 24px 120px;',
      '  font:19px/1.68 Georgia,"Iowan Old Style",serif}',
      '.rlx-read h1{font-size:2em;line-height:1.22;margin:0 0 12px}',
      '.rlx-read .rlx-meta{font:13px/1.5 system-ui,sans-serif;color:#98a1b0;',
      '  border-bottom:1px solid #262c36;padding-bottom:18px;margin-bottom:30px}',
      '.rlx-read p{margin:0 0 1.15em}',
      '.rlx-read a{color:#7aa2ff}',
      '.rlx-read img,.rlx-read video{max-width:100%;height:auto;border-radius:8px;display:block;margin:1.4em auto}',
      '.rlx-read figure{margin:1.6em 0}',
      '.rlx-read figcaption{font:13px/1.5 system-ui,sans-serif;color:#98a1b0;text-align:center;margin-top:8px}',
      '.rlx-read pre{background:#0f1216;padding:14px;border-radius:8px;overflow:auto;',
      '  font:13px/1.5 ui-monospace,Consolas,monospace}',
      '.rlx-read code{font:0.88em ui-monospace,Consolas,monospace}',
      '.rlx-read blockquote{margin:1.4em 0;padding-left:18px;border-left:3px solid #2a3342;color:#c3c9d4}',
      '.rlx-read h2,.rlx-read h3{font-family:system-ui,sans-serif;line-height:1.3;margin:1.8em 0 .5em}',
      '.rlx-read table{max-width:100%;overflow:auto;display:block}'
    ].join('');
    document.head.appendChild(st);

    var wrap = document.createElement('div');
    wrap.className = 'rlx-read';
    var h = document.createElement('h1');
    h.textContent = title;
    var meta = document.createElement('div');
    meta.className = 'rlx-meta';
    meta.textContent = [site, byline, mins + ' min read'].filter(Boolean).join('  ·  ');
    wrap.appendChild(h);
    wrap.appendChild(meta);

    // Readability hands back a string of HTML. Parsing it in a detached
    // document and adopting the nodes keeps the live page out of it, and the
    // parsed document is inert — nothing in it runs.
    //
    // Sites that enforce Trusted Types guard DOMParser as well as innerHTML,
    // so the string goes through a policy of our own first. The content came
    // from Readability's sanitiser, not from us trusting the page.
    var toHTML = function (x) { return x; };
    try {
      if (window.trustedTypes && window.trustedTypes.createPolicy) {
        var pol = window.trustedTypes.createPolicy('rlx-reader', { createHTML: function (x) { return x; } });
        toHTML = function (x) { return pol.createHTML(x); };
      }
    } catch (e) {}

    var body = document.createElement('div');
    var parsed = new DOMParser().parseFromString(toHTML(article.content), 'text/html');
    while (parsed.body.firstChild) body.appendChild(document.adoptNode(parsed.body.firstChild));
    wrap.appendChild(body);

    document.body.replaceChildren(wrap);
    window.scrollTo(0, 0);
    return 'ok';
  } catch (e) {
    return 'error: ' + (e && e.message);
  }
})()`;
}

async function apply(wc) {
  const code = script();
  if (!code) return { ok: false, error: 'reader library unavailable' };
  try {
    const r = await wc.executeJavaScript(code, true);
    if (r === 'ok' || r === 'already') return { ok: true };
    if (r === 'no-article') return { ok: false, error: 'no article found on this page' };
    return { ok: false, error: String(r || 'failed') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Off is a reload: simpler than stashing the original DOM, and it cannot go
// stale or half-restore.
function clear(wc) {
  try { wc.reload(); } catch (e) {}
  return { ok: true };
}

async function isOn(wc) {
  try {
    return await wc.executeJavaScript(
      "!!document.documentElement.getAttribute('data-rlx-reader')", true
    );
  } catch (e) { return false; }
}

module.exports = { apply, clear, isOn };
