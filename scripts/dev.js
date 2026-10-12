// npm run dev, start a broadcaster and a viewer from this source folder, already linked.
//
// Both use "dev rooms" (a different room-name prefix), so they can't see or be seen by the released
// apps, and their own settings folders (…-dev-broadcast / …-dev-viewer), so your normal settings stay
// untouched. Options:  npm run dev -- --mode=floating|window|screen   (viewer mode, default window)
//                      npm run dev -- --code=ABC123                     (fixed room code)
//                      npm run dev -- --only=broadcast|viewer           (just one of them)
// Set VT_PEER_SERVER='{"host":"localhost","port":9000,"path":"/","secure":false}' to use your own
// signalling server (e.g. `npx peer --port 9000`) instead of the public one.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // the path to the Electron binary when required from Node

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = arg('code', Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')).toUpperCase();
const mode = arg('mode', 'window');
const only = arg('only', '');
const root = path.join(__dirname, '..');

console.log(`\n  VTOverlay dev, room ${code} (dev rooms only) · viewer mode: ${mode}\n`);
const kids = [];
for (const role of ['broadcast', 'viewer']) {
  if (only && only !== role) continue;
  const extra = (process.env.VT_ELECTRON_ARGS || '').split(' ').filter(Boolean); // e.g. GPU flags
  const args = [...extra, '.', '--vt-dev', `--vt-dev-role=${role}`, `--vt-dev-code=${code}`, `--vt-dev-mode=${mode}`];
  const child = spawn(electron, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = role === 'broadcast' ? '[broadcast]' : '[viewer]   ';
  const pipe = (stream, out) => stream.on('data', (d) => String(d).split('\n').filter((l) => l.trim() && !/dbus|Fontconfig|libva|GPU process|gpu_/.test(l)).forEach((l) => out.write(`${tag} ${l}\n`)));
  pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
  child.on('exit', (c) => { console.log(`${tag} exited (${c ?? 'signal'})`); if (kids.every((k) => k.exitCode !== null || k.signalCode)) process.exit(0); });
  kids.push(child);
}
const stopAll = () => { for (const k of kids) try { k.kill(); } catch {} process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
