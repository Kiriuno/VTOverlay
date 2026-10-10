// VTOverlay — main process
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

// Keep tracking, networking and heartbeats running at full speed when a window is in the background,
// minimised, hidden in the tray or covered by another window (Chromium otherwise throttles timers —
// down to once a minute after 5 minutes — and pauses animation frames for occluded windows).
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
const ICON = path.join(__dirname, 'assets', 'icon.png');
const HOTKEY = 'CommandOrControl+Alt+V';

let mainWin = null;    // launcher / sender window
let overlayWin = null; // receiver avatar window
let panelWin = null;   // receiver control window (taskbar entry for floating / screen modes)
let tray = null;
let quitting = false;
let transitioning = 0; // >0 while we swap windows (mode switch, disconnect) — don't quit then
// receiver state (survives mode switches)
const rx = {
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
};

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
// receiver windows (control window, window-mode avatar) hide to the tray — only Quit quits.
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
          content: 'Click the VTOverlay icon in the tray (^ next to the clock) to bring it back. Use Quit to close it.',
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
    mainWin.loadURL('app://local/src/launcher.html');
    mainWin.show();
    return;
  }
  mainWin = newWindow({
    width: 560, height: RECEIVER_ONLY ? 700 : 820, title: RECEIVER_ONLY ? 'VTOverlay Viewer' : 'VTOverlay',
    backgroundColor: '#14121a', autoHideMenuBar: true,
  });
  mainWin.loadURL('app://local/src/launcher.html');
  mainWin.on('closed', () => { mainWin = null; });
}

ipcMain.handle('get-config', () => ({
  receiverOnly: RECEIVER_ONLY,
  displays: displayList(),
  version: PKG.version,
  justUpdated: process.argv.includes('--vt-updated'),
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
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, label: `Screen ${i + 1} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}`,
  }));
}

ipcMain.handle('start-sender', () => {
  if (!mainWin || RECEIVER_ONLY) return;
  mainWin.setSize(1180, 760);
  mainWin.center();
  mainWin.loadURL('app://local/src/sender.html');
});

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
ipcMain.on('back-to-menu', () => { setSenderHotkeys([]); showLauncher(); });

// the browser clipboard API is blocked by our permission rules; use Electron's
ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text ?? '')));

// ---------- receiver ----------
function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

ipcMain.handle('start-receiver', (_e, opts) => {
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
});

function openOverlay() {
  rx.editingZone = false;
  rx.sharing = false;
  const qs = new URLSearchParams({ code: rx.code, mode: rx.mode, name: rx.name });
  let win;
  if (rx.mode === 'window') {
    win = newWindow({ width: 520, height: 720, title: `VTOverlay — ${rx.code}`, backgroundColor: '#14121a', autoHideMenuBar: true }, { hideToTray: true });
  } else if (rx.mode === 'screen') {
    const d = displayById(rx.displayId);
    win = newWindow({
      ...d.bounds, transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, backgroundColor: '#00000000', title: 'VTOverlay',
    });
    win.setBounds(d.bounds); // some setups ignore the initial position on secondary monitors
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
  if (rx.mode !== 'window') {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true);
  }
  win.loadURL('app://local/src/overlay.html?' + qs);
  win.on('closed', () => { if (overlayWin === win) overlayWin = null; });

  if (rx.mode === 'floating') setLocked(false); // start in edit mode so they can place it
  if (rx.mode === 'screen') setClickThrough(true);
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
    title: `VTOverlay — ${rx.code}`, backgroundColor: '#14121a', autoHideMenuBar: true,
    resizable: false, maximizable: false, fullscreenable: false,
  }, { hideToTray: true });
  panelWin.loadURL('app://local/src/panel.html');
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
    locked: rx.locked, editingZone: rx.editingZone, sharing: rx.sharing, status: rx.status,
    alwaysOnTop: !!overlayWin && !overlayWin.isDestroyed() && overlayWin.isAlwaysOnTop(),
  };
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('rx-state', state);
  if (panelWin && !panelWin.isDestroyed()) panelWin.setTitle(`VTOverlay — ${rx.code}`);
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
    case 'on-top': overlayWin?.setAlwaysOnTop(!!arg); return pushState();
    case 'reconnect': return overlayWin?.webContents.send('reconnect');
    case 'disconnect': return disconnectReceiver();
    case 'show': return showReceiverWindow();
    case 'quit': return quitApp();
  }
}
ipcMain.on('rx-action', (_e, action, arg) => doAction(action, arg));
ipcMain.on('rx-status', (_e, state, text) => { rx.status = { state, text }; pushState(); });

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
ipcMain.handle('get-work-area', () => workAreaOf(rx.displayId));
ipcMain.on('rx-disconnect', () => disconnectReceiver());

function setClickThrough(on) {
  if (!overlayWin) return;
  overlayWin.setIgnoreMouseEvents(on, { forward: true });
  if (rx.mode === 'screen') {
    overlayWin.setFocusable(!on);
    if (!on) overlayWin.focus();
  }
}

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

ipcMain.on('overlay-set-locked', (_e, locked) => setLocked(!!locked));
ipcMain.on('zone-edit-done', () => setEditingZone(false));
ipcMain.on('set-sharing', (_e, on) => setSharing(!!on));
ipcMain.on('quit', () => quitApp());

// ---------- tray ----------
function trayMenu() {
  const displays = screen.getAllDisplays();
  const items = [
    { label: `Watching room ${rx.code}`, enabled: false },
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
        type: 'radio', label: `Screen ${i + 1} — ${d.size.width}×${d.size.height}`,
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
    { label: 'Reconnect', click: () => doAction('reconnect') },
    { label: 'Disconnect (back to menu)', click: () => doAction('disconnect') },
    { label: 'Quit VTOverlay', click: () => doAction('quit') },
  );
  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setToolTip(`VTOverlay — ${rx.code}${rx.sharing ? ' — sharing screen' : ''}`);
}

function createTray() {
  // PNG (Windows can't draw SVG tray icons — that left the old icon invisible)
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  const hi = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray@2x.png'));
  if (!hi.isEmpty()) icon.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
  if (icon.isEmpty()) icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
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
  // taskbar moved / resized / auto-hide toggled, resolution changed…
  screen.on('display-metrics-changed', () => {
    if (rx.mode === 'screen' && overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('work-area', workAreaOf(rx.displayId));
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!transitioning && !quitting && !APPLYING_UPDATE) app.exit(0); });
