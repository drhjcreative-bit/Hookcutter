# Halo — anonymous video web client

A self-contained, ultra-ergonomic **Zoom-style video client** built to run in
**Safari / Chrome on iPad** (installable to the home screen as a PWA). No build
step, no framework, no accounts — just static files you can serve anywhere and
later port to Lovable / Replit.

> Halo runs in **two modes automatically**:
> - **Real calls** when served by `server/` (or any host running it): a
>   WebSocket signalling relay connects participants into a **WebRTC mesh** —
>   real peer-to-peer audio/video, and peers see your *filtered* canvas because
>   the outgoing track is the processed studio output.
> - **Demo mode** when opened as static files with no backend reachable: your
>   own camera is real and the other participants are simulated, so the full UX
>   still works offline.
>
> The client picks the mode on its own: it tries the signalling server, and
> falls back to simulated peers if none answers within a couple of seconds.

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

## Backend (real calls)

`server/server.js` is a single Node process that:

1. Serves the static `web/` client.
2. Hosts a WebSocket signalling relay at `/rtc` that connects participants into
   a **WebRTC mesh**. Media never touches the server — it only relays SDP/ICE;
   audio and video flow peer-to-peer.

Run it:

```bash
cd server && npm install && npm start   # serves the app + signalling on :3000
```

Then open `http://localhost:3000` (camera needs HTTPS in production — automatic
on Replit / Render / Fly). Two people entering the **same meeting code** land in
the same room and connect directly.

- **Topology:** mesh (each client dials every other). Great for small anonymous
  rooms; for large calls swap the relay for an SFU (LiveKit / mediasoup) — the
  client's `rtc.js` is the only file that changes.
- **NAT traversal:** public STUN by default (`config.js`). Add a TURN server
  there for restrictive networks.
- **Outgoing video** is the processed canvas (`pipeline.getBroadcastStream()`),
  so remote peers see your filters and overlays, plus your mic track.
- **Signalling URL** defaults to the serving origin; override with
  `window.HALO_SIGNAL_URL` or `?signal=wss://…`.

Client files added for the backend: `js/config.js` (endpoints/ICE) and
`js/rtc.js` (mesh client).

## Joining REAL Zoom meetings (optional)

Halo's own rooms only connect people using *this app*. To join **actual Zoom
meetings** (rooms full of people on regular Zoom), Halo integrates the official
**Zoom Meeting SDK** — Zoom's supported way to build a custom client. It needs
your own Zoom credentials:

1. Go to <https://marketplace.zoom.us> → **Develop → Build App** → create a
   **General app** with the **Meeting SDK** feature enabled (free).
2. Copy its **Client ID** and **Client Secret**.
3. Set them as environment variables where the server runs (on Replit:
   *Tools → Secrets*):
   - `ZOOM_SDK_KEY` = Client ID
   - `ZOOM_SDK_SECRET` = Client Secret
4. Restart the server. The **Join** sheet now shows a *Zoom meeting* tab —
   enter the meeting ID + passcode and a display name of your choosing.

How it works: the browser asks `POST /zoom-signature` for a short-lived HS256
JWT signed server-side (`server.js#zoomSignature`) — the secret never leaves
the server — then loads Zoom's Meeting SDK (component view) and joins.

Honest limits (Zoom's web SDK, not Halo):
- Halo **filters/overlays don't pipe into Zoom meetings** — Zoom's SDK captures
  the camera itself and the web build doesn't accept injected video. Effects
  apply in Halo rooms only.
- Waiting rooms, passcodes, and "authenticated users only" meeting settings
  still apply; hosts see whoever joins. Anonymity here means your display name.
- Zoom retires Meeting SDK versions on a rolling basis. `js/zoom.js` therefore
  tries `SDK_VERSIONS` newest-first and uses whichever actually loads, so one
  withdrawn version no longer produces a dead Join button. If every candidate
  is gone, the error names each version tried; set
  `window.HALO_ZOOM_SDK_VERSION` to a current one from Zoom's release notes
  (or add it to `SDK_VERSIONS`).

### "The room is empty / full of strangers I don't know"

Two different things used to look identical, which was the app's fault:

- **Halo rooms only connect people using this app** with the *same code*. A
  Zoom meeting ID typed into the *Halo room* tab just creates an empty Halo
  room named after those digits. The Join sheet now detects a 9–11 digit ID and
  asks which you meant.
- **Simulated participants are now opt-in only** (`?demo=1`). They used to
  appear automatically whenever the signalling connection failed, which made a
  broken call look like a working one. A call now always states the truth:
  *Connecting…*, *You're the only one here* (with a **Copy invite** button), or
  a red *Can't reach the meeting server* with a Retry.

Invite links: the in-call **Copy invite** button produces
`https://your-host/?room=CODE`, and opening that link joins the room directly.

### Troubleshooting the Zoom tab

**"I added the keys but the Zoom tab never appears."** Open `/health` on your
deployed URL (e.g. `https://your-repl.replit.dev/health`). It reports whether
the server actually sees the credentials, without printing them:

```json
{ "zoom": { "configured": true, "sdkKeyLength": 21, "sdkSecretLength": 32,
            "likelySwapped": false } }
```

- `configured: false` → the env vars aren't reaching the process. Re-check the
  names (`ZOOM_SDK_KEY`, `ZOOM_SDK_SECRET`) and **restart** the server; the
  startup log also prints whether Zoom interop is enabled.
- `likelySwapped: true` → the Client ID and Client Secret are the wrong way
  round. Zoom Client IDs are ~22 chars, Client Secrets are 32.
- `configured: true` but still no tab → a stale service worker is serving an old
  capability response. Versions before `halo-v3` cached `/zoom-config`; the
  current worker never caches it. Hard-reload once (iOS Safari: close the tab,
  or Settings → Safari → Clear History) to pick up the new worker.

Join failures now surface Zoom's own error text and code in the toast (and the
full object in the browser console), e.g. *"Signature is invalid [3712]"* —
that's a key/secret mismatch — or a version error, which means bumping
`DEFAULT_VERSION` in `js/zoom.js`.
