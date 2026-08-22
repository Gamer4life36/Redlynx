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

// Tor's SOCKS port when the Tor Browser / daemon is running locally.
const TOR_PRESET = 'socks5://127.0.0.1:9050';

let getPrefs = () => ({});

function install(prefsGetter) {
  getPrefs = prefsGetter;
  applyDns();
}

// ── proxy ─────────────────────────────────────────────────────────
function proxyRules(p) {
  if (!p.proxyEnabled) return null;
  if (p.proxyMode === 'tor') return TOR_PRESET;
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

module.exports = { install, applyProxy, applyDns, harden, checkIp, dohList, TOR_PRESET };
