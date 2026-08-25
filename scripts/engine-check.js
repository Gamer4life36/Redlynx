#!/usr/bin/env node
/**
 * How stale is the engine?
 *
 * Redlynx ships without an updater on purpose: nothing phones home, and the
 * build never changes under the person running it. The cost of that choice is
 * that Chromium security fixes arrive only when the build is remade, so this
 * tells you where you stand rather than leaving you to guess.
 *
 *   npm run engine:check     say how far behind we are
 *   npm run engine:refresh   pull the newest Electron, run the suite, rebuild
 */
const https = require('https');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'redlynx-engine-check' } }, (res) => {
    if (res.statusCode >= 300 && res.headers.location) return resolve(get(res.headers.location));
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

const major = (v) => Number(String(v).replace(/^\D*/, '').split('.')[0]);

(async () => {
  const declared = (pkg.devDependencies || {}).electron || (pkg.dependencies || {}).electron || '';
  let installed = '';
  let chromium = '';
  try {
    installed = require('electron/package.json').version;
    // Electron records the Chromium it was built against.
    chromium = JSON.parse(execFileSync('node', ['-e', "console.log(JSON.stringify(require('electron/package.json')))"],
      { encoding: 'utf8' })).chromium || '';
  } catch (e) { /* not installed */ }

  console.log('Redlynx engine');
  console.log('  electron declared : ' + declared);
  console.log('  electron installed: ' + (installed || '(not installed)'));

  let latestElectron = '';
  try {
    latestElectron = JSON.parse(await get('https://registry.npmjs.org/electron/latest')).version;
  } catch (e) { /* offline */ }

  let latestChrome = '';
  try {
    const j = JSON.parse(await get(
      'https://versionhistory.googleapis.com/v1/chrome/platforms/win64/channels/stable/versions'));
    latestChrome = (j.versions && j.versions[0] && j.versions[0].version) || '';
  } catch (e) { /* offline */ }

  if (latestElectron) console.log('  electron latest   : ' + latestElectron);
  if (latestChrome) console.log('  chrome stable     : ' + latestChrome);

  if (!latestElectron) {
    console.log('\nCould not reach the registry — no verdict without it.');
    return;
  }

  const behind = major(latestElectron) - major(installed || declared);
  console.log('');
  if (behind <= 0) {
    console.log('Up to date. Nothing to do.');
  } else if (behind === 1) {
    console.log('One major behind. Electron trails Chrome by design, so this is normal.');
    console.log('Worth refreshing when convenient: npm run engine:refresh');
  } else {
    console.log(behind + ' majors behind. Chromium security fixes from that gap are not in this build.');
    console.log('Refresh when you can: npm run engine:refresh');
    console.log('Expect the suite to catch anything the upgrade breaks — that is what it is for.');
  }
  console.log('\nA major Electron upgrade can change behaviour. Run the suite before shipping a rebuild.');
})();
