#!/usr/bin/env node
/**
 * Fetch the bundled engines.
 *
 *   npm run engines:fetch
 *
 * engines/ holds about 250MB of third-party binaries and is deliberately not
 * in git. That makes a fresh clone unbuildable unless there is a way to get
 * them back, which is this: yt-dlp, gallery-dl, ffmpeg and the Tor daemon,
 * from their own projects, into engines/.
 *
 * Everything downloaded here is GPL or otherwise redistributable, and every
 * URL points at the project that publishes it — no mirrors.
 *
 * Skips anything already present. --force re-downloads.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'engines');
const FORCE = process.argv.includes('--force');

const TOR_VERSION = '15.0.20';

function get(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'redlynx-engines' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const total = Number(res.headers['content-length'] || 0);
      let seen = 0;
      let lastPrint = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        seen += c.length;
        const pct = total ? Math.floor((seen / total) * 100) : 0;
        if (pct >= lastPrint + 20) {
          lastPrint = pct;
          process.stdout.write('    ' + pct + '%\r');
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Newest release that actually carries the asset — not simply the newest
 * release. gallery-dl stopped attaching a Windows binary at v1.32, so asking
 * for "latest" gets a release with no assets at all and the fetch fails. A
 * project pausing its binaries should not make the app unbuildable.
 */
async function latestAsset(repo, name) {
  const body = await new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/' + repo + '/releases?per_page=40',
      { headers: { 'User-Agent': 'redlynx-engines', Accept: 'application/vnd.github+json' } },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
      }).on('error', reject);
  });
  const releases = JSON.parse(body);
  if (!Array.isArray(releases)) {
    throw new Error('unexpected response from GitHub for ' + repo);
  }
  for (const rel of releases) {
    const asset = (rel.assets || []).find((a) => a.name === name)
      || (rel.assets || []).find((a) => a.name.includes(name));
    if (asset) {
      return {
        url: asset.browser_download_url,
        tag: rel.tag_name,
        size: asset.size,
        stale: rel !== releases[0],
      };
    }
  }
  throw new Error('no release in the last ' + releases.length + ' of ' + repo
    + ' carries ' + name);
}

const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const have = (rel) => !FORCE && fs.existsSync(path.join(DIR, rel));

  // ── yt-dlp ──
  if (have('yt-dlp.exe')) console.log('  yt-dlp.exe already present');
  else {
    const a = await latestAsset('yt-dlp/yt-dlp', 'yt-dlp.exe');
    console.log('  yt-dlp ' + a.tag + ' (' + mb(a.size) + ')'
      + (a.stale ? '  — newest release with a Windows binary' : ''));
    await get(a.url, path.join(DIR, 'yt-dlp.exe'));
  }

  // ── gallery-dl ──
  if (have('gallery-dl.exe')) console.log('  gallery-dl.exe already present');
  else {
    const a = await latestAsset('mikf/gallery-dl', 'gallery-dl.exe');
    console.log('  gallery-dl ' + a.tag + ' (' + mb(a.size) + ')'
      + (a.stale ? '  — newest release with a Windows binary' : ''));
    await get(a.url, path.join(DIR, 'gallery-dl.exe'));
  }

  // ── ffmpeg ──
  // Only ffmpeg.exe is kept. ffprobe is another 137MB and nothing here calls it.
  if (have('ffmpeg.exe')) console.log('  ffmpeg.exe already present');
  else {
    const a = await latestAsset('BtbN/FFmpeg-Builds', 'ffmpeg-master-latest-win64-gpl.zip');
    console.log('  ffmpeg ' + a.tag + ' (' + mb(a.size) + ', extracting ffmpeg.exe only)');
    const zip = path.join(DIR, '_ffmpeg.zip');
    await get(a.url, zip);
    const tmp = path.join(DIR, '_ffmpeg');
    fs.rmSync(tmp, { recursive: true, force: true });
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + tmp + '" -Force'],
      { stdio: 'ignore' });
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'ffmpeg.exe') found.push(p);
      }
    })(tmp);
    if (!found.length) throw new Error('ffmpeg.exe not found inside the archive');
    fs.copyFileSync(found[0], path.join(DIR, 'ffmpeg.exe'));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }

  // ── Tor ──
  if (have(path.join('tor', 'tor', 'tor.exe'))) console.log('  tor already present');
  else {
    const name = 'tor-expert-bundle-windows-x86_64-' + TOR_VERSION + '.tar.gz';
    const url = 'https://www.torproject.org/dist/torbrowser/' + TOR_VERSION + '/' + name;
    console.log('  tor ' + TOR_VERSION);
    const tgz = path.join(DIR, '_tor.tar.gz');
    await get(url, tgz);

    // Verify against the Tor Browser signing key when gpg is available. The
    // fingerprint is the one torproject.org publishes; a mismatch means stop.
    try {
      execFileSync('gpg', ['--version'], { stdio: 'ignore' });
      await get(url + '.asc', tgz + '.asc');
      try {
        execFileSync('gpg', ['--keyserver', 'keys.openpgp.org', '--recv-keys',
          'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'], { stdio: 'ignore' });
      } catch (e) { /* key may already be present */ }
      const out = execFileSync('gpg', ['--verify', tgz + '.asc', tgz],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('    signature verified');
      void out;
    } catch (e) {
      const msg = String((e && e.stderr) || (e && e.message) || e);
      if (/Good signature/.test(msg)) console.log('    signature verified');
      else if (/BAD signature/.test(msg)) throw new Error('Tor signature did NOT verify — stopping');
      else console.log('    signature not checked (gpg unavailable or key not fetched)');
    }

    const dest = path.join(DIR, 'tor');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dest], { stdio: 'ignore' });
    fs.rmSync(path.join(dest, 'docs'), { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    fs.rmSync(tgz + '.asc', { force: true });
  }

  console.log('');
  for (const rel of ['yt-dlp.exe', 'gallery-dl.exe', 'ffmpeg.exe', path.join('tor', 'tor', 'tor.exe')]) {
    const p = path.join(DIR, rel);
    const ok = fs.existsSync(p);
    console.log('  ' + (ok ? 'ok  ' : 'MISSING ') + rel
      + (ok ? '  ' + mb(fs.statSync(p).size) : ''));
  }
}

main().catch((e) => {
  console.error('\nfailed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
