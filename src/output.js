// Camera output: a clean picture of the broadcaster's avatar (no UI) on a solid "green screen"
// background, for OBS (Window Capture → Chroma Key → Start Virtual Camera → usable in Discord, etc.).
// Everything comes from the broadcaster window on this same computer, over a BroadcastChannel.
// In a room with several avatars, they all stand in one row, centred (like viewers see them).
import { AvatarStage } from './shared/avatar.js';
import { Room, rowLayout } from './shared/room.js';

const params = new URLSearchParams(location.search);
document.documentElement.style.setProperty('--bg', params.get('bg') || '#00b140');
const canvas = document.getElementById('stage');
const stage = new AvatarStage(canvas, { maxPixelRatio: 1, maxFps: 60 });
window.vtStage = stage;
stage.fx.muted = true; // the broadcaster window already plays the boop sound
const ch = new BroadcastChannel('vt-output');
const imgs = new Map(); // prop image hash → Blob
const waiting = new Map(); // hash → [resolve]
const loadImg = (hash) => imgs.has(hash) ? Promise.resolve(imgs.get(hash)) : new Promise((resolve) => {
  waiting.set(hash, [...(waiting.get(hash) || []), resolve]);
  ch.postMessage({ t: 'need-prop', hash });
});
stage.props.setLoader(loadImg);

// the other avatars of a room ('h' = the host is the main stage above)
const room = new Room({
  main: stage,
  container: document.getElementById('members'),
  stageOptions: () => ({ maxPixelRatio: 1, maxFps: 60 }),
  propLoader: loadImg,
  skip: ['h'],
  send: (msg) => ch.postMessage(msg), // need-model: asks the broadcaster window again
  onLoaded: () => { document.getElementById('wait').hidden = true; },
});
room.onChange = layout;
room.startDepth({ main: canvas, base: 1 }); // bigger avatars further back
window.vtRoom = room;
function layout() {
  const W = innerWidth, H = innerHeight;
  if (room.order.length <= 1) { stage.setViewport(null); return; }
  const L = rowLayout(room.order, W, H, 'group', stage.view.roll);
  stage.setViewport(L.h || null);
  for (const [id, s] of room.slots) {
    s.stage.fx.muted = true;
    if (L[id]) s.stage.setViewport(L[id]);
  }
}
addEventListener('resize', layout);

let modelId = null;
ch.onmessage = async ({ data: d }) => {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'm': if (d.m) room.motion(d.m, d); else stage.setMotion(d); return;
    case 'members': room.setMembers(d); return;
    case 'mm': room.handle(d.m, d.d); return;
    case 'view': stage.setView(d); room.setView(d); layout(); return;
    case 'style': stage.setStyle(d); room.setHostLight(d.light); return;
    case 'props': if (Array.isArray(d.list)) stage.props.sync(d.list); return;
    case 'prop-img':
      imgs.set(d.hash, d.blob);
      for (const r of waiting.get(d.hash) || []) r(d.blob);
      waiting.delete(d.hash);
      return;
    case 'model':
      if (d.id === modelId) return;
      modelId = d.id;
      await stage.loadVRM(d.buf, d.id);
      document.getElementById('wait').hidden = true;
      return;
    case 'grab': stage.setGrab('o' + d.k, d.j, d.p, true); return;
    case 'fx': if (d.k === 'pat') stage.fx.patting(+d.r); else if (d.k === 'boop') stage.fx.boop(); else if (d.k === 'slap') stage.fx.slap(d.d); return;
  }
};
ch.postMessage({ t: 'hello' }); // the broadcaster answers with the model, view, look and props
