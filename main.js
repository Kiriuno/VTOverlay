// VTOverlay: main process
//   * Sender   : webcam face tracking -> streams motion (numbers only, never video) to viewers
//   * Receiver : shows the avatar in one of three ways (switchable while connected)
//       - floating : small transparent always-on-top widget you can drag around
//       - window   : a normal app window
//       - screen   : transparent click-through layer over a whole monitor (optionally a zone of it);
//                    the broadcaster positions the avatar remotely
//     In floating / screen mode a small "control" window lives in the taskbar with every action,
//     because the avatar layer itself has no title bar and ignores the mouse.
const {
  app, BrowserWindow, protocol, ipcMain, globalShortcut, Tray, Menu,
  nativeImage, session, screen, desktopCapturer, clipboard, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

// Receiver-only builds set "vtReceiverOnly": true in their packaged package.json.
const PKG = require('./package.json');

// Started by the updater from its temp folder: copy the new version over the install folder and exit.
const APPLYING_UPDATE = updater.applyIfRequested();
const RECEIVER_ONLY = !!PKG.vtReceiverOnly || process.argv.includes('--viewer');

// Dev mode (npm run dev): a broadcaster and a viewer started together, already linked. Dev rooms use
// their own name prefix, so a dev app and a released app can never find each other's rooms.
const argVal = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1);
const DEV = process.argv.includes('--vt-dev');
const DEV_ROLE = argVal('--vt-dev-role');           // 'broadcast' | 'viewer'
const DEV_CODE = argVal('--vt-dev-code').toUpperCase();
const DEV_MODE = argVal('--vt-dev-mode') || 'window';
const DEV_OBS = process.argv.includes('--vt-dev-obs'); // broadcaster: "OBS only"
const DEV_COHOSTS = Math.max(0, Math.min(4, Number(argVal('--vt-dev-cohosts')) || 0)); // broadcaster: room for that many co-hosts
if (DEV) app.setPath('userData', app.getPath('userData') + '-dev-' + (DEV_ROLE || 'app')); // separate settings per instance

/** URL of one of our pages; dev instances tell every page they're in dev mode. */
function pageUrl(name, params = {}) {
  const q = new URLSearchParams(params);
  if (DEV) {
    q.set('dev', '1');
    if (DEV_CODE) q.set('devcode', DEV_CODE);
    if (process.env.VT_PEER_SERVER) q.set('peer', process.env.VT_PEER_SERVER); // e.g. {"host":"localhost","port":9000,"path":"/","secure":false}
  }
  const qs = q.toString();
  return `app://local/src/${name}${qs ? '?' + qs : ''}`;
}

// Keep tracking, networking and heartbeats running at full speed when a window is in the background,
// minimised, hidden in the tray or covered by another window (Chromium otherwise throttles timers,
// down to once a minute after 5 minutes, and pauses animation frames for occluded windows).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.vrm': 'model/gltf-binary',
};
const MODES = ['floating', 'window', 'screen'];
const MODE_NAMES = { floating: 'Floating widget', window: 'Window', screen: 'Full screen' };
// Windows picks the right size from the .ico (a simpler "VTO" drawing for the small ones: taskbar, title bar)
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const HOTKEY = 'CommandOrControl+Alt+V';

let mainWin = null;    // launcher / sender window
let overlayWin = null; // receiver avatar window
let panelWin = null;   // receiver control window (taskbar entry for floating / screen modes)
let tray = null;
let quitting = false;
let transitioning = 0; // >0 while we swap windows (mode switch, disconnect), don't quit then
// receiver state (survives mode switches)
// small viewer preferences that outlive a session
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } }
function writePrefs(patch) { try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch })); } catch {} }

const rx = {
  lowPower: null, // viewer's "Low resource mode", read from prefs
  fps: null,      // viewer's frame rate (30 / 45 / 60), read from prefs
  interact: null, // viewer allows interacting with the avatar (pull hair, headpat, boop), read from prefs
  code: '', name: '', mode: 'floating', displayId: null, share: false,
  locked: true, editingZone: false, sharing: false, status: { state: 'warn', text: 'Connecting…' },
};

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(__dirname, decodeURIComponent(pathname)));
    if (!file.startsWith(__dirname)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const webPrefs = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false, // keep tracking / rendering when not focused
  devTools: !app.isPackaged, // release builds: no developer tools (they'd show what the page holds, e.g. a broadcaster's avatar)
};
// …nor a remote debugger attached from the command line
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((sw) => app.commandLine.hasSwitch(sw))) app.exit(0);

// ---------- clean shutdown: let the page tell the other side "bye" before it disappears ----------
const goodbyeWaiters = new Map(); // webContents id -> resolve
ipcMain.on('goodbye-sent', (e) => { goodbyeWaiters.get(e.sender.id)?.(); });

function sayGoodbye(win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const id = win.webContents.id;
    const done = () => { goodbyeWaiters.delete(id); resolve(); };
    goodbyeWaiters.set(id, done);
    try { win.webContents.send('app-closing'); } catch { done(); }
    setTimeout(done, 600); // never hang on a stuck page
  });
}

async function closeWindow(win) {
  if (!win || win.isDestroyed()) return;
  win._managedClose = true;
  await sayGoodbye(win);
  if (!win.isDestroyed()) win.destroy();
}

const dbg = (...a) => { if (process.env.VT_DEBUG) console.log('[main]', ...a); };
async function quitApp() {
  if (quitting) return;
  quitting = true;
  dbg('quit: start');
  setTimeout(() => { dbg('quit: hard stop'); app.exit(0); }, 2000); // hard stop no matter what
  try { await Promise.all([mainWin, overlayWin].map(sayGoodbye)); } catch {}
  dbg('quit: goodbyes done');
  try { globalShortcut.unregisterAll(); } catch {}
  dbg('quit: shortcuts');
  try { tray?.destroy(); } catch {}
  dbg('quit: tray');
  for (const w of BrowserWindow.getAllWindows()) { try { dbg('quit: destroy', w.webContents.getURL()); w.destroy(); } catch {} }
  dbg('quit: exit');
  app.exit(0);
}

// X button: launcher/sender windows quit (saying bye first);
// receiver windows (control window, window-mode avatar) hide to the tray, only Quit quits.
let trayHintShown = false;
function guardClose(win, hideToTray) {
  win.on('close', (e) => {
    if (win._managedClose || quitting) return;
    e.preventDefault();
    if (!hideToTray) return quitApp();
    win.hide();
    if (!trayHintShown && tray && process.platform === 'win32') {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          iconType: 'info', title: 'VTOverlay is still running',
          content: 'Click its tray icon (^ next to the clock) to bring it back.',
        });
      } catch {}
    }
  });
}

function newWindow(opts, { hideToTray = false } = {}) {
  const win = new BrowserWindow({ icon: ICON, webPreferences: webPrefs, ...opts });
  win.removeMenu(); // no hidden menu bar popping up when you press Alt (e.g. while recording Alt+… hotkeys)
  guardClose(win, hideToTray);
  return win;
}

function showReceiverWindow() {
  const win = rx.mode === 'window' ? overlayWin : panelWin;
  if (!win || win.isDestroyed()) { if (rx.mode !== 'window' && overlayWin) openPanel(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- launcher / sender ----------
function showLauncher() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setSize(560, RECEIVER_ONLY ? 700 : 820);
    mainWin.center();
    mainWin.loadURL(pageUrl('launcher.html'));
    mainWin.show();
    return;
  }
  mainWin = newWindow({
    width: 560, height: RECEIVER_ONLY ? 700 : 820, title: RECEIVER_ONLY ? 'VTOverlay Viewer' : 'VTOverlay',
    backgroundColor: '#14121a', autoHideMenuBar: true,
  });
  mainWin.loadURL(pageUrl('launcher.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

// "just updated" / "update failed" are shown on the first start screen of this launch only; coming
// back to the start screen later (after broadcasting…) must not show them again
let launchNotice = { justUpdated: process.argv.includes('--vt-updated'), updateFailed: process.argv.includes('--vt-update-failed') };
const takeLaunchNotice = () => { const n = launchNotice; launchNotice = { justUpdated: false, updateFailed: false }; return n; };
ipcMain.handle('get-config', () => ({
  ...takeLaunchNotice(),
  receiverOnly: RECEIVER_ONLY,
  displays: displayList(),
  version: PKG.version,
  autoUpdate: takeAutoUpdate(), // true only for the first start screen of this launch
  repo: updater.REPO,
}));

// ---------- updates (GitHub releases) ----------
let lastUpdateInfo = null;
let autoUpdateDone = false;
function takeAutoUpdate() { const first = !autoUpdateDone; autoUpdateDone = true; return first; }
let updateAbort = null;
ipcMain.on('update-cancel', () => updateAbort?.abort());
ipcMain.handle('update-check', async () => {
  lastUpdateInfo = await updater.check({ receiverOnly: RECEIVER_ONLY, version: PKG.version });
  return lastUpdateInfo;
});
ipcMain.handle('update-install', async (e) => {
  if (lastUpdateInfo?.state !== 'available') return { ok: false, error: 'No update to install' };
  updateAbort = new AbortController();
  try {
    await updater.install(lastUpdateInfo, {
      onProgress: (p) => { try { e.sender.send('update-progress', p); } catch {} },
      quit: () => quitApp(),
      signal: updateAbort.signal,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally { updateAbort = null; }
});
ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url);
});

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => {
    const b = d.bounds, w = d.workArea, f = (n) => +n.toFixed(4);
    return {
      id: d.id, label: `Screen ${i + 1}, ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}`,
      // for placing on your own screen ("My screen"): its shape and where the taskbar is
      aspect: f(b.width / b.height),
      work: { x: f((w.x - b.x) / b.width), y: f((w.y - b.y) / b.height), w: f(w.width / b.width), h: f(w.height / b.height) },
    };
  });
}

ipcMain.handle('start-sender', (_e, o) => startSenderPage(o?.obs ? { obs: '' } : o?.room ? { room: '1' } : {}));
// joining someone else's room with your own avatar: the same broadcaster page, in co-host mode
ipcMain.handle('start-guest', (_e, o) => {
  const code = String(o?.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return;
  startSenderPage({ join: code, name: String(o?.name || '').slice(0, 24) });
});
function startSenderPage(params = {}) {
  if (!mainWin || RECEIVER_ONLY) return;
  // never taller / wider than the screen space it's on (minus the taskbar), or the bottom of the sidebar
  // ends up hidden behind the taskbar and looks like it can't scroll all the way
  const area = screen.getDisplayMatching(mainWin.getBounds()).workArea;
  mainWin.setSize(Math.min(1180, area.width), Math.min(760, area.height));
  mainWin.center();
  const fit = () => {
    if (!mainWin || mainWin.isDestroyed() || mainWin.isMaximized() || mainWin.isFullScreen()) return;
    const b = mainWin.getBounds(), wa = screen.getDisplayMatching(b).workArea;
    const h = Math.min(b.height, wa.height), y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h));
    if (h !== b.height || y !== b.y) mainWin.setBounds({ ...b, y, height: h });
  };
  mainWin.removeAllListeners('moved'); mainWin.on('moved', fit);
  mainWin.loadURL(pageUrl('sender.html', params));
}

// Global hotkeys for the broadcaster (expressions, props). They work while another app has focus.
// The page sends the full list [{ accel, id }]; we register them and report which ones failed
// (usually because another app already owns that combination).
let senderHotkeys = [];
function setSenderHotkeys(list) {
  for (const accel of senderHotkeys) { try { globalShortcut.unregister(accel); } catch {} }
  senderHotkeys = [];
  const results = {};
  for (const { accel, id } of list || []) {
    let ok = false;
    try {
      ok = !globalShortcut.isRegistered(accel) && globalShortcut.register(accel, () => mainWin?.webContents.send('hotkey', id));
    } catch { ok = false; }
    if (ok) senderHotkeys.push(accel);
    results[id] = ok;
  }
  return results;
}
ipcMain.handle('set-hotkeys', (_e, list) => setSenderHotkeys(list));

// sender page already said bye to its viewers
ipcMain.on('back-to-menu', () => { setSenderHotkeys([]); closeOutput(); closeMirror(); showLauncher(); });

// Camera output: a plain window with just the avatar on a solid background, for OBS window capture
// (→ chroma key → OBS Virtual Camera, which Discord & co. see as a webcam).
let outputWin = null;
function closeOutput() { if (outputWin && !outputWin.isDestroyed()) { outputWin._managedClose = true; outputWin.destroy(); } outputWin = null; }
ipcMain.on('output-open', (_e, opts = {}) => {
  closeOutput();
  const w = Math.max(320, Math.min(3840, Number(opts.w) || 1280)), h = Math.max(240, Math.min(2160, Number(opts.h) || 720));
  const bg = /^#[0-9a-f]{6}$/i.test(String(opts.bg)) ? opts.bg : '#00b140';
  outputWin = new BrowserWindow({ icon: ICON, webPreferences: webPrefs, width: w, height: h, useContentSize: true, title: 'VTOverlay Output', backgroundColor: bg, autoHideMenuBar: true });
  outputWin.removeMenu();
  outputWin.loadURL(pageUrl('output.html', { bg }));
  const me = outputWin;
  me.on('closed', () => { if (outputWin === me) outputWin = null; try { mainWin?.webContents.send('output-closed'); } catch {} });
});
ipcMain.on('output-close', () => closeOutput());

/**
 * A full-screen avatar layer on monitor `d`: the viewer's Full screen mode and the broadcaster's
 * "Show on my screen" are both made here, so they always sit in the same place among the other
 * windows (on top of apps, the taskbar's own behaviour unchanged) and behave the same.
 * See-through, click-through (the page takes the mouse only over grabbable parts), never focused.
 */
function createScreenLayer(d, url, { title = 'VTOverlay', guard = false } = {}) {
  const opts = {
    ...d.bounds, transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, backgroundColor: '#00000000', title,
  };
  const win = guard ? newWindow(opts) : new BrowserWindow({ icon: ICON, webPreferences: webPrefs, ...opts });
  if (!guard) win.removeMenu();
  win.setBounds(d.bounds); // some setups ignore the initial position on secondary monitors
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.loadURL(url);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setFocusable(false);
  win.hotRects = null; // where its avatars are (from the page); null = not known yet: pass every move
  win.forwarding = true;
  return win;
}

// Mouse moves reach a full-screen layer only while the cursor is over one of its avatars (plus a margin).
// Passing every move to a see-through window makes the cursor flicker on Windows between the cursor of the
// window below and this one's.
ipcMain.on('overlay-hot-rects', (e, rects) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && Array.isArray(rects)) w.hotRects = rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite));
});
const screenLayers = () => [overlayWin && rx.mode === 'screen' && overlayWin, mirrorWin].filter((w) => w && !w.isDestroyed());
setInterval(() => {
  const layers = screenLayers();
  if (!layers.length) return;
  const c = screen.getCursorScreenPoint();
  for (const w of layers) {
    if (w.capturing || (w === overlayWin && rx.editingZone)) continue; // it has the mouse right now
    const b = w.getBounds(), x = c.x - b.x, y = c.y - b.y, m = 24;
    const over = !w.hotRects || w.hotRects.some(([l, t, wd, h]) => x >= l - m && x <= l + wd + m && y >= t - m && y <= t + h + m);
    if (over !== w.forwarding) { w.forwarding = over; w.setIgnoreMouseEvents(true, { forward: over }); }
  }
}, 50);

// Mirror: the broadcaster's own avatar, full screen on their monitor, placed exactly like on the
// viewer they picked (a click-through full-screen overlay, fed by the broadcaster window).
let mirrorWin = null, mirrorDisplayId = null;
function closeMirror() { if (mirrorWin && !mirrorWin.isDestroyed()) { mirrorWin._managedClose = true; mirrorWin.destroy(); } mirrorWin = null; }
ipcMain.on('mirror-open', (_e, opts = {}) => {
  // replacing it (another screen picked): the old one goes quietly, it's not "closed" for the broadcaster
  const old = mirrorWin; mirrorWin = null;
  if (old && !old.isDestroyed()) { old._managedClose = true; old.destroy(); }
  const d = displayById(Number(opts.displayId));
  mirrorDisplayId = d.id;
  const win = mirrorWin = createScreenLayer(d, pageUrl('overlay.html', { mode: 'screen', mirror: '1', interact: '1', code: '' }), { title: 'VTOverlay mirror' });
  win.on('closed', () => { if (mirrorWin === win) mirrorWin = null; try { mainWin?.webContents.send('mirror-closed'); } catch {} });
});
ipcMain.on('mirror-close', () => closeMirror());

// Memory / CPU per part of the app, for the broadcaster's Performance panel
ipcMain.handle('app-metrics', () => {
  const names = new Map();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const url = w.webContents.getURL();
    const name = w === outputWin ? 'Camera output' : w === mirrorWin ? 'Show on my screen'
      : url.includes('sender.html') ? 'Broadcaster window' : url.includes('overlay.html') ? 'Viewer window' : url.includes('launcher.html') ? 'Start screen' : 'Window';
    try { names.set(w.webContents.getOSProcessId(), name); } catch {}
  }
  return app.getAppMetrics().map((p) => ({
    name: names.get(p.pid) || ({ Browser: 'Main process', GPU: 'Graphics (GPU process)', Utility: 'Helper (' + (p.name || 'utility') + ')' }[p.type] || p.type),
    mb: Math.round((p.memory.privateBytes || p.memory.workingSetSize) / 1024),
    cpu: +p.cpu.percentCPUUsage.toFixed(1),
  }));
});
const isMirror = (e) => !!mirrorWin && !mirrorWin.isDestroyed() && e.sender === mirrorWin.webContents;

// the browser clipboard API is blocked by our permission rules; use Electron's
ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text ?? '')));

// ---------- receiver ----------
function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

ipcMain.handle('start-receiver', (_e, opts) => startReceiver(opts));
function startReceiver(opts) {
  rx.code = opts.code;
  rx.name = opts.name || '';
  rx.mode = MODES.includes(opts.mode) ? opts.mode : 'floating';
  rx.displayId = displayById(Number(opts.displayId)).id;
  rx.share = !!opts.share;
  rx.status = { state: 'warn', text: 'Connecting…' };
  transitioning++;
  try {
    openOverlay();
    if (!tray) createTray();
    globalShortcut.unregister(HOTKEY);
    globalShortcut.register(HOTKEY, () => doAction(rx.mode === 'floating' ? 'lock-toggle' : 'zone-toggle'));
    if (mainWin) { mainWin._managedClose = true; mainWin.destroy(); mainWin = null; }
  } finally { transitioning--; }
}

function openOverlay() {
  floatMembers = 1; // a fresh widget starts at the size for one avatar
  rx.editingZone = false;
  rx.sharing = false;
  if (rx.interact === null) rx.interact = readPrefs().interact !== false;
  if (rx.lowPower === null) rx.lowPower = readPrefs().lowPower === true;
  if (rx.fps === null) rx.fps = [30, 45, 60].includes(readPrefs().fps) ? readPrefs().fps : 45;
  const qs = new URLSearchParams({ code: rx.code, mode: rx.mode, name: rx.name, interact: rx.interact ? '1' : '0', low: rx.lowPower ? '1' : '0', fps: String(rx.fps) });
  let win;
  if (rx.mode === 'window') {
    win = newWindow({ width: 520, height: 720, title: 'VTOverlay', backgroundColor: '#14121a', autoHideMenuBar: true }, { hideToTray: true });
  } else if (rx.mode === 'screen') {
    win = createScreenLayer(displayById(rx.displayId), pageUrl('overlay.html', Object.fromEntries(qs)), { guard: true }); // same as Show on my screen
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    const w = 420, h = 620;
    win = newWindow({
      width: w, height: h, x: area.x + area.width - w - 24, y: area.y + area.height - h,
      transparent: true, frame: false, resizable: false, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000', title: 'VTOverlay',
    });
  }
  overlayWin = win;
  if (rx.mode === 'floating') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
  }
  if (rx.mode !== 'screen') win.loadURL(pageUrl('overlay.html', Object.fromEntries(qs)));
  win.on('closed', () => { if (overlayWin === win) overlayWin = null; });

  if (rx.mode === 'floating') setLocked(false); // start in edit mode so they can place it
  win.webContents.once('did-finish-load', () => {
    if (rx.mode === 'screen' && rx.share) setSharing(true);
  });

  // the avatar layer has no taskbar entry in these modes → give the user a control window
  if (rx.mode === 'window') closePanel();
  else openPanel();
  pushState();
}

// ---------- control window ----------
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.show(); panelWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  panelWin = newWindow({
    width: 380, height: 400, x: area.x + 24, y: area.y + area.height - 424,
    title: 'VTOverlay', backgroundColor: '#14121a', autoHideMenuBar: true,
    resizable: false, maximizable: false, fullscreenable: false,
  }, { hideToTray: true });
  panelWin.loadURL(pageUrl('panel.html'));
  panelWin.webContents.once('did-finish-load', pushState);
  panelWin.on('closed', () => { panelWin = null; });
}

function closePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin._managedClose = true;
  panelWin.destroy();
  panelWin = null;
}

function pushState() {
  const state = {
    code: rx.code, mode: rx.mode, displayId: rx.displayId, displays: displayList(),
    locked: rx.locked, editingZone: rx.editingZone, sharing: rx.sharing, status: rx.status, interact: rx.interact !== false, lowPower: !!rx.lowPower, fps: rx.fps,
    alwaysOnTop: !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isAlwaysOnTop(),
  };
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('rx-state', state);
  if (panelWin && !panelWin.isDestroyed()) panelWin.setTitle('VTOverlay'); // no room code in the title bar (it can be hidden in the window)
  refreshTray();
}

// single entry point for every receiver action (control window, tray, hotkey, in-overlay buttons)
async function doAction(action, arg) {
  switch (action) {
    case 'mode': return switchMode(arg);
    case 'display': return switchMode('screen', arg);
    case 'lock-toggle': return rx.mode === 'floating' && setLocked(!rx.locked);
    case 'lock': return rx.mode === 'floating' && setLocked(!!arg);
    case 'reset-pos': return resetFloatingPosition();
    case 'zone-toggle': return rx.mode === 'screen' && setEditingZone(!rx.editingZone);
    case 'zone-reset': return overlayWin?.webContents.send('zone-reset');
    case 'share': return setSharing(!!arg);
    case 'on-top': overlayWin?.setAlwaysOnTop(!!arg, 'screen-saver'); return pushState();
    case 'interact':
      rx.interact = !!arg; writePrefs({ interact: rx.interact });
      overlayWin?.webContents.send('interact-changed', rx.interact);
      return pushState();
    case 'low-power':
      rx.lowPower = !!arg; writePrefs({ lowPower: rx.lowPower });
      overlayWin?.webContents.send('low-power', rx.lowPower);
      return pushState();
    case 'fps':
      rx.fps = [30, 45, 60].includes(Number(arg)) ? Number(arg) : 45; writePrefs({ fps: rx.fps });
      overlayWin?.webContents.send('fps', rx.fps);
      return pushState();
    case 'reconnect': return overlayWin?.webContents.send('reconnect');
    case 'disconnect': return disconnectReceiver();
    case 'show': return showReceiverWindow();
    case 'quit': return quitApp();
  }
}
ipcMain.on('rx-action', (_e, action, arg) => doAction(action, arg));
ipcMain.on('rx-status', (_e, state, text) => {
  if (isMirror(_e)) return;
  if (DEV && text !== rx.status?.text) console.log('viewer status:', text); // shows in the npm run dev terminal
  rx.status = { state, text }; pushState();
});

async function switchMode(mode, displayId) {
  if (!MODES.includes(mode)) return;
  const newDisplay = displayId != null ? displayById(Number(displayId)).id : rx.displayId;
  if (mode === rx.mode && newDisplay === rx.displayId) return;
  rx.mode = mode;
  rx.displayId = newDisplay;
  transitioning++;
  try {
    const old = overlayWin;
    overlayWin = null;
    await closeWindow(old);
    openOverlay();
  } finally { transitioning--; }
}

async function disconnectReceiver() {
  transitioning++;
  try {
    const old = overlayWin;
    overlayWin = null;
    await closeWindow(old);
    closePanel();
    globalShortcut.unregister(HOTKEY);
    tray?.destroy(); tray = null;
    showLauncher();
  } finally { transitioning--; }
}

// legacy channels used by the overlay page
ipcMain.on('rx-switch-mode', (_e, mode) => switchMode(mode));

// The part of the monitor not covered by the taskbar, as fractions of the monitor (full screen mode
// keeps the avatar inside it, and the broadcaster sees the taskbar in the placement view).
function workAreaOf(displayId) {
  const d = displayById(displayId), b = d.bounds, w = d.workArea;
  return { x: (w.x - b.x) / b.width, y: (w.y - b.y) / b.height, w: w.width / b.width, h: w.height / b.height };
}
ipcMain.handle('get-work-area', (e) => workAreaOf(isMirror(e) ? mirrorDisplayId : rx.displayId));
ipcMain.on('rx-disconnect', () => disconnectReceiver());

function setClickThrough(on) {
  if (!overlayWin) return;
  overlayWin.setIgnoreMouseEvents(on, { forward: true });
  overlayWin.forwarding = true; // (re)checked against where the avatars are, see screenLayers
  if (rx.mode === 'screen') {
    overlayWin.setFocusable(!on);
    if (!on) overlayWin.focus();
  }
}

// A click-through overlay (full screen, or a locked floating widget) briefly takes the mouse while the
// cursor is over a part of the avatar that can be grabbed (hair, clothes…), and gives it back after.
ipcMain.on('overlay-capture-mouse', (_e, on) => {
  if (isMirror(_e)) { mirrorWin.capturing = on; mirrorWin.forwarding = true; mirrorWin.setIgnoreMouseEvents(!on, { forward: true }); return; } // click-through except over the avatar's hair, nose…
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const clickThrough = (rx.mode === 'screen' && !rx.editingZone) || (rx.mode === 'floating' && rx.locked);
  overlayWin.capturing = on; overlayWin.forwarding = true;
  if (clickThrough) overlayWin.setIgnoreMouseEvents(!on, { forward: true });
});

// floating mode: locked = click-through
function setLocked(locked) {
  rx.locked = locked;
  setClickThrough(locked);
  overlayWin?.webContents.send('lock-changed', locked);
  pushState();
}

// screen mode: zone editor takes the mouse while open
function setEditingZone(on) {
  rx.editingZone = on;
  setClickThrough(!on);
  overlayWin?.webContents.send('zone-edit', on);
  pushState();
}

function setSharing(on) {
  rx.sharing = on;
  rx.share = on; // remember for mode switches
  overlayWin?.webContents.send('share-changed', on);
  pushState();
}

ipcMain.on('overlay-move-by', (_e, dx, dy) => {
  if (!overlayWin || rx.mode !== 'floating') return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.on('overlay-resize-by', (_e, factor) => {
  if (!overlayWin || rx.mode !== 'floating') return;
  const b = overlayWin.getBounds();
  const w = Math.max(160, Math.min(2000, Math.round(b.width * factor)));
  const h = Math.max(240, Math.min(3000, Math.round(b.height * factor)));
  overlayWin.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: b.y + b.height - h, width: w, height: h });
});

// multi-model rooms: the floating widget gets wider for each extra avatar (they stand in a row)
let floatMembers = 1;
ipcMain.on('overlay-members', (e, n) => {
  n = Math.max(1, Math.min(5, Number(n) || 1));
  if (!overlayWin || e.sender !== overlayWin.webContents || rx.mode !== 'floating' || n === floatMembers) return;
  const b = overlayWin.getBounds();
  const per = (w) => w - b.height * 0.62 * 0.85 * (floatMembers - 1); // width for one avatar
  const w = Math.round(per(b.width) + b.height * 0.62 * 0.85 * (n - 1));
  floatMembers = n;
  overlayWin.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: b.y, width: w, height: b.height });
});

ipcMain.on('overlay-set-locked', (_e, locked) => setLocked(!!locked));
ipcMain.on('zone-edit-done', () => setEditingZone(false));
ipcMain.on('set-sharing', (_e, on) => setSharing(!!on));
ipcMain.on('quit', () => quitApp());

// ---------- tray ----------
function trayMenu() {
  const displays = screen.getAllDisplays();
  const items = [
    { label: "Watching a friend's avatar", enabled: false },
    { type: 'separator' },
  ];
  items.push({ label: rx.mode === 'window' ? 'Show window' : 'Show controls', click: () => showReceiverWindow() });
  items.push({
    label: 'Display mode',
    submenu: MODES.map((m) => ({ type: 'radio', label: MODE_NAMES[m], checked: rx.mode === m, click: () => doAction('mode', m) })),
  });
  if (displays.length > 1) {
    items.push({
      label: 'Full screen on…',
      submenu: displays.map((d, i) => ({
        type: 'radio', label: `Screen ${i + 1}, ${d.size.width}×${d.size.height}`,
        checked: rx.mode === 'screen' && rx.displayId === d.id, click: () => doAction('display', d.id),
      })),
    });
  }
  items.push({ type: 'separator' });
  if (rx.mode === 'floating') {
    items.push(
      { label: rx.locked ? 'Move / resize avatar  (Ctrl+Alt+V)' : 'Lock avatar in place  (Ctrl+Alt+V)', click: () => doAction('lock-toggle') },
      { label: 'Reset position', click: () => doAction('reset-pos') },
    );
  } else if (rx.mode === 'screen') {
    items.push(
      { label: rx.editingZone ? 'Finish zone selection' : 'Select zone…  (Ctrl+Alt+V)', click: () => doAction('zone-toggle') },
      { label: 'Use whole screen', click: () => doAction('zone-reset') },
      { type: 'checkbox', label: 'Share this screen with broadcaster', checked: rx.sharing, click: (mi) => doAction('share', mi.checked) },
    );
  } else {
    items.push({ type: 'checkbox', label: 'Always on top', checked: !!overlayWin?.isAlwaysOnTop(), click: (mi) => doAction('on-top', mi.checked) });
  }
  items.push(
    { type: 'separator' },
    { type: 'checkbox', label: 'Allow interactions (hair, headpat, boop)', checked: rx.interact !== false, click: (mi) => doAction('interact', mi.checked) },
    { type: 'checkbox', label: 'Low resource mode', checked: !!rx.lowPower, click: (mi) => doAction('low-power', mi.checked) },
    { type: 'separator' },
    { label: 'Reconnect', click: () => doAction('reconnect') },
    { label: 'Disconnect (back to menu)', click: () => doAction('disconnect') },
    { label: 'Quit VTOverlay', click: () => doAction('quit') },
  );
  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setToolTip(`VTOverlay${rx.sharing ? ': sharing screen' : ''}`);
}

function createTray() {
  // PNG (Windows can't draw SVG tray icons, that left the old icon invisible)
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  const hi = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray@2x.png'));
  if (!hi.isEmpty()) icon.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', () => showReceiverWindow());
  refreshTray();
}

function resetFloatingPosition() {
  if (!overlayWin || rx.mode !== 'floating') return;
  const area = screen.getPrimaryDisplay().workArea;
  overlayWin.setBounds({ width: 420, height: 620, x: area.x + area.width - 444, y: area.y + area.height - 620 });
}

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  if (APPLYING_UPDATE) return; // the updater is copying files; no windows
  updater.cleanup();
  if (process.platform === 'win32') app.setAppUserModelId(RECEIVER_ONLY ? 'VTOverlay.Viewer' : 'VTOverlay');
  registerProtocol();
  // Webcam only for the sender page; screen capture only for the overlay while sharing is on.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const url = wc.getURL();
    const isSender = url.startsWith('app://local/src/sender.html');
    const isOverlaySharing = url.startsWith('app://local/src/overlay.html') && rx.sharing && rx.mode === 'screen';
    if (permission === 'media') return cb(isSender || isOverlaySharing);
    if (permission === 'display-capture') return cb(isOverlaySharing);
    if (permission === 'clipboard-sanitized-write') return cb(true);
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    if (!rx.sharing || rx.mode !== 'screen') return callback(null);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.display_id === String(rx.displayId)) || sources[0];
    callback(src ? { video: src } : null);
  });
  showLauncher();
  if (DEV) {
    const title = `[DEV ${DEV_ROLE}] `;
    app.on('browser-window-created', (_e, w) => w.on('page-title-updated', (ev, t) => { if (!t.startsWith('[DEV')) { ev.preventDefault(); w.setTitle(title + t); } }));
    if (DEV_ROLE === 'broadcast' && !RECEIVER_ONLY) setTimeout(() => startSenderPage(DEV_OBS ? { obs: String(DEV_COHOSTS + 1) } : DEV_COHOSTS ? { room: String(DEV_COHOSTS + 1) } : {}), 800);
    // co-hosts join the dev broadcaster's room with their own avatar (load one the first time; it's remembered)
    if (/^cohost\d+$/.test(DEV_ROLE) && DEV_CODE && !RECEIVER_ONLY) setTimeout(() => startSenderPage({ join: DEV_CODE, name: 'Dev co-host ' + DEV_ROLE.slice(6) }), 2500);
    if (DEV_ROLE === 'viewer' && DEV_CODE) setTimeout(() => startReceiver({ code: DEV_CODE, mode: DEV_MODE, name: 'Dev viewer', displayId: screen.getPrimaryDisplay().id }), 4000);
  }
  // taskbar moved / resized / auto-hide toggled, resolution changed…
  screen.on('display-metrics-changed', () => {
    if (rx.mode === 'screen' && overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('work-area', workAreaOf(rx.displayId));
    if (mirrorWin && !mirrorWin.isDestroyed()) mirrorWin.webContents.send('work-area', workAreaOf(mirrorDisplayId));
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!transitioning && !quitting && !APPLYING_UPDATE) app.exit(0); });
