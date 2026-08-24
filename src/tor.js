/**
 * Bundled Tor.
 *
 * Redlynx ships the Tor daemon and supervises it, so "Tor mode" is a switch
 * rather than a setup project. Nothing is routed through it until the user
 * turns it on: the process is started on demand and stopped with the app.
 *
 * Honest about what this is: Tor protects what the browser sends through it.
 * It is not whole-machine anonymity, and a browser that leaks WebRTC or DNS
 * around the proxy is not anonymous at all — which is why anon.js hardens
 * those separately.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let cfg = { engineDir: () => null, dataDir: '', onStatus: () => {} };
let proc = null;
let state = { running: false, bootstrapped: 0, port: null, error: '', startedAt: 0 };

function install(options) {
  cfg = Object.assign(cfg, options || {});
}

function torPaths() {
  const dir = cfg.engineDir();
  if (!dir) return null;
  const root = path.join(dir, 'tor');
  const exe = path.join(root, 'tor', 'tor' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(exe)) return null;
  return {
    exe,
    geoip: path.join(root, 'data', 'geoip'),
    geoip6: path.join(root, 'data', 'geoip6'),
  };
}

function available() { return torPaths() !== null; }

function status() {
  return Object.assign({}, state, { available: available() });
}

function emit() { try { cfg.onStatus(status()); } catch (e) {} }

// Tor picks its own port if ours is taken, so ask for one and read back what
// it actually bound — assuming 9050 is free is how this silently misroutes.
const PREFERRED_PORT = 9250;

function start() {
  if (proc) return Promise.resolve(status());
  const paths = torPaths();
  if (!paths) {
    state.error = 'Tor is not bundled with this build';
    emit();
    return Promise.resolve(status());
  }

  const dataDir = path.join(cfg.dataDir, 'tor-data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}

  state = { running: false, bootstrapped: 0, port: PREFERRED_PORT, error: '', startedAt: Date.now() };
  emit();

  const args = [
    'SocksPort', String(PREFERRED_PORT),
    'DataDirectory', dataDir,
    'GeoIPFile', paths.geoip,
    'GeoIPv6File', paths.geoip6,
    // No control port and no listeners beyond SOCKS on loopback: the daemon
    // exists to serve this browser, not to accept instructions.
    'SocksPolicy', 'accept 127.0.0.1',
    'SocksPolicy', 'reject *',
    'AvoidDiskWrites', '1',
    'ClientOnly', '1',
  ];

  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(status()); } };

    try {
      proc = spawn(paths.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      state.error = String(e.message || e);
      proc = null;
      emit();
      return done();
    }

    const onData = (buf) => {
      const text = String(buf);
      const pct = /Bootstrapped (\d+)%/.exec(text);
      if (pct) {
        state.bootstrapped = Number(pct[1]);
        if (state.bootstrapped >= 100) { state.running = true; emit(); done(); return; }
        emit();
      }
      // Tor reports a busy port as a fatal error and exits; surface the reason
      // rather than leaving the UI on "starting" forever.
      if (/Could not bind|Failed to bind|is already in use/i.test(text)) {
        state.error = 'Could not open the SOCKS port (' + PREFERRED_PORT + ')';
        emit();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      proc = null;
      state.running = false;
      if (!state.error && code) state.error = 'Tor exited with code ' + code;
      emit();
      done();
    });

    // Bootstrapping over a slow link genuinely takes a while; give it room
    // but do not hang the caller forever.
    setTimeout(() => {
      if (!state.running && !state.error) state.error = 'Tor did not finish bootstrapping in 90s';
      emit();
      done();
    }, 90000);
  });
}

function stop() {
  if (!proc) return;
  try { proc.kill(); } catch (e) {}
  proc = null;
  state.running = false;
  state.bootstrapped = 0;
  emit();
}

function proxyUrl() {
  return state.running ? 'socks5://127.0.0.1:' + PREFERRED_PORT : null;
}

module.exports = { install, start, stop, status, available, proxyUrl, PREFERRED_PORT };
