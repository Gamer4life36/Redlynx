/**
 * Anonymity layer: proxy routing, encrypted DNS, and leak plugging.
 *
 * Honest framing: this is not a VPN service — Redlynx has no servers to route
 * you through. It is browser-level proxy routing plus the hardening that makes
 * a proxy actually private, which is precisely what a browser "VPN" is under
 * the hood (it protects browser traffic only, not the whole machine).
 *
 * What is real here:
 *   • Proxy routing — HTTP/HTTPS/SOCKS5, incl. one-click Tor if it is running
 *   • DNS-over-HTTPS — stops your ISP seeing every domain you look up
 *   • WebRTC leak block — WebRTC otherwise reveals your true IP straight past
 *     any proxy, which is how most "anonymous" browser setups quietly fail
 *   • A check button that reports the IP sites actually see
 */
const { app, session, net } = require('electron');

const DOH_SERVERS = {
  quad9:      { name: 'Quad9 (blocks malware)', url: 'https://dns.quad9.net/dns-query' },
  cloudflare: { name: 'Cloudflare',             url: 'https://cloudflare-dns.com/dns-query' },
  mullvad:    { name: 'Mullvad (no logs)',      url: 'https://doh.mullvad.net/dns-query' },
  adguard:    { name: 'AdGuard (blocks ads)',   url: 'https://dns.adguard-dns.com/dns-query' },
};

// Tor's SOCKS port depends on how it was installed: the standalone daemon
// listens on 9050, the Tor Browser bundle on 9150. Hardcoding one of them
// means "Tor mode" silently routes nowhere for half of all setups.
const TOR_PORTS = [9050, 9150];
const TOR_PRESET = 'socks5://127.0.0.1:9050';
let torPort = null;   // last port found listening

// A SOCKS proxy that is not running fails as a connection error on every
// page, which reads like a broken browser. Detect it and say so instead.
function probePort(port, timeout) {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { socket.destroy(); } catch (e) {} resolve(ok); } };
    socket.setTimeout(timeout || 400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, '127.0.0.1'); } catch (e) { finish(false); }
  });
}

async function detectTor() {
  for (const port of TOR_PORTS) {
    if (await probePort(port)) { torPort = port; return port; }
  }
  torPort = null;
  return null;
}

async function torStatus() {
  const port = await detectTor();
  return {
    running: port !== null,
    port,
    proxy: port ? 'socks5://127.0.0.1:' + port : null,
    hint: port
      ? 'Tor is listening on ' + port + '. Turn on Tor mode in Anonymity to route through it.'
      : 'No Tor found on 9050 or 9150. Install the Tor Expert Bundle or run the Tor Browser, then check again.',
  };
}

let getPrefs = () => ({});

function install(prefsGetter) {
  getPrefs = prefsGetter;
  applyDns();
}

// ── proxy ─────────────────────────────────────────────────────────
function proxyRules(p) {
  if (!p.proxyEnabled) return null;
  if (p.proxyMode === 'tor') {
    // The bundled daemon wins: we know its port for certain. Fall back to a
    // Tor the user installed themselves, on either of its usual ports.
    try {
      const bundled = require('./tor').proxyUrl();
      if (bundled) return bundled;
    } catch (e) {}
    return 'socks5://127.0.0.1:' + (torPort || 9050);
  }
  const host = (p.proxyHost || '').trim();
  if (!host) return null;
  const port = Number(p.proxyPort) || 0;
  const scheme = p.proxyScheme || 'socks5';
  return scheme + '://' + host + (port ? ':' + port : '');
}

async function applyProxy(ses) {
  const p = getPrefs() || {};
  const rules = proxyRules(p);
  try {
    if (!rules) {
      await ses.setProxy({ mode: 'direct' });
      return { ok: true, mode: 'direct' };
    }
    await ses.setProxy({
      proxyRules: rules,
      // Never send local addresses through the proxy.
      proxyBypassRules: '<local>',
    });
    return { ok: true, mode: rules };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ── encrypted DNS ─────────────────────────────────────────────────
function applyDns() {
  const p = getPrefs() || {};
  try {
    if (!p.dohEnabled) {
      app.configureHostResolver({ secureDnsMode: 'off' });
      return;
    }
    const server = (DOH_SERVERS[p.dohProvider] || DOH_SERVERS.quad9).url;
    app.configureHostResolver({
      secureDnsMode: 'secure',            // refuse to fall back to plaintext DNS
      secureDnsServers: [server],
    });
  } catch (e) {}
}

// ── leak plugging, per tab ────────────────────────────────────────
function harden(wc) {
  const p = getPrefs() || {};
  try {
    // The classic anonymity hole: WebRTC hands out your real local/public IP
    // even when every request is proxied.
    wc.setWebRTCIPHandlingPolicy(
      p.blockWebRTC ? 'disable_non_proxied_udp' : 'default_public_interface_only'
    );
  } catch (e) {}
}

// ── what do sites actually see? ───────────────────────────────────
function checkIp(ses) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ ok: false, error: 'timed out' }), 12000);
    try {
      const req = net.request({ url: 'https://api.ipify.org?format=json', session: ses });
      let body = '';
      req.on('response', (res) => {
        res.on('data', (c) => { body += c.toString(); });
        res.on('end', () => {
          try { finish({ ok: true, ip: JSON.parse(body).ip }); }
          catch (e) { finish({ ok: false, error: 'bad response' }); }
        });
      });
      req.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
      req.end();
    } catch (e) { finish({ ok: false, error: String(e.message || e) }); }
  });
}

function dohList() {
  return Object.entries(DOH_SERVERS).map(([id, s]) => ({ id, name: s.name }));
}

module.exports = { install, applyProxy, applyDns, harden, checkIp, dohList, torStatus, detectTor, TOR_PRESET };
