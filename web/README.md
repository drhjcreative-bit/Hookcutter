# Halo — anonymous video web client

A self-contained, ultra-ergonomic **Zoom-style video client** built to run in
**Safari / Chrome on iPad** (installable to the home screen as a PWA). No build
step, no framework, no accounts — just static files you can serve anywhere and
later port to Lovable / Replit.

> Halo is an *emulator/reference client*: your own camera is real (via
> `getUserMedia`), and the other participants are simulated so the full UX —
> grid, spotlight, controls, effects — works end-to-end without a signalling
> server. Drop in a WebRTC/SFU backend later and the same UI drives real calls.

---

## Feature map (from the brief)

| Requested | Where it lives |
|---|---|
| Runs on iPad / Chrome / Safari, app-like | PWA: `manifest.webmanifest` + `sw.js`, safe-area layout |
| Hide participant windows | `participants.js` — per-tile *Hide window* / *Hide self view*, restore pill |
| Delete inbox conversations | `inbox.js` — swipe-to-delete + Edit mode, persisted |
| Auto-rotation video mode | `pipeline.js` (orientation-aware video) + `participants.js` (auto-rotating spotlight) |
| Filters (Photobooth-style) | `filters.js` + real-time `pipeline.js` (thermal, comic, x-ray, glitch, …) |
| Overlays (Snapchat-style) | `overlays.js` — face-anchored stickers + frames |
| Touch-up appearance | `filters.js` `touchup` slider (soften + brighten + saturate) |
| Adjust for low light | `filters.js` `lowlight` slider (shadow lift) |
| Modular windows + in-app browser | `windows.js` — draggable/resizable/minimisable, iframe browser |
| GIF plugin / own GIF bank | `gifbank.js` + `gif-encoder.js` |
| JPEG auto-exports to GIF on upload | `gifbank.js#importImageAsGif` → dependency-free `GifEncoder` |
| Sleek iOS design | `css/*` — tokens, glass tab bar, bottom sheets, haptics |
| Anonymous (anti-spam) | `identity.js` — random handle/avatar, one-tap re-roll |

---

## Run it

ES modules require HTTP (not `file://`). Any static server works:

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000 on the same network from your iPad
```

For camera access on a device you need **HTTPS** (or `localhost`). On Replit /
Lovable / any static host this is automatic. Then in Safari: **Share → Add to
Home Screen** for the full-screen app.

---

## Architecture

Everything is vanilla ES modules — no bundler, each file does one job.

```
index.html            app shell (home / inbox / studio) + call surface + sheet
css/
  base.css            design tokens, reset, typography
  layout.css          app shell, tab bar, lists
  components.css      buttons, hero, studio, sheets, toasts, gif/chat
  call.css            call surface, video grid, controls, floating windows
js/
  app.js              bootstrap + orchestration (views, call, sheets)
  state.js            observable store persisted to localStorage
  identity.js         anonymous identity generator
  media.js            getUserMedia lifecycle (flip / mute / stop)
  pipeline.js         real-time render engine (one rAF loop, shared offscreen)
  filters.js          photobooth filters + adjustment → CSS filter string
  overlays.js         snapchat-style stickers & frames drawn per frame
  participants.js     call grid, hide/show, spotlight, auto-rotate
  inbox.js            conversation list (swipe delete) + chat
  gifbank.js          IndexedDB GIF bank + JPEG→GIF import + live capture
  gif-encoder.js      dependency-free GIF89a encoder (median-cut + LZW)
  windows.js          modular floating windows + in-app browser
  ui.js               toasts, bottom sheet, haptics
sw.js                 offline app-shell cache
manifest.webmanifest  PWA metadata
```

### The render pipeline

`pipeline.js` runs a single `requestAnimationFrame` loop. Each frame it draws
the camera **once** into an offscreen canvas applying the combined CSS filter
(selected look + touch-up + low-light + warmth + vibrance), optional
auto-rotation and mirroring, a post-effect pass for the stylised looks
(posterize/bloom/glitch), and the active overlay. It then blits that single
result into every *visible* target canvas (home preview, studio, call self-tile,
effects sheet). One pass, many views — cheap enough for real-time on iPad.

### The GIF encoder

`gif-encoder.js` is a from-scratch GIF89a encoder — median-cut colour
quantisation to a 256-entry local palette and standard variable-length-code
LZW, with multi-frame + Netscape looping. `importImageAsGif` runs it on every
uploaded image so the bank is always real `.gif` bytes; `captureLiveGif` records
a short animated GIF straight from the processed camera feed.

---

## Porting to a real backend

The UI is backend-agnostic. To make calls real:

1. Replace the simulated peers in `participants.js` with remote `MediaStream`s.
2. Add signalling (WebSocket) + a WebRTC SFU (LiveKit / mediasoup / Daily).
3. Feed the local processed canvas as an outgoing track via
   `canvas.captureStream()` so filters/overlays are seen by others.

Nothing else in the UI needs to change.
