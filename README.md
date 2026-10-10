# VTOverlay

Put your VTuber avatar on a friend's desktop, live.

You run **VTOverlay** with your webcam; your friend runs **VTOverlay Viewer** with your room code, and your VRM avatar appears on their screen, moving with your head, eyes, mouth, expressions, and (optionally) arms and fingers. It can float as a small see-through widget, sit in a normal window, or roam a whole monitor where *you* place it.

Peer-to-peer, no account, no server of your own needed. Your webcam image never leaves your PC.

---

## Download

Grab the latest version from **[Releases](https://github.com/Kiriuno/VTOverlay/releases/latest)**:

| File | For |
|---|---|
| `VTOverlay-win32-x64.zip` | the broadcaster (can also view) |
| `VTOverlay-Viewer-win32-x64.zip` | friends who only watch (smaller, no webcam code) |

1. Unzip it into a folder you own, such as `Documents\VTOverlay` or your Desktop. Avoid `Program Files`, because the app needs to be able to update itself there.
2. Run `VTOverlay.exe` / `VTOverlay-Viewer.exe`.
3. Windows SmartScreen may warn the first time because the app isn't code-signed. Click **More info → Run anyway**.

**Updates:** each time you launch the app it checks this repo's latest release. If there's a newer one, the start screen shows *Update available*; click **Update now** and the app downloads it, replaces itself and restarts (**Cancel** stops a download in progress). **Check for updates** is at the bottom of the start screen.

---

## Broadcasting (you)

1. **Start broadcasting** and load your `.vrm` (button or drag & drop). Free models can be made in [VRoid Studio](https://vroid.com/en/studio).
2. Look at the screen with a relaxed face and press **Calibrate**.
3. Send your friend the 6-character **room code** (**Copy** button). It stays the same between launches.
4. Frame the shot in your preview. Viewers see exactly this framing:
   - scroll to zoom
   - middle-drag to move the avatar
   - right-drag to rotate it
   - **Framing: Bust / Full body** and **Reset view** buttons

| | |
|---|---|
| **Pause tracking** | Turns the camera off when you step away. Viewers see your avatar idling (breathing, blinking). Can have a hotkey. |
| **Movement** | The body follows your head up/down, left/right and forward/back. Each direction has its own sensitivity slider. |
| **Smoothing** | Less jitter vs. more responsiveness. **Link both eyes** stops accidental winks. |
| **Expressions** | Every expression your model has gets a button; click to toggle. **Right-click** an expression (or *neutral*) to give it a hotkey (Alt+H, Ctrl+Alt+1, F9…); hotkeys work from any app. There are no default hotkeys, only the ones you set. While an expression is on, you can tune its **mouth movement** and **blinking**, so a closed-eye smile doesn't blink, for example. **Auto expressions** reads happy / sad / surprised / angry from your face. |
| **Props** | Add PNG / JPG / GIF / WebP images (animated ones play). Each prop either stays in the scene or is attached to a body part and moves with it. Drag it in the preview, scroll on it to resize, Shift+scroll to rotate. It can also face the camera, be mirrored, get a hotkey to show/hide it, and more. |
| **Arms & hands** *(beta)* | Follows your arms and fingers when they're in the camera view. |
| **Place on viewer's screen** | For friends in Full screen mode: drag your avatar around their monitor and resize it. They can share that screen with you so you see where you're putting it. |

## Watching (your friend)

Type the code, choose how to show the avatar, then **Join**:

- **Floating**: a small see-through widget. Drag it, scroll to resize, **Ctrl+Alt+V** to lock it (click-through).
- **Window**: a normal window.
- **Full screen**: a click-through layer over a monitor. The broadcaster places the avatar. **Ctrl+Alt+V** opens the zone editor, which limits the avatar to part of the screen.

The **control window** (floating and full screen modes) has every action:
- switch mode or monitor
- edit the zone
- share the screen with the broadcaster (off by default)
- reconnect, disconnect, quit

Its ✕ hides it to the tray (the ^ next to the clock). Click the tray icon to bring it back. **Quit** closes the app.

## Privacy

- **Webcam:** the image never leaves the broadcaster's PC. Viewers only receive numbers: head rotation and position, 52 face-shape weights, expression name, and arm/finger directions if enabled.
- **Model and props:** sent directly to viewers (peer-to-peer) and cached there. Their file names are never sent.
- **Screen sharing:** only happens if the viewer turns it on, and a "Sharing this screen" tag stays visible while it runs.

## Troubleshooting

- **Viewer stuck on "Room isn't online":** check the code. The broadcaster must have **Start broadcasting** open.
- **Can't connect at all:** some networks block direct connections (phone hotspots, campus or work Wi-Fi, CGNAT). Those need a TURN relay; see *Advanced* below.
- **Wrong eye winks:** toggle **Swap left/right eyes & mouth**.
- **Hotkey shows red:** another app already uses that combination; pick another.
- **An update failed:** the details are in `%TEMP%\vtoverlay-update.log`. The usual cause is the app folder being in a protected place like `Program Files`.

---

## Building from source

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start                # run from source (broadcast + view)
npm run start-viewer     # run as the viewer-only app
npm run package-all      # build dist/VTOverlay-win32-x64 and dist/VTOverlay-Viewer-win32-x64
npm run release-zips     # same, plus the two zips a GitHub release needs
```

## Publishing a release (maintainer)

Releases are built by GitHub Actions (`.github/workflows/release.yml`) whenever a version tag is pushed:

```bash
# 1. bump "version" in package.json, e.g. 0.6.1, then:
git commit -am "v0.6.1"
git tag v0.6.1
git push && git push --tags
```

About 5 minutes later the release appears with both zips attached, and every installed copy offers the update. The workflow refuses to publish if the tag and `package.json` disagree. The repo must be **public**, because the apps read the latest release without logging in.

## How it works

```
 Webcam ─▶ MediaPipe (face, + pose & hands) ─▶ head pose, 52 blendshapes, arm directions ─┐
                                                                                         │  WebRTC (PeerJS), peer-to-peer
                        motion: unreliable channel, ~30 Hz, numbered, never queued        │  control/model/props: reliable channel
                                                                                         ▼
 Viewer: Electron window (transparent / normal) ─▶ three.js + three-vrm ─▶ your avatar + props
```

- **Tracking:**
  - MediaPipe FaceLandmarker gives the blendshapes and head transform. PoseLandmarker and HandLandmarker are added when arm tracking is on.
  - A One-Euro filter smooths the head and face.
  - Calibration records your resting face as zero.
- **Avatar:** VRM 0.x and 1.0 via `@pixiv/three-vrm`. "Perfect sync" (ARKit-named) models get all 52 shapes; others are mapped to the VRM presets.
- **Network:** the public PeerJS server is only used to find each other. Everything else goes directly between the PCs.
- **Updates:** `updater.js` reads `api.github.com/repos/Kiriuno/VTOverlay/releases/latest`, downloads the build's zip, and the new exe copies itself over the old folder.

**Files:**
- `main.js`: windows, modes, tray, hotkeys, updates
- `updater.js`: self-update
- `src/sender.*`: broadcaster
- `src/overlay.*`: viewer
- `src/panel.html`: viewer control window
- `src/launcher.html`: start screen
- `src/shared/`:
  - `avatar.js`: VRM animation
  - `props.js`
  - `arms.js`
  - `filters.js`
  - `protocol.js`: the message format, documented

### Advanced

- **Your own signalling server:** run `npx peer --port 9000` somewhere and set `host` / `port` / `path` in `peerOptions()` in `src/shared/protocol.js`.
- **TURN relay** for strict networks: add it to `iceServers` in the same function.

## License

[MIT](LICENSE)
