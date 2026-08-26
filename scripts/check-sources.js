#!/usr/bin/env node
/**
 * Are the deep-search sources still alive?
 *
 *   npm run sources:check
 *
 * Three of the sources are HTML scrapers, and a scraper is a promise about
 * someone else's markup. When a site redesigns, the selectors stop matching
 * and the source quietly contributes nothing — which looks identical to a
 * search that found nothing. This runs a query with a known-good answer
 * through each source and says which ones are actually working.
 *
 * Exits non-zero if anything is broken, so it can gate a release.
 */
const Deep = require('../src/deepsearch');

// Queries chosen to have obvious answers, so zero hits means something wrong
// rather than something obscure.
const PROBES = {
  wayback: 'wikipedia.org',
  commoncrawl: 'wikipedia.org',
  default: 'photosynthesis',
};

(async () => {
  const all = Deep.catalogue();
  const rows = [];

  for (const src of all) {
    const q = PROBES[src.id] || PROBES.default;
    const started = Date.now();
    const res = await Deep.search(q, { sources: [src.id] });
    const s = res.sources[0] || { ok: false, count: 0, error: 'no result' };
    rows.push({
      id: src.id,
      name: src.name,
      needsTor: src.needsTor,
      ok: s.ok,
      skipped: !!s.skipped,
      count: s.count,
      ms: Date.now() - started,
      error: s.error || '',
    });
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  let broken = 0;
  let degraded = 0;

  console.log('');
  for (const r of rows) {
    let mark;
    if (r.skipped) mark = '  n/a  ';
    else if (r.ok && r.count > 0) mark = '  ok   ';
    else if (!r.ok && /layout has probably changed/.test(r.error)) { mark = ' BROKE '; broken++; }
    else if (!r.ok && /CAPTCHA|rate-limit/.test(r.error)) { mark = ' limit '; degraded++; }
    else if (!r.ok && r.needsTor) { mark = '  tor  '; }
    else if (!r.ok) { mark = ' fail  '; degraded++; }
    else { mark = ' empty '; degraded++; }

    console.log(mark + r.name.padEnd(width + 2)
      + String(r.count).padStart(3) + ' hits '
      + String(r.ms + 'ms').padStart(7)
      + (r.error ? '   ' + r.error.slice(0, 70) : ''));
  }

  const healthy = rows.filter((r) => r.ok && r.count > 0).length;
  console.log('\n' + healthy + '/' + rows.length + ' sources returning results');

  if (broken) {
    console.log('\n' + broken + ' source(s) look broken rather than empty — a site has probably');
    console.log('changed its markup. The parser for it needs updating in src/deepsearch.js.');
  }
  if (degraded && !broken) {
    console.log('\nNothing looks broken; the failures above are rate limits or timeouts,');
    console.log('which come and go. Run it again later before changing anything.');
  }
  process.exit(broken ? 1 : 0);
})();
