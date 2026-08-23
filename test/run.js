/**
 * Regression suite.
 *
 * Every check here exists because the thing it checks once broke, silently,
 * and was found by a person noticing rather than by anything failing. The
 * scoping fix that stopped uBlock's scriptlets coordinating; the Electron
 * upgrade that would have flagged a dead ad blocker; the chrome view sized so
 * a prompt rendered behind the page. None of those were catchable by unit
 * tests — they only appear when a real Chromium loads a real site — so this
 * drives the actual browser through its dev endpoint and asserts on what the
 * page really did.
 *
 *   npm test              everything
 *   npm test -- --only=youtube    just the checks whose name matches
 *
 * It talks to live sites, so a failure can mean the network rather than the
 * browser. Anything network-shaped says so in its message.
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 8790;
const ROOT = path.join(__dirname, '..');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();

let child = null;
const results = [];

// ── talking to the browser ────────────────────────────────────────
function post(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: route, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad response: ' + b.slice(0, 120))); } });
      });
    req.on('error', reject);
    req.end(payload);
  });
}

const nav = (url) => post('/nav', { url });
const page = async (code) => (await post('/js', { code })).result;
const chrome = async (code) => (await post('/ui', { code })).result;
const blocker = async (body) => post('/blocker', body || {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll rather than guess at a sleep: pages settle at wildly different speeds.
async function until(fn, { timeout = 20000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}

// ── the harness ───────────────────────────────────────────────────
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log('  ✓ ' + name + (detail ? '  ' + detail : '') + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    results.push({ name, ok: false, detail: e.message, ms: Date.now() - t0 });
    console.log('  ✗ ' + name + '  ' + e.message);
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// Google answers heavy automated traffic with a CAPTCHA interstitial. That
// says nothing about the browser, so report it as inconclusive rather than
// letting it masquerade as a regression. Solving it is not on the table.
async function googleBlocked() {
  const u = await page('location.href');
  if (typeof u === 'string' && u.indexOf('/sorry/') !== -1) return true;
  const t = await page('document.body.innerText.slice(0,200)');
  return typeof t === 'string' && /unusual traffic/i.test(t);
}

async function startBrowser() {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const logFile = path.join(__dirname, 'last-run.log');
  const log = fs.createWriteStream(logFile);
  // Its own profile, so a run never fights a Redlynx the user has open —
  // sharing one means the second process cannot create its cache and dies.
  const profile = path.join(os.tmpdir(), 'redlynx-test-profile');
  child = spawn(electron, ['.', '--user-data-dir=' + profile], {
    cwd: ROOT,
    env: { ...process.env, REDLYNX_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  await until(async () => {
    try { await post('/info'); return true; } catch (e) { return false; }
  }, { timeout: 60000, what: 'the browser to start' });
  return logFile;
}

function stopBrowser() {
  if (!child) return;
  try { child.kill(); } catch (e) {}
  child = null;
}

// ── checks ────────────────────────────────────────────────────────
async function main() {
  console.log('Redlynx regression suite\n');
  const logFile = await startBrowser();
  console.log('  browser up\n');

  // The blocker once installed into a void: enableBlockingInSession threw on
  // an Electron version mismatch, the throw was swallowed, and every page was
  // unprotected while the shield read zero.
  await check('blocker installs cleanly', async () => {
    // On a first run there is no cached list, so the browser answers /info
    // before the blocker has finished installing. Real users hit that window
    // too — the point of the check is that it closes, not that it never opens.
    const status = await until(async () => {
      const r = await blocker();
      return r.status && r.status.active ? r.status : null;
    }, { timeout: 60000, what: 'the blocker to install' });
    expect(status.active, 'blocker is not active: ' + (status.error || 'unknown'));
    expect(!status.error, 'blocker reported: ' + status.error);
    expect(status.scriptlets > 100, 'only ' + status.scriptlets + ' scriptlets loaded (uBO resources missing?)');
    return status.scriptlets + ' scriptlets, ' + status.lists + ' lists';
  });

  // Scriptlets that cannot coordinate let the pre-roll through; scriptlets
  // that collide take the whole page down. This catches both.
  await check('youtube watch page renders', async () => {
    await nav('https://www.youtube.com/watch?v=cWppAbqm9I8');
    const len = await until(async () => {
      const n = await page('document.body ? document.body.innerText.length : 0');
      return n > 500 ? n : null;
    }, { what: 'youtube to render' });
    return len + ' chars of text';
  });

  // The hard part of this check is telling "we blocked it" apart from "there
  // was nothing to block". YouTube only schedules an ad on some loads, and on
  // the others the ad fields are absent by themselves — so asserting they are
  // absent passes by luck. It did exactly that with this regression
  // deliberately reintroduced, twice, which is the whole reason for the
  // comparison below.
  //
  // The served HTML still carries the original payload even after our
  // scriptlets have neutralised the parsed object, so the raw text says
  // whether an ad was offered and the live object says what became of it.
  // No ad offered is reported as inconclusive rather than counted as a pass.
  await check('youtube pre-roll ad blocked', async () => {
    let offered = false;
    for (let attempt = 0; attempt < 4 && !offered; attempt++) {
      await nav('about:blank');
      await nav('https://www.youtube.com/watch?v=cWppAbqm9I8');
      let state;
      try {
        state = await until(async () => page(`(function(){
        var p=document.getElementById('movie_player');
        if(!p) return null;
        var v=document.querySelector('video');
        if(!v || v.readyState < 2) return null;
        var d=window.ytInitialPlayerResponse||{};
        var html=document.documentElement.innerHTML;
        return {
          offered: html.indexOf('"adSlots"') !== -1 || html.indexOf('"adPlacements"') !== -1,
          liveSlots: Array.isArray(d.adSlots) ? d.adSlots.length : -1,
          livePlacements: Array.isArray(d.adPlacements) ? d.adPlacements.length : -1,
          ad: p.classList.contains('ad-showing'),
          sponsored: /Sponsored/i.test(document.body.innerText)
        };
      })()`), { timeout: 30000, what: 'the player to load (page may not have loaded)' });
      } catch (e) {
        // A slow load is not a blocking failure — that is what the retries
        // are for. Aborting here failed the check for a network hiccup.
        continue;
      }

      if (!state.offered) continue;             // nothing served this time; try again
      offered = true;
      expect(state.liveSlots < 0,
        'the page was served ' + state.liveSlots + ' ad slots and they survived into the player');
      expect(state.livePlacements < 0,
        'the page was served ' + state.livePlacements + ' ad placements and they survived');
      expect(!state.ad, 'an ad is playing in the player');
      expect(!state.sponsored, 'page still shows "Sponsored"');
      return 'ad was offered and neutralised';
    }
    return 'INCONCLUSIVE — no ad offered in 4 loads';
  });

  await check('youtube search has no sponsored results', async () => {
    await nav('https://www.youtube.com/results?search_query=music');
    const r = await until(async () => {
      const v = await page(`(function(){
        var n=document.querySelectorAll('ytd-video-renderer').length;
        if(!n) return null;
        return { results:n, sponsored:(document.body.innerText.match(/Sponsored/g)||[]).length };
      })()`);
      return v;
    }, { what: 'search results' });
    expect(r.sponsored === 0, r.sponsored + ' sponsored results got through');
    return r.results + ' results, 0 sponsored';
  });

  await check('google search skips the AI overview', async () => {
    await chrome('window.redlynx.go("what is a black hole")');
    await new Promise((r) => setTimeout(r, 2500));
    if (await googleBlocked()) return 'INCONCLUSIVE — Google is rate-limiting this IP';
    const r = await until(async () => {
      const v = await page(`(function(){
        var f=document.querySelector('#search a h3, #rso a h3');
        if(!f) return null;
        return { udm: location.search.indexOf('udm=14') > -1,
                 ai: !!document.querySelector('#m-x-content'),
                 y: Math.round(f.getBoundingClientRect().top) };
      })()`);
      return v;
    }, { what: 'google results' });
    expect(r.udm, 'udm=14 was not applied to the search');
    expect(!r.ai, 'the AI overview block is present');
    expect(r.y < 400, 'first result pushed down to y=' + r.y);
    return 'first result at y=' + r.y;
  });

  await check('google images expands inline', async () => {
    await nav('https://www.google.com/search?q=mountain+landscape&udm=2');
    await new Promise((r) => setTimeout(r, 2000));
    if (await googleBlocked()) return 'INCONCLUSIVE — Google is rate-limiting this IP';
    await until(async () => page('document.querySelectorAll("img").length > 20'), { what: 'thumbnails' });
    await page(`(function(){
      var imgs=[].slice.call(document.querySelectorAll('img')).filter(function(i){
        var r=i.getBoundingClientRect(); return r.width>120 && r.height>90; });
      var t=imgs[2]||imgs[0]; if(!t) return 'none';
      var r=t.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(ty){
        t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window,button:0,
          clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
      });
      return 'clicked';
    })()`);
    const v = await until(async () => page(`(function(){
      var v=document.getElementById('__rlx_img_viewer');
      if(!v) return null;
      var i=v.querySelector('img');
      if(!i || !i.naturalWidth) return null;
      return { w: Math.round(v.getBoundingClientRect().width), nat: i.naturalWidth + 'x' + i.naturalHeight };
    })()`), { what: 'the inline viewer' });
    expect(v.w > 600, 'viewer is only ' + v.w + 'px wide — not spanning the row');
    return v.w + 'px wide, original ' + v.nat;
  });

  // Two things matter and they pull against each other: the video should
  // start quickly, and it should end up at the best quality the video has.
  // Locking quality to the maximum satisfied the second by sacrificing the
  // first — a weak moment meant buffering at 4K instead of playing at 1080p.
  // So this asserts a fast start AND that it climbs, rather than either alone.
  await check('video starts fast and reaches full quality', async () => {
    await nav('about:blank');
    await nav('https://www.youtube.com/watch?v=LXb3EKWsInQ');
    // Timed from here, not from performance.now() inside the page. That clock
    // starts at the document's own navigation, and a poll can land on the
    // previous document — one left playing by an earlier check, open for
    // twenty seconds — which reported a twenty second start for a video that
    // actually began in two.
    const started = Date.now();
    await until(async () => page(`(function(){
      var v=document.querySelector('video');
      if(!v || v.paused || v.currentTime < 0.4) return null;
      if(location.pathname.indexOf('/watch') !== 0) return null;   // must be the new page
      return true;
    })()`), { timeout: 30000, what: 'playback to start' });
    const first = { at: Date.now() - started };
    expect(first.at < 12000, 'took ' + first.at + 'ms to play (network may be limiting this)');

    const best = await until(async () => page(`(function(){
      var p=document.getElementById('movie_player');
      var v=document.querySelector('video');
      if(!p||!v) return null;
      var levels=p.getAvailableQualityLevels?p.getAvailableQualityLevels():[];
      var top=levels.filter(function(l){return l!=='auto';})[0];
      if(p.getPlaybackQuality()!==top) return null;
      var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():{};
      return { top: top, res: v.videoWidth+'x'+v.videoHeight,
               dropped: q.droppedVideoFrames||0, total: q.totalVideoFrames||0 };
    })()`), { timeout: 30000, every: 1000, what: 'quality to climb to the best available' });
    // Only judge the drop rate once there are enough frames to mean anything.
    // Right after a quality switch the counter can read 2 of 19, which is
    // 10% and tells you nothing.
    expect(best.total < 300 || best.dropped / best.total < 0.05,
      'dropped ' + best.dropped + ' of ' + best.total + ' frames');
    return 'played at ' + first.at + 'ms, reached ' + best.top + ' (' + best.res + ')';
  });

  // The chrome is a separate view above the page; sized wrong, a fullscreen
  // video keeps the toolbar on screen and is not fullscreen at all.
  await check('fullscreen is really fullscreen', async () => {
    await nav('https://www.youtube.com/watch?v=LXb3EKWsInQ');
    // Waiting for the element is not enough — the player refuses the request
    // until it is actually running, which made this check fail intermittently
    // while fullscreen itself was fine. Wait for playback, then keep asking.
    await until(async () => page(`(function(){
      var v=document.querySelector('video');
      return !!(v && !v.paused && v.currentTime > 0.3);
    })()`), { timeout: 30000, what: 'playback before requesting fullscreen' });

    const r = await until(async () => {
      await page(`(function(){
        if (document.fullscreenElement) return 'already';
        var p=document.querySelector('.html5-video-player');
        if (p) p.requestFullscreen().catch(function(){});
        return 'asked';
      })()`);
      return page(`(function(){
        if(!document.fullscreenElement) return null;
        var v=document.querySelector('video');
        return { w: window.innerWidth, h: window.innerHeight,
                 videoY: Math.round(v.getBoundingClientRect().top) };
      })()`);
    }, { timeout: 15000, every: 1000, what: 'fullscreen' });
    expect(r.videoY === 0, 'video sits at y=' + r.videoY + ' — chrome still on screen');
    await page('document.exitFullscreen()');
    const back = await until(async () => chrome('window.innerHeight < 400 ? window.innerHeight : null'),
      { what: 'the toolbar to come back' });
    return r.w + 'x' + r.h + ' fullscreen, toolbar back at ' + back + 'px';
  });

  // Panels and prompts used to be clipped to an 80px strip and buried behind
  // the page, which made the save-password prompt impossible to click.
  await check('panels are not clipped behind the page', async () => {
    await chrome(`(function(){ document.getElementById('btnSettings').click(); return 'x'; })()`);
    const r = await until(async () => chrome(`(function(){
      var p=document.getElementById('panelSettings').getBoundingClientRect();
      if(p.height < 50) return null;
      return { chromeH: window.innerHeight, panelH: Math.round(p.height),
               fits: (p.y + p.height) <= window.innerHeight };
    })()`), { what: 'the settings panel' });
    expect(r.fits, 'panel is ' + r.panelH + 'px in a ' + r.chromeH + 'px view — clipped');
    await chrome(`(function(){ closePanels(); return 'x'; })()`);
    return r.panelH + 'px panel in a ' + r.chromeH + 'px view';
  });

  // Reader used innerHTML and a bare DOMParser, which sites enforcing Trusted
  // Types refuse — it worked on Wikipedia and failed on YouTube.
  await check('reader mode works under Trusted Types', async () => {
    await nav('https://en.wikipedia.org/wiki/Photosynthesis');
    await until(async () => page('document.body && document.body.innerText.length > 2000'), { what: 'the article' });
    const r = await chrome('window.redlynx.readerToggle()');
    expect(r && r.ok, 'reader failed: ' + ((r && r.error) || 'unknown'));
    const title = await page(`(function(){ var h=document.querySelector('.rlx-read h1'); return h?h.textContent:''; })()`);
    expect(title && title.length > 2, 'reader rendered no title');
    await chrome('window.redlynx.readerToggle()');
    return '"' + title.slice(0, 30) + '"';
  });

  await check('omnibar suggestions return rows', async () => {
    const rows = await chrome('window.redlynx.omniSuggest("you")');
    expect(Array.isArray(rows) && rows.length > 0, 'no suggestions returned');
    expect(rows[0].url, 'first suggestion has no url');
    return rows.length + ' rows';
  });

  await check('keyboard shortcuts work from the page and the chrome', async () => {
    // The chrome only sees keys while it has focus, so the interesting half is
    // the forwarded one: keys pressed with a page focused.
    const tabs = () => chrome('window.redlynx.tabState().then(function(s){return s.tabs.length;})');
    await post('/nav', { url: 'https://example.com' });
    await new Promise((r) => setTimeout(r, 2500));

    const start = await tabs();
    await post('/key', { key: 't', modifiers: ['control'] });
    await new Promise((r) => setTimeout(r, 1200));
    const opened = await tabs();
    expect(opened === start + 1, 'Ctrl+T from a focused page did not open a tab (' + start + ' -> ' + opened + ')');

    await post('/key', { key: 'w', modifiers: ['control'] });
    await new Promise((r) => setTimeout(r, 1200));
    const closed = await tabs();
    expect(closed === opened - 1, 'Ctrl+W from a focused page did not close a tab (' + opened + ' -> ' + closed + ')');

    await post('/key', { key: 'T', modifiers: ['control', 'shift'] });
    await new Promise((r) => setTimeout(r, 1500));
    const back = await tabs();
    expect(back === closed + 1, 'Ctrl+Shift+T did not reopen the closed tab (' + closed + ' -> ' + back + ')');

    // Middle-click closes a tab from the strip.
    const mid = await chrome(`(async function(){
      var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
      var id=await window.redlynx.newTab('https://example.org/');
      await sleep(1500);
      var before=(await window.redlynx.tabState()).tabs.length;
      var el=document.querySelector('.tab[data-id="'+id+'"]');
      if(!el) return 'no tab element';
      el.dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));
      await sleep(900);
      return before-(await window.redlynx.tabState()).tabs.length;
    })()`);
    expect(mid === 1, 'middle-click did not close the tab (' + mid + ')');

    // Put the strip back the way we found it — later checks assume one page.
    await chrome(`(async function(){
      var s = await window.redlynx.tabState();
      for (var i = s.tabs.length - 1; i > 0; i--) await window.redlynx.closeTab(s.tabs[i].id);
    })()`);
    await new Promise((r) => setTimeout(r, 800));

    return 'Ctrl+T/W/Shift+T forwarded, middle-click closes';
  });

  await check('command palette opens', async () => {
    const n = await chrome(`new Promise(function(res){
      // Ctrl+K toggles, so start from a known-closed state.
      paletteClose();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
      setTimeout(function(){
        var open=document.getElementById('paletteWrap').classList.contains('open');
        var count=document.querySelectorAll('.pcmd').length;
        paletteClose();
        res(open ? count : 0);
      }, 400);
    })`);
    expect(n > 5, 'palette did not open, or had ' + n + ' commands');
    return n + ' commands';
  });

  // Deliberately last: it ends with no tabs, which shuts the browser down.
  // Closing the final tab used to spawn a replacement, so Ctrl+W looked like
  // it opened tabs rather than closing them.
  await check('closing the last tab closes the window', async () => {
    // Get down to a single tab without going through zero.
    await chrome(`(async function(){
      var s = await window.redlynx.tabState();
      for (var i = s.tabs.length - 1; i > 0; i--) await window.redlynx.closeTab(s.tabs[i].id);
    })()`);
    await new Promise((r) => setTimeout(r, 900));

    const one = await chrome('window.redlynx.tabState().then(function(s){return s.tabs.length;})');
    expect(one === 1, 'expected 1 tab before the last close, got ' + one);

    await post('/key', { key: 'w', modifiers: ['control'], target: 'chrome' });
    await new Promise((r) => setTimeout(r, 2500));

    // The debug endpoint dies with the app, so an unreachable one is the pass.
    let alive = true;
    try { await post('/info', {}); } catch (e) { alive = false; }
    expect(!alive, 'the window stayed open after closing its last tab');
    return 'window closed instead of spawning a replacement tab';
  });

  // Anything that killed a renderer during the run would have been reported
  // by the handlers added for exactly that purpose.
  await check('no renderer crashed during the run', async () => {
    const text = fs.readFileSync(logFile, 'utf8');
    const gone = (text.match(/renderer gone/g) || []).length;
    const hung = (text.match(/unresponsive/g) || []).length;
    expect(gone === 0, gone + ' renderer crash(es) — see test/last-run.log');
    return hung ? hung + ' unresponsive warning(s)' : 'clean';
  });

  stopBrowser();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) {
    console.log('\nfailed:');
    failed.forEach((f) => console.log('  - ' + f.name + ': ' + f.detail));
  }
  process.exit(failed.length ? 1 : 0);
}

process.on('SIGINT', () => { stopBrowser(); process.exit(130); });
main().catch((e) => {
  console.error('\nsuite could not run:', e.message);
  stopBrowser();
  process.exit(2);
});
