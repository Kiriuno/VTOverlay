// Self-updater: checks the GitHub repo's latest release, downloads this build's zip, and swaps the
// app folder in place. Works for the portable folder builds (no installer needed).
//
// Flow
//   1. check()    GET https://api.github.com/repos/<repo>/releases/latest → compare tag with our version
//   2. install()  download the asset for this build (VTOverlay-win32-x64.zip or VTOverlay-Viewer-win32-x64.zip)
//                 → extract to a temp folder → start the NEW exe from there with --vt-apply-update → we quit
//   3. the new exe (still in temp) waits for us to exit, copies itself over the install folder,
//      starts the installed exe and exits. The next launch cleans the temp folder up.
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = 'Kiriuno/VTOverlay';
const API = process.env.VT_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const TMP_PREFIX = 'vtoverlay-update-';

function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function assetName(receiverOnly) {
  return `${receiverOnly ? 'VTOverlay-Viewer' : 'VTOverlay'}-${process.platform}-${process.arch}.zip`;
}

async function check({ receiverOnly, version }) {
  const current = version || app.getVersion();
  if (!app.isPackaged && !process.env.VT_UPDATE_API) return { state: 'dev', current };
  let res;
  try {
    res = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VTOverlay-updater' } });
  } catch (err) { return { state: 'error', current, error: 'Could not reach GitHub (' + err.message + ')' }; }
  if (res.status === 404) return { state: 'none', current }; // no release published yet
  if (!res.ok) return { state: 'error', current, error: `GitHub answered ${res.status}` };
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!isNewer(latest, current)) return { state: 'latest', current, latest };
  const asset = (rel.assets || []).find((a) => a.name === assetName(receiverOnly));
  if (!asset) return { state: 'error', current, latest, error: `Release ${rel.tag_name} has no ${assetName(receiverOnly)}` };
  return {
    state: 'available', current, latest, url: asset.browser_download_url, size: asset.size,
    notes: String(rel.body || '').slice(0, 2000), page: rel.html_url,
  };
}

async function download(url, file, onProgress) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'VTOverlay-updater', Accept: 'application/octet-stream' } });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    onProgress?.(total ? got / total : 0);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
}

async function install(info, { onProgress, quit }) {
  if (!app.isPackaged && !process.env.VT_UPDATE_API) throw new Error('Running from source — use git pull instead.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const zip = path.join(work, 'update.zip');
  await download(info.url, zip, (f) => onProgress?.({ phase: 'download', fraction: f }));
  onProgress?.({ phase: 'extract', fraction: 1 });
  const extract = require('extract-zip');
  const dir = path.join(work, 'files');
  process.noAsar = true; // treat app.asar as a plain file while extracting
  try { await extract(zip, { dir }); } finally { process.noAsar = false; }
  fs.rmSync(zip, { force: true });
  // the zip holds one top-level folder (e.g. VTOverlay-win32-x64/)
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const root = entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
  const newExe = path.join(root, path.basename(process.execPath));
  if (!fs.existsSync(newExe)) throw new Error('The downloaded update does not contain ' + path.basename(process.execPath));
  const target = path.dirname(process.execPath);
  const args = ['--vt-apply-update', '--vt-target=' + target, '--vt-wait-pid=' + process.pid];
  spawn(newExe, args, { detached: true, stdio: 'ignore', cwd: root }).unref();
  await quit();
}

// Runs inside the NEW exe (from the temp folder) when started with --vt-apply-update.
// Returns true if it handled the launch (main.js must not start the normal app then).
function applyIfRequested() {
  if (!process.argv.includes('--vt-apply-update')) return false;
  const arg = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1);
  const target = arg('--vt-target'), pid = Number(arg('--vt-wait-pid'));
  const src = path.dirname(process.execPath);
  const log = (m) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'vtoverlay-update.log'), `${new Date().toISOString()} ${m}\n`); } catch {} };
  process.noAsar = true; // copy app.asar as a file, not as a folder
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  (async () => {
    try {
      log(`apply: ${src} -> ${target} (waiting for ${pid})`);
      for (let i = 0; i < 300 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (!target || !fs.existsSync(target)) throw new Error('install folder not found: ' + target);
      let lastErr;
      for (let attempt = 0; attempt < 20; attempt++) { // files can stay locked for a moment (antivirus, Explorer)
        try { fs.cpSync(src, target, { recursive: true, force: true }); lastErr = null; break; } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500)); }
      }
      if (lastErr) throw lastErr;
      log('apply: copied, restarting');
      spawn(path.join(target, path.basename(process.execPath)), ['--vt-updated'], { detached: true, stdio: 'ignore', cwd: target }).unref();
    } catch (e) {
      log('apply failed: ' + (e.stack || e.message));
    }
    app.exit(0);
  })();
  return true;
}

// Remove leftovers of earlier updates (not the one we might be running from).
function cleanup() {
  try {
    const here = path.dirname(process.execPath);
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const p = path.join(os.tmpdir(), name);
      if (here.startsWith(p)) continue;
      const prev = process.noAsar; process.noAsar = true;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {} finally { process.noAsar = prev; }
    }
  } catch {}
}

module.exports = { check, install, applyIfRequested, cleanup, isNewer, assetName, REPO };
