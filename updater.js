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
    // never answer from the HTTP cache: a release published while the app was open must show up
    res = await net.fetch(API, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VTOverlay-updater', 'Cache-Control': 'no-cache' } });
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

async function download(url, file, onProgress, signal) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'VTOverlay-updater', Accept: 'application/octet-stream' }, signal });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); out.destroy(); throw new Error('cancelled'); }
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    onProgress?.(total ? got / total : 0);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
}

/**
 * Extract a zip into dir, refusing anything that could write outside it: absolute paths or ".."
 * (yauzl rejects those itself) and symbolic links (which could point anywhere). Release zips only
 * hold plain files and folders, so anything else means the download isn't what we expect.
 */
function unzip(zipPath, dir) {
  const yauzl = require('yauzl');
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const fail = (e) => { try { zip.close(); } catch {} reject(e); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const dest = path.resolve(root, entry.fileName);
        if ((mode & 0o170000) === 0o120000) return fail(new Error('update archive contains a link: ' + entry.fileName));
        if (dest !== root && !dest.startsWith(root + path.sep)) return fail(new Error('update archive entry outside its folder: ' + entry.fileName));
        if (/\/$/.test(entry.fileName)) { fs.mkdirSync(dest, { recursive: true }); return zip.readEntry(); }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e) return fail(e);
          const ws = fs.createWriteStream(dest, { mode: (mode & 0o777) || 0o644 });
          rs.on('error', fail); ws.on('error', fail);
          ws.on('finish', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
      zip.readEntry();
    });
  });
}

async function install(info, { onProgress, quit, signal }) {
  if (!app.isPackaged && !process.env.VT_UPDATE_API) throw new Error('Running from source, use git pull instead.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const zip = path.join(work, 'update.zip');
  try {
    await download(info.url, zip, (f) => onProgress?.({ phase: 'download', fraction: f }), signal);
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw signal?.aborted ? new Error('cancelled') : err;
  }
  if (signal?.aborted) { fs.rmSync(work, { recursive: true, force: true }); throw new Error('cancelled'); }
  onProgress?.({ phase: 'extract', fraction: 1 });
  const dir = path.join(work, 'files');
  process.noAsar = true; // treat app.asar as a plain file while extracting
  try { await unzip(zip, dir); } finally { process.noAsar = false; }
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
  // This helper must never show an error box (on Windows that blocks until someone clicks OK).
  process.on('uncaughtException', (e) => log('uncaught: ' + (e.stack || e.message)));
  process.on('unhandledRejection', (e) => log('unhandled: ' + (e?.stack || e)));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const installedExe = path.join(target, path.basename(process.execPath));
  (async () => {
    try {
      log(`apply: ${src} -> ${target} (waiting for ${pid})`);
      for (let i = 0; i < 300 && pid && alive(pid); i++) await sleep(100);
      if (!target || !fs.existsSync(target)) throw new Error('install folder not found: ' + target);
      // Windows: the old app can leave helper processes behind for a while (crash reporter, GPU /
      // camera utility processes, all VTOverlay.exe), and they keep the files locked. Stop anything
      // still running from the install folder (never this helper, which runs from the temp folder).
      stopLeftovers(target, log);
      // Only now (main.js has finished loading from app.asar) switch asar handling off,
      // so app.asar gets copied as a file instead of being read as a folder.
      process.noAsar = true;
      let lastErr;
      const t0 = Date.now();
      for (let attempt = 0; Date.now() - t0 < 60000; attempt++) { // antivirus / Explorer can hold files for a moment
        try { fs.cpSync(src, target, { recursive: true, force: true }); lastErr = null; break; } catch (e) {
          lastErr = e;
          if (attempt % 5 === 4) { log(`apply: still locked (${e.code || e.message}), retrying…`); stopLeftovers(target, log); }
          await sleep(1000);
        }
      }
      if (lastErr) throw lastErr;
      log('apply: copied, restarting');
      spawn(installedExe, ['--vt-updated'], { detached: true, stdio: 'ignore', cwd: target }).unref();
    } catch (e) {
      log('apply failed: ' + (e.stack || e.message));
      // never leave you with nothing: start the version you had, and say what happened
      try { if (fs.existsSync(installedExe)) spawn(installedExe, ['--vt-update-failed'], { detached: true, stdio: 'ignore', cwd: target }).unref(); } catch {}
    }
    app.exit(0);
  })();
  return true;
}

// Windows only: end processes whose executable lives in the install folder (except ourselves).
function stopLeftovers(target, log) {
  if (process.platform !== 'win32') return;
  try {
    const dir = path.resolve(target).replace(/'/g, "''") + '\\*';
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir}' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (out.trim()) log('apply: stopped leftover processes ' + out.trim().split(/\s+/).join(', '));
  } catch (e) { log('apply: could not list leftover processes: ' + e.message); }
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
