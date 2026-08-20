/* ============================================================
   Halo — zoom.js
   Real-Zoom interop via the official Zoom Meeting SDK
   (component view), wrapped in Halo's OWN chrome: Halo top bar,
   Halo control bar, Halo sheets. Zoom renders the meeting video
   inside the stage; Halo's buttons drive the SDK.

   Requirements (server side): ZOOM_SDK_KEY / ZOOM_SDK_SECRET env
   vars — the Client ID / Client Secret of a Zoom Marketplace
   "Meeting SDK" app. The server exposes:
     GET  /zoom-config     → { enabled, sdkKey }
     POST /zoom-signature  → { signature, sdkKey }
   The secret never reaches the browser; only a short-lived signed
   JWT does, per Zoom's SDK auth model.

   Known limits of Zoom's *web* SDK (not Halo bugs):
   - The remote participant video tiles are rendered BY Zoom inside
     the stage. Zoom does not let third parties re-render other
     people's video in a real meeting, so the tiles themselves are
     Zoom's — everything around them is Halo.
   - Halo filters/overlays do not pipe into Zoom meetings — the SDK
     captures the camera itself and web builds don't accept custom
     video injection. Effects apply in Halo rooms only.
   - Waiting rooms, passcodes, and "authenticated users only"
     meeting settings still apply. Anonymity = your display name.
   ============================================================ */

import { toast, haptic, openSheet, escapeHtml } from './ui.js';

// Zoom retires Meeting SDK versions on a rolling basis, and a pinned version
// that has been withdrawn 404s at the CDN — which would present as a dead
// "Join" button. Rather than bet on one version, try a list newest-first and
// use whichever actually loads. Override with window.HALO_ZOOM_SDK_VERSION.
const SDK_VERSIONS = ['4.0.0', '3.13.2', '3.11.0', '3.9.0', '3.8.10'];

let sdkPromise = null;
let active = null; // { client, host, timer, t0, micMuted, camOn }
let loadedVersion = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error('load failed: ' + src)); };
    document.head.appendChild(el);
  });
}

async function loadSdk(preferred) {
  if (window.ZoomMtgEmbedded) return;
  if (sdkPromise) return sdkPromise;

  const candidates = preferred ? [preferred, ...SDK_VERSIONS.filter(v => v !== preferred)] : SDK_VERSIONS;
  sdkPromise = (async () => {
    const tried = [];
    for (const v of candidates) {
      try {
        await loadScript(`https://source.zoom.us/${v}/zoom-meeting-embedded-${v}.min.js`);
        if (window.ZoomMtgEmbedded) { loadedVersion = v; return; }
        tried.push(`${v} (loaded but no global)`);
      } catch {
        tried.push(v);
      }
    }
    sdkPromise = null;
    throw new Error(`Zoom SDK would not load. Tried: ${tried.join(', ')}. ` +
      'Set window.HALO_ZOOM_SDK_VERSION to a current version from Zoom\'s release notes.');
  })();
  return sdkPromise;
}

export function loadedSdkVersion() { return loadedVersion; }

export async function getZoomConfig() {
  try {
    const r = await fetch('/zoom-config', { cache: 'no-store' });
    return r.ok ? await r.json() : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

/* ---------- defensive SDK access ----------
   The component-view API surface shifts between SDK releases, and this
   build cannot pin one version (see SDK_VERSIONS). Every SDK call goes
   through firstMethod(): try a list of method names, use the first that
   exists. When none exists the caller falls back to revealing Zoom's own
   controls, so no button is ever silently dead. */
function firstMethod(obj, names) {
  for (const n of names) {
    if (obj && typeof obj[n] === 'function') return obj[n].bind(obj);
  }
  return null;
}

function currentUser(client) {
  try {
    const fn = firstMethod(client, ['getCurrentUser', 'getCurrentUserInfo']);
    return fn ? fn() : null;
  } catch { return null; }
}

function attendees(client) {
  try {
    const fn = firstMethod(client, ['getAttendeeslist', 'getAttendeesList', 'getParticipantsList']);
    const list = fn ? fn() : null;
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function isMuted(user) {
  if (!user) return null;
  if (typeof user.muted === 'boolean') return user.muted;
  if (user.audio && typeof user.audio.muted === 'boolean') return user.audio.muted;
  return null;
}

function isVideoOn(user) {
  if (!user) return null;
  if (typeof user.bVideoOn === 'boolean') return user.bVideoOn;
  if (typeof user.isVideoOn === 'boolean') return user.isVideoOn;
  return null;
}

/* ---------- Halo shell ---------- */

function fmtMeeting(meetingNumber) {
  const s = String(meetingNumber);
  // Zoom convention: 3-4-4 for 11-digit IDs, 3-3-4 for 10-digit.
  const m = s.match(/^(\d{3})(\d{3,4})(\d{4})$/);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : s.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function ctrlButton(key, icon, label, extraClass = '') {
  return `<button class="ctrl${extraClass ? ' ' + extraClass : ''}" data-zc="${key}">
    <div class="ctrl-ic">${icon}</div><span class="ctrl-label">${label}</span>
  </button>`;
}

function buildShell(meetingNumber) {
  const host = document.createElement('div');
  host.className = 'zoom-host';
  host.innerHTML = `
    <div class="zoom-topbar">
      <div class="zt-meta">
        <span class="zt-title">Zoom · ${escapeHtml(fmtMeeting(meetingNumber))}</span>
        <span class="call-timer" data-zc="timer">00:00</span>
      </div>
      <div class="call-top-actions">
        <span class="zt-count" data-zc="count" title="Participants"></span>
        <button class="round-btn small" data-zc="leave-x" aria-label="Leave Zoom meeting">✕</button>
      </div>
    </div>
    <div class="zoom-stage"><div class="zoom-root"></div></div>
    <div class="call-controls zoom-controls">
      ${ctrlButton('mic', '🎙️', 'Mute')}
      ${ctrlButton('cam', '📷', 'Video')}
      ${ctrlButton('people', '👥', 'People')}
      ${ctrlButton('native', '🎛', 'Zoom UI')}
      ${ctrlButton('leave', '📞', 'Leave', 'danger')}
    </div>`;
  return host;
}

function $z(sel) { return active ? active.host.querySelector(sel) : null; }

/** Zoom's own chrome is hidden by default (Halo drives the meeting). If an
    SDK build lacks an API Halo needs, we reveal Zoom's controls instead of
    leaving a dead button. */
function revealNative(reason) {
  if (!active) return;
  if (!active.host.classList.contains('show-native')) {
    active.host.classList.add('show-native');
    const btn = $z('[data-zc="native"]');
    if (btn) btn.classList.add('active');
  }
  if (reason) toast(reason, 4500);
}

function paintControls() {
  if (!active) return;
  const me = currentUser(active.client);
  const muted = isMuted(me);
  if (muted !== null) active.micMuted = muted;
  const vid = isVideoOn(me);
  if (vid !== null) active.camOn = vid;

  const mic = $z('[data-zc="mic"]');
  if (mic) {
    mic.classList.toggle('off', !!active.micMuted);
    mic.querySelector('.ctrl-label').textContent = active.micMuted ? 'Unmute' : 'Mute';
  }
  const cam = $z('[data-zc="cam"]');
  if (cam) {
    cam.classList.toggle('off', !active.camOn);
    cam.querySelector('.ctrl-label').textContent = active.camOn ? 'Video' : 'Start';
  }
  const count = $z('[data-zc="count"]');
  if (count) {
    const n = attendees(active.client).length;
    count.textContent = n > 0 ? `${n} 👥` : '';
  }
}

async function zoomToggleMic() {
  if (!active) return;
  haptic();
  const target = !active.micMuted;
  const fn = firstMethod(active.client, ['mute', 'muteAudio']);
  if (!fn) { revealNative("This Zoom SDK build has no mute API — use Zoom's controls"); return; }
  try {
    await fn(target);
    active.micMuted = target;
    toast(target ? 'Muted' : 'Unmuted');
  } catch (e) {
    toast('Zoom: could not change mute' + (e && e.reason ? ` — ${e.reason}` : ''), 4000);
  }
  paintControls();
}

async function zoomToggleVideo() {
  if (!active) return;
  haptic();
  const wantOn = !active.camOn;
  const fn = wantOn
    ? firstMethod(active.client, ['startVideo', 'startVideoCapture', 'unmuteVideo'])
    : firstMethod(active.client, ['stopVideo', 'stopVideoCapture', 'muteVideo']);
  if (!fn) { revealNative("This Zoom SDK build has no video API — use Zoom's controls"); return; }
  try {
    await fn();
    active.camOn = wantOn;
  } catch (e) {
    toast('Zoom: could not change video' + (e && e.reason ? ` — ${e.reason}` : ''), 4000);
  }
  paintControls();
}

function zoomPeopleSheet() {
  if (!active) return;
  const list = attendees(active.client);
  const wrap = document.createElement('div');
  if (!list.length) {
    wrap.innerHTML = '<p style="color:var(--text-faint);text-align:center;padding:24px">Participant list unavailable in this Zoom SDK build.</p>';
  } else {
    const me = currentUser(active.client);
    list.forEach(p => {
      const self = me && p.userId === me.userId;
      const bits = [];
      if (isMuted(p)) bits.push('Muted');
      if (isVideoOn(p) === false) bits.push('Camera off');
      if (p.isHost) bits.push('Host');
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="avatar grad">${self ? '🫵' : '👤'}</div>
        <div class="row-main">
          <div class="row-title">${self ? 'You' : escapeHtml(p.displayName || 'Guest')}</div>
          <div class="row-sub">${bits.join(' · ') || 'Active'}</div>
        </div>`;
      wrap.appendChild(row);
    });
  }
  openSheet(`People · ${list.length || '?'}`, wrap);
}

function toggleNativeUi() {
  if (!active) return;
  haptic();
  const shown = active.host.classList.toggle('show-native');
  const btn = $z('[data-zc="native"]');
  if (btn) btn.classList.toggle('active', shown);
  toast(shown ? "Zoom's own controls shown" : "Zoom's own controls hidden");
}

function wireShell(host) {
  host.querySelector('[data-zc="mic"]').addEventListener('click', zoomToggleMic);
  host.querySelector('[data-zc="cam"]').addEventListener('click', zoomToggleVideo);
  host.querySelector('[data-zc="people"]').addEventListener('click', zoomPeopleSheet);
  host.querySelector('[data-zc="native"]').addEventListener('click', toggleNativeUi);
  host.querySelector('[data-zc="leave"]').addEventListener('click', leaveZoom);
  host.querySelector('[data-zc="leave-x"]').addEventListener('click', leaveZoom);
}

function startShellLoop() {
  if (!active) return;
  active.t0 = Date.now();
  active.timer = setInterval(() => {
    if (!active) return;
    const el = $z('[data-zc="timer"]');
    if (el) {
      const s = Math.floor((Date.now() - active.t0) / 1000);
      el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
    // Also refresh mic/cam state — catches changes made through Zoom's own
    // UI (when revealed) or by the host force-muting everyone.
    paintControls();
  }, 1000);
}

function wireSdkEvents(client) {
  const on = firstMethod(client, ['on']);
  if (!on) return;
  // createClient() is a singleton in real SDK builds, so every listener we
  // register must be unregistered on leave or handlers stack across rejoins.
  const safe = (ev, cb) => {
    try { on(ev, cb); if (active) active.listeners.push([ev, cb]); }
    catch { /* event not in this build */ }
  };
  safe('connection-change', (p) => {
    const state = p && (p.state || p.status);
    if (state === 'Closed' || state === 'Fail' || state === 'Ended') {
      toast('Zoom meeting ended');
      leaveZoom();
    }
  });
  safe('user-added', paintControls);
  safe('user-removed', paintControls);
  safe('user-updated', paintControls);
}

export function leaveZoom() {
  if (!active) return;
  const { client, host, timer, listeners, onResize } = active;
  active = null;
  clearInterval(timer);
  if (onResize) {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
  }
  // createClient() returns a singleton in real SDK builds, so listeners must
  // be detached and the client destroyed here — otherwise the next join
  // stacks duplicate handlers and init() can refuse to run again.
  const off = firstMethod(client, ['off']);
  if (off) for (const [ev, cb] of listeners) { try { off(ev, cb); } catch (_) {} }
  let left;
  try {
    if (typeof client.leaveMeeting === 'function') left = client.leaveMeeting();
    else if (typeof client.leave === 'function') left = client.leave();
  } catch (_) {}
  Promise.resolve(left).catch(() => {}).then(() => {
    try {
      if (window.ZoomMtgEmbedded && typeof window.ZoomMtgEmbedded.destroyClient === 'function') {
        window.ZoomMtgEmbedded.destroyClient();
      }
    } catch (_) {}
  });
  host.remove();
}

/**
 * Join a real Zoom meeting inside Halo's own chrome. Throws
 * 'zoom-not-configured' if the server has no SDK keys, or rethrows the
 * SDK's join error (bad passcode, invalid signature, not started, …).
 */
export async function joinZoomMeeting({ meetingNumber, passcode = '', userName = 'Guest' }) {
  if (active) leaveZoom(); // never stack two shells / two SDK sessions

  const cfg = await getZoomConfig();
  if (!cfg.enabled) throw new Error('zoom-not-configured');

  await loadSdk(window.HALO_ZOOM_SDK_VERSION || cfg.sdkVersion || null);

  const res = await fetch('/zoom-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingNumber, role: 0 }),
  });
  if (!res.ok) throw new Error(`signature-failed (${res.status})`);
  const { signature, sdkKey } = await res.json();

  const host = buildShell(meetingNumber);
  document.body.appendChild(host);
  const root = host.querySelector('.zoom-root');
  wireShell(host);

  const client = window.ZoomMtgEmbedded.createClient();
  active = { client, host, timer: null, t0: 0, micMuted: false, camOn: false, listeners: [], onResize: null };

  // Size Zoom's video panel to fill the Halo stage.
  const stageSize = () => {
    const r = root.getBoundingClientRect();
    return { width: Math.max(320, Math.floor(r.width)), height: Math.max(240, Math.floor(r.height)) };
  };
  const { width: vw, height: vh } = stageSize();

  try {
    await client.init({
      zoomAppRoot: root,
      language: 'en-US',
      patchJsMedia: true,
      customize: {
        video: {
          isResizable: false,
          popper: { disableDraggable: true },
          defaultViewType: 'gallery',
          viewSizes: { default: { width: vw, height: vh }, ribbon: { width: vw, height: vh } },
        },
        meetingInfo: ['topic', 'host', 'participant'],
      },
    });
    await client.join({
      sdkKey,
      signature,
      meetingNumber: String(meetingNumber),
      password: passcode,
      userName,
    });
  } catch (err) {
    leaveZoom();
    // Zoom rejects with {type, reason, errorCode}; keep those so the UI can
    // show what actually went wrong instead of a generic failure.
    const detail = err && (err.reason || err.message) ? (err.reason || err.message) : 'unknown error';
    const code = err && err.errorCode ? ` [${err.errorCode}]` : '';
    const wrapped = new Error(`${detail}${code}`);
    wrapped.errorCode = err && err.errorCode;
    wrapped.raw = err;
    throw wrapped;
  }

  wireSdkEvents(client);
  startShellLoop();
  paintControls();

  // Keep Zoom's video panel matched to the stage across rotation/resize
  // (viewSizes is only read at init; updateVideoOptions re-renders it).
  let resizeT = 0;
  const onResize = () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!active || active.client !== client) return;
      const fn = firstMethod(client, ['updateVideoOptions']);
      if (!fn) return;
      const size = stageSize();
      try { fn({ viewSizes: { default: size, ribbon: size } }); } catch (_) {}
    }, 250);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  active.onResize = onResize;

  return { leave: leaveZoom };
}
