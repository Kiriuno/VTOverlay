// npm run dev, start a broadcaster and a viewer from this source folder, already linked.
//
// Both use "dev rooms" (a different room-name prefix), so they can't see or be seen by the released
// apps, and their own settings folders (…-dev-broadcast / …-dev-viewer), so your normal settings stay
// untouched. Options:  npm run dev -- --mode=floating|window|screen   (viewer mode, default window)
//                      npm run dev -- --code=ABC123                     (fixed room code)
//                      npm run dev -- --only=broadcast|viewer           (just one of them)
//                      npm run dev -- --cohosts=2                       (also start co-hosts, 1 to 4, that join
//                                                                        the broadcaster's room with their own
//                                                                        avatar; each remembers its own model)
//                      npm run dev -- --viewers=0                       (no viewer)
//                      npm run dev -- --obs                             (broadcaster "OBS only": camera output
//                                                                        only, no viewer; add --cohosts=N for co-hosts)
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
const cohosts = Math.max(0, Math.min(4, Number(arg('cohosts', '0')) || 0));
const obs = process.argv.includes('--obs');
const viewers = Number(arg('viewers', obs ? '0' : '1')) === 0 ? 0 : 1;
const root = path.join(__dirname, '..');

console.log(`\n  VTOverlay dev, room ${code} (dev rooms only) · viewer mode: ${mode}${cohosts ? ` · ${cohosts} co-host${cohosts > 1 ? 's' : ''}` : ''}\n`);
const kids = [];
const roles = ['broadcast', ...Array.from({ length: cohosts }, (_, i) => 'cohost' + (i + 1)), ...(viewers ? ['viewer'] : [])];
for (const role of roles) {
  if (only && only !== role) continue;
  const extra = (process.env.VT_ELECTRON_ARGS || '').split(' ').filter(Boolean); // e.g. GPU flags
  const args = [...extra, '.', '--vt-dev', `--vt-dev-role=${role}`, `--vt-dev-code=${code}`, `--vt-dev-mode=${mode}`, `--vt-dev-cohosts=${cohosts}`, ...(obs ? ['--vt-dev-obs'] : [])];
  const child = spawn(electron, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${role}]`.padEnd(11);
  const pipe = (stream, out) => stream.on('data', (d) => String(d).split('\n').filter((l) => l.trim() && !/dbus|Fontconfig|libva|GPU process|gpu_/.test(l)).forEach((l) => out.write(`${tag} ${l}\n`)));
  pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
  child.on('exit', (c) => { console.log(`${tag} exited (${c ?? 'signal'})`); if (kids.every((k) => k.exitCode !== null || k.signalCode)) process.exit(0); });
  kids.push(child);
}
const stopAll = () => { for (const k of kids) try { k.kill(); } catch {} process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
