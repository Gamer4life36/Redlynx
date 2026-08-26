/**
 * Deep search: one query, many indexes, including the ones that hold what
 * mainstream search does not show you.
 *
 * Google shows a single commercially-ranked slice of the web. Things that are
 * genuinely hard to reach from it: pages that have been deleted (archives),
 * small non-commercial sites that rank nowhere (independent crawlers),
 * academic and preprint literature, forum and mailing-list discussion, source
 * code, and pages that were crawled but never indexed by a big engine.
 *
 * Every source runs in parallel with its own timeout, and one failing source
 * never takes the search down — each reports its own status so the UI can say
 * plainly what answered and what did not.
 *
 * There is no Tor index here. Ahmia was the obvious candidate and its search
 * backend serves a page shell with no results at all — checked repeatedly over
 * hours, through Tor and direct, in a real browser with JavaScript running. A
 * picker entry that never works is a promise the product cannot keep, so it is
 * out until there is an onion index that answers. Tor itself still works; you
 * just need the address.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const PER_SOURCE_TIMEOUT = 12000;

function decode(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url, opts) {
  const o = opts || {};
  const attempts = (o.retries || 0) + 1;
  let last = null;

  for (let n = 0; n < attempts; n++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeout || PER_SOURCE_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: Object.assign({
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
        }, o.headers || {}),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (o.json) return await res.json();
      const text = await res.text();
      return o.name ? refuseCheck(text, o.name) : text;
    } catch (e) {
      last = e;
      // A rate-limit is a decision, not a hiccup: retrying earns another one.
      if (/CAPTCHA|rate-limit/i.test(String(e && e.message))) break;
      if (n < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (n + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error('request failed');
}

/**
 * Tell a broken parser apart from an empty result.
 *
 * A scraper whose selectors stop matching returns zero hits, which looks
 * exactly like a search that genuinely found nothing — so a site redesign
 * would quietly remove a source and nobody would know for months. If the page
 * clearly has content and we extracted none of it, say so.
 */
function expectResults(html, out, name) {
  if (out.length) return out;
  const body = String(html || '');
  const links = (body.match(/<a\s/gi) || []).length;
  // A real results page is substantial and full of links. A genuinely empty
  // search is usually short, or says so.
  const looksEmpty = /no results|nothing found|did not match|0 results/i.test(body);
  if (body.length > 6000 && links > 25 && !looksEmpty) {
    throw new Error(name + ' returned a page we could not parse — its layout has probably changed');
  }
  return out;
}

// Form-style search endpoints want '+' for spaces. Mojeek in particular
// answers a %20 query with an empty results page rather than an error, so
// this looks like "no results" instead of a bug.
const form = (q) => encodeURIComponent(q).replace(/%20/g, '+');

// An engine that is rate-limiting you answers with a perfectly valid page
// containing no results. Reported as "0 hits" that is indistinguishable from
// a genuinely empty search, so name it for what it is.
function refuseCheck(html, name) {
  const refusal = /unusual traffic|detected an anomaly|are you a robot|\/sorry\/|captcha/i.test(html)
    || /made by a human|following challenge|bots use|verify you are human/i.test(html);
  if (refusal) throw new Error(name + ' is asking for a CAPTCHA (rate-limited)');
  return html;
}

const hit = (url, title, snippet, extra) => Object.assign({
  url, title: decode(title) || url, snippet: decode(snippet || ''),
}, extra || {});

/* ── sources ──────────────────────────────────────────────────────
 * Each returns an array of hits. Anything that needs an API key is left
 * out on purpose: a source that silently returns nothing is worse than a
 * source that is not there.
 */
const SOURCES = [
  {
    id: 'marginalia',
    name: 'Marginalia',
    why: 'Independent crawler that deliberately favours small, non-commercial, text-heavy sites — the part of the web that ranks nowhere on Google.',
    async run(q) {
      // The current front end renders results client-side; old-search still
      // serves them in the HTML, which is what we can actually parse.
      const html = await get('https://old-search.marginalia.nu/search?query=' + form(q), { name: 'Marginalia' });
      const out = [];
      const block = /<section[^>]+class="card search-result"[\s\S]*?<\/section>/gi;
      let sec;
      while ((sec = block.exec(html)) && out.length < 20) {
        const s = sec[0];
        const url = (/<div class="url"><a[^>]+href="([^"]+)"/.exec(s) || [])[1];
        const title = (/<a[^>]+class="title"[^>]*>([\s\S]*?)<\/a>/.exec(s) || [])[1];
        const desc = (/<p class="description">([\s\S]*?)<\/p>/.exec(s) || [])[1];
        if (url) out.push(hit(url, title || url, desc));
      }
      return expectResults(html, out, 'Marginalia');
    },
  },
  {
    id: 'mojeek',
    name: 'Mojeek',
    why: 'One of the few engines running its own independent crawl rather than reselling Google or Bing, so its ranking is not the same slice.',
    async run(q) {
      const html = await get('https://www.mojeek.com/search?q=' + form(q), { name: 'Mojeek' });
      const out = [];
      const block = /<li class="r\d+">([\s\S]*?)<\/li>/gi;
      let m;
      while ((m = block.exec(html)) && out.length < 20) {
        const s = m[1];
        const a = /<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(s);
        if (!a) continue;
        const snip = (/<p class="s">([\s\S]*?)<\/p>/.exec(s) || [])[1];
        out.push(hit(a[1], a[2], snip));
      }
      return expectResults(html, out, 'Mojeek');
    },
  },
  {
    id: 'ddg',
    name: 'DuckDuckGo',
    why: 'A mainstream baseline to compare the rest against.',
    async run(q) {
      const html = await get('https://html.duckduckgo.com/html/?q=' + form(q), { name: 'DuckDuckGo' });
      const out = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 20) {
        let u = m[1];
        // DDG wraps hits in a redirect; unwrap so the real host is visible.
        const wrapped = /[?&]uddg=([^&]+)/.exec(u);
        if (wrapped) u = decodeURIComponent(wrapped[1]);
        if (u.startsWith('//')) u = 'https:' + u;
        out.push(hit(u, m[2]));
      }
      return expectResults(html, out, 'DuckDuckGo');
    },
  },
  {
    id: 'wayback',
    name: 'Wayback Machine',
    why: 'Pages that have been deleted or rewritten. If a site took something down, this is often the only copy left.',
    async run(q) {
      // A bare query is not a URL, so search the archive by site when the
      // query looks like a domain, and by title otherwise.
      const asDomain = /^[\w-]+(\.[\w-]+)+$/.test(q.trim());
      if (asDomain) {
        const domain = q.trim();
        try {
          // The CDX index is the good answer — a list of everything archived
          // under a domain — but it is frequently overloaded and simply hangs.
          const rows = await get(
            'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent(domain)
            + '*&output=json&limit=25&collapse=urlkey&filter=statuscode:200',
            // Short leash: when CDX is healthy it answers in a few seconds,
            // and when it is not, waiting longer only delays the fallback.
            { json: true, timeout: 9000 });
          if (Array.isArray(rows) && rows.length > 1) {
            return rows.slice(1, 25).map((r) => {
              const [, ts, original] = r;
              return hit('https://web.archive.org/web/' + ts + '/' + original, original,
                'Archived ' + ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8));
            });
          }
        } catch (e) { /* fall through to the endpoint that stays up */ }

        // The availability API answers in well under a second and never seems
        // to be down. It only knows the closest snapshot, so this is a worse
        // answer than CDX gives — but one archived page beats none, and the
        // alternative is the source contributing nothing whenever the index
        // is busy.
        const avail = await get('https://archive.org/wayback/available?url='
          + encodeURIComponent(domain), { json: true, timeout: 12000, retries: 1 });
        const snap = avail && avail.archived_snapshots && avail.archived_snapshots.closest;
        if (!snap || !snap.url) return [];
        const ts = String(snap.timestamp || '');
        return [hit(snap.url.replace(/^http:/, 'https:'), domain,
          'Closest archived copy' + (ts ? ' · ' + ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8) : '')
          + ' · the full index was unavailable')];
      }
      const data = await get('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(q)
        + '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=20&output=json',
        { json: true, timeout: 20000, retries: 2 });
      const docs = (data && data.response && data.response.docs) || [];
      return docs.map((d) => hit('https://archive.org/details/' + d.identifier, d.title || d.identifier,
        Array.isArray(d.description) ? d.description[0] : d.description));
    },
  },
  {
    id: 'commoncrawl',
    name: 'Common Crawl',
    why: 'A raw crawl of the web with no ranking layer at all. Pages here were fetched whether or not any engine chose to index them.',
    // Common Crawl is indexed by URL, not by text, so it can only answer when
    // the query is a domain. Saying that is better than returning nothing and
    // being mistaken for a source that has broken.
    applies: (q) => /^[\w-]+(\.[\w-]+)+$/.test(q.trim()),
    appliesNote: 'searches by domain — try a hostname like example.com',
    async run(q) {
      const asDomain = /^[\w-]+(\.[\w-]+)+$/.test(q.trim());
      if (!asDomain) return [];
      const idx = await get('https://index.commoncrawl.org/collinfo.json', { json: true });
      const latest = Array.isArray(idx) && idx.length ? idx[0]['cdx-api'] : null;
      if (!latest) return [];
      const text = await get(latest + '?url=' + encodeURIComponent(q.trim()) + '*&output=json&limit=25');
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim() || out.length >= 25) continue;
        try {
          const r = JSON.parse(line);
          if (r.url) out.push(hit(r.url, r.url, 'Crawled ' + (r.timestamp || '').slice(0, 8)));
        } catch (e) { /* partial line */ }
      }
      return out;
    },
  },
  {
    id: 'openalex',
    name: 'OpenAlex',
    why: 'Academic literature — 250M works, including papers behind paywalls that never surface in a normal search.',
    async run(q) {
      const data = await get('https://api.openalex.org/works?search=' + encodeURIComponent(q)
        + '&per-page=15&mailto=redlynx', { json: true });
      return ((data && data.results) || []).map((w) => {
        const oa = w.open_access && w.open_access.oa_url;
        const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';
        return hit(oa || w.doi || w.id, w.display_name || w.title || 'Untitled',
          [w.publication_year, (w.primary_location && w.primary_location.source && w.primary_location.source.display_name),
            w.cited_by_count ? w.cited_by_count + ' citations' : '', doi]
            .filter(Boolean).join(' · '),
          { free: !!oa });
      });
    },
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    why: 'Preprints, often months or years before anything is published or indexed elsewhere.',
    async run(q) {
      // arXiv's API regularly takes longer than a browser would wait.
      const xml = await get('http://export.arxiv.org/api/query?search_query=all:'
        + encodeURIComponent(q) + '&max_results=15', { timeout: 25000, retries: 1 });
      const out = [];
      const re = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = re.exec(xml))) {
        const e = m[1];
        const id = (/<id>([^<]+)<\/id>/.exec(e) || [])[1];
        const title = (/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1];
        const summary = (/<summary>([\s\S]*?)<\/summary>/.exec(e) || [])[1];
        if (id) out.push(hit(id, title, (summary || '').slice(0, 300)));
      }
      return out;
    },
  },
  {
    id: 'hn',
    name: 'Hacker News',
    why: 'Discussion and primary sources people link in threads — frequently the only place a niche document is referenced.',
    async run(q) {
      const data = await get('https://hn.algolia.com/api/v1/search?query='
        + encodeURIComponent(q) + '&hitsPerPage=15', { json: true });
      return ((data && data.hits) || []).map((h) => hit(
        h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
        h.title || h.story_title || '(comment)',
        [h.points ? h.points + ' points' : '', h.num_comments ? h.num_comments + ' comments' : '',
          (h.created_at || '').slice(0, 10)].filter(Boolean).join(' · ')));
    },
  },
  {
    id: 'stackexchange',
    name: 'Stack Exchange',
    why: 'Technical answers across all their sites, not just the Stack Overflow results Google chooses to show.',
    async run(q) {
      const data = await get('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance'
        + '&q=' + encodeURIComponent(q) + '&site=stackoverflow&pagesize=15', { json: true });
      return ((data && data.items) || []).map((i) => hit(i.link, i.title,
        [i.is_answered ? 'answered' : 'unanswered', i.score + ' score', i.answer_count + ' answers']
          .join(' · ')));
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    why: 'Source, configuration and documentation that lives in repositories rather than on the indexed web.',
    async run(q) {
      const data = await get('https://api.github.com/search/repositories?q='
        + encodeURIComponent(q) + '&per_page=15',
        { json: true, headers: { Accept: 'application/vnd.github+json' } });
      return ((data && data.items) || []).map((r) => hit(r.html_url, r.full_name,
        [r.description, r.stargazers_count + '★', r.language].filter(Boolean).join(' · ')));
    },
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    why: 'Full-text search over article bodies, which finds articles that merely mention the term.',
    async run(q) {
      const data = await get('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
        + encodeURIComponent(q) + '&srlimit=12&format=json&origin=*', { json: true });
      const items = (data && data.query && data.query.search) || [];
      return items.map((s) => hit(
        'https://en.wikipedia.org/wiki/' + encodeURIComponent(s.title.replace(/ /g, '_')),
        s.title, s.snippet));
    },
  },
];

// Same page reached by two engines is one result, with both credited.
function merge(perSource) {
  const byUrl = new Map();
  for (const { source, hits } of perSource) {
    for (const h of hits) {
      let key;
      try {
        const u = new URL(h.url);
        key = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').toLowerCase();
      } catch (e) { key = h.url; }
      const existing = byUrl.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
      } else {
        byUrl.set(key, Object.assign({}, h, { sources: [source] }));
      }
    }
  }
  // Agreement between independent indexes is the strongest signal available
  // here, so corroborated results float up.
  return [...byUrl.values()].sort((a, b) => b.sources.length - a.sources.length);
}

async function search(query, opts) {
  const q = String(query || '').trim();
  if (!q) return { query: q, results: [], sources: [] };
  const only = (opts && Array.isArray(opts.sources) && opts.sources.length) ? new Set(opts.sources) : null;
  const chosen = SOURCES.filter((s) => !only || only.has(s.id));

  const settled = await Promise.all(chosen.map(async (s) => {
    const started = Date.now();
    if (s.applies && !s.applies(q)) {
      return { id: s.id, name: s.name, ok: true, skipped: true, count: 0, ms: 0,
               note: s.appliesNote || 'does not apply to this query', hits: [] };
    }
    try {
      const hits = await s.run(q);
      return { id: s.id, name: s.name, ok: true, count: hits.length, ms: Date.now() - started, hits };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return {
        id: s.id, name: s.name, ok: false, count: 0, ms: Date.now() - started, hits: [],
        error: /abort/i.test(msg) ? 'timed out' : msg,
      };
    }
  }));

  return {
    query: q,
    sources: settled.map(({ id, name, ok, count, ms, error, skipped, note }) =>
      ({ id, name, ok, count, ms, error, skipped, note })),
    results: merge(settled.filter((r) => r.ok).map((r) => ({ source: r.id, hits: r.hits }))),
  };
}

function catalogue() {
  return SOURCES.map((s) => ({ id: s.id, name: s.name, why: s.why }));
}

function install({ ipcMain }) {
  ipcMain.handle('deep:search', (_e, payload) => search(payload && payload.query, payload || {}));
  ipcMain.handle('deep:sources', () => catalogue());
}

module.exports = { install, search, catalogue };
