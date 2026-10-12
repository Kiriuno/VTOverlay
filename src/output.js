// Camera output: a clean picture of the broadcaster's avatar (no UI) on a solid "green screen"
// background, for OBS (Window Capture → Chroma Key → Start Virtual Camera → usable in Discord, etc.).
// Everything comes from the broadcaster window on this same computer, over a BroadcastChannel.
import { AvatarStage } from './shared/avatar.js';

const params = new URLSearchParams(location.search);
document.documentElement.style.setProperty('--bg', params.get('bg') || '#00b140');
const stage = new AvatarStage(document.getElementById('stage'), { maxPixelRatio: 1 });
window.vtStage = stage;
stage.fx.muted = true; // the broadcaster window already plays the boop sound
const ch = new BroadcastChannel('vt-output');
const imgs = new Map(); // prop image hash → Blob
const waiting = new Map(); // hash → [resolve]
stage.props.setLoader((hash) => imgs.has(hash) ? Promise.resolve(imgs.get(hash)) : new Promise((resolve) => {
  waiting.set(hash, [...(waiting.get(hash) || []), resolve]);
  ch.postMessage({ t: 'need-prop', hash });
}));

let modelId = null;
ch.onmessage = async ({ data: d }) => {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'm': stage.setMotion(d); return;
    case 'view': stage.setView(d); return;
    case 'style': stage.setStyle(d); return;
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
    case 'fx': if (d.k === 'pat') stage.fx.patting(+d.r); else if (d.k === 'boop') stage.fx.boop(); return;
  }
};
ch.postMessage({ t: 'hello' }); // the broadcaster answers with the model, view, look and props
