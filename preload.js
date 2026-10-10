const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vt', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  startSender: () => ipcRenderer.invoke('start-sender'),
  startReceiver: (opts) => ipcRenderer.invoke('start-receiver', opts),
  backToMenu: () => ipcRenderer.send('back-to-menu'),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  cancelUpdate: () => ipcRenderer.send('update-cancel'),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setHotkeys: (list) => ipcRenderer.invoke('set-hotkeys', list),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, id) => cb(id)),
  // receiver control window
  rxAction: (action, arg) => ipcRenderer.send('rx-action', action, arg),
  onRxState: (cb) => ipcRenderer.on('rx-state', (_e, st) => cb(st)),
  reportStatus: (state, text) => ipcRenderer.send('rx-status', state, text),
  // clean shutdown: main asks the page to say bye, page confirms
  onAppClosing: (cb) => ipcRenderer.on('app-closing', () => cb()),
  goodbyeSent: () => ipcRenderer.send('goodbye-sent'),
  // receiver
  switchMode: (mode) => ipcRenderer.send('rx-switch-mode', mode),
  getWorkArea: () => ipcRenderer.invoke('get-work-area'),
  onWorkArea: (cb) => ipcRenderer.on('work-area', (_e, w) => cb(w)),
  disconnect: () => ipcRenderer.send('rx-disconnect'),
  onReconnect: (cb) => ipcRenderer.on('reconnect', () => cb()),
  // floating mode
  moveBy: (dx, dy) => ipcRenderer.send('overlay-move-by', dx, dy),
  resizeBy: (factor) => ipcRenderer.send('overlay-resize-by', factor),
  setLocked: (locked) => ipcRenderer.send('overlay-set-locked', locked),
  onLockChanged: (cb) => ipcRenderer.on('lock-changed', (_e, locked) => cb(locked)),
  // screen mode
  onZoneEdit: (cb) => ipcRenderer.on('zone-edit', (_e, on) => cb(on)),
  onZoneReset: (cb) => ipcRenderer.on('zone-reset', () => cb()),
  zoneEditDone: () => ipcRenderer.send('zone-edit-done'),
  setSharing: (on) => ipcRenderer.send('set-sharing', on),
  onShareChanged: (cb) => ipcRenderer.on('share-changed', (_e, on) => cb(on)),
  quit: () => ipcRenderer.send('quit'),
});
