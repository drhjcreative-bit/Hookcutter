/* ============================================================
   Halo — zoom.js
   Real-Zoom interop via the official Zoom Meeting SDK
   (component view). Halo's own rooms are pure WebRTC; this module
   is the bridge into ACTUAL Zoom meetings.

   Requirements (server side): ZOOM_SDK_KEY / ZOOM_SDK_SECRET env
   vars — the Client ID / Client Secret of a Zoom Marketplace
   "Meeting SDK" app. The server exposes:
     GET  /zoom-config     → { enabled, sdkKey }
     POST /zoom-signature  → { signature, sdkKey }
   The secret never reaches the browser; only a short-lived signed
   JWT does, per Zoom's SDK auth model.

   Known limits of Zoom's *web* SDK (not Halo bugs):
   - Halo filters/overlays do not pipe into Zoom meetings — the SDK
     captures the camera itself and web builds don't accept custom
     video injection. Effects apply in Halo rooms only.
   - Waiting rooms, passcodes, and "authenticated users only"
     meeting settings still apply. Anonymity = your display name.
   ============================================================ */

const DEFAULT_VERSION = '3.8.10';

let sdkPromise = null;
let active = null; // { client, host }

function loadSdk(version) {
  if (window.ZoomMtgEmbedded) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://source.zoom.us/${version}/zoom-meeting-embedded-${version}.min.js`;
      s.onload = () => resolve();
      s.onerror = () => { sdkPromise = null; reject(new Error('Zoom SDK failed to load')); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

export async function getZoomConfig() {
  try {
    const r = await fetch('/zoom-config', { cache: 'no-store' });
    return r.ok ? await r.json() : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function leaveZoom() {
  if (!active) return;
  const { client, host } = active;
  active = null;
  try {
    if (typeof client.leaveMeeting === 'function') client.leaveMeeting();
    else if (typeof client.leave === 'function') client.leave();
  } catch (_) {}
  host.remove();
}

/**
 * Join a real Zoom meeting. Throws 'zoom-not-configured' if the server
 * has no SDK keys, or rethrows the SDK's join error (bad passcode,
 * invalid signature, meeting not started, …).
 */
export async function joinZoomMeeting({ meetingNumber, passcode = '', userName = 'Guest' }) {
  const cfg = await getZoomConfig();
  if (!cfg.enabled) throw new Error('zoom-not-configured');

  const version = window.HALO_ZOOM_SDK_VERSION || cfg.sdkVersion || DEFAULT_VERSION;
  await loadSdk(version);

  const res = await fetch('/zoom-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingNumber, role: 0 }),
  });
  if (!res.ok) throw new Error(`signature-failed (${res.status})`);
  const { signature, sdkKey } = await res.json();

  // Full-screen host with a Halo top bar so you can always get out.
  const host = document.createElement('div');
  host.className = 'zoom-host';
  const topbar = document.createElement('div');
  topbar.className = 'zoom-topbar';
  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'round-btn small';
  leaveBtn.textContent = '✕';
  leaveBtn.setAttribute('aria-label', 'Leave Zoom meeting');
  const title = document.createElement('span');
  title.textContent = `Zoom · ${String(meetingNumber).replace(/(\d{3})(?=\d)/g, '$1 ')}`;
  topbar.append(leaveBtn, title);
  const root = document.createElement('div');
  root.className = 'zoom-root';
  host.append(topbar, root);
  document.body.appendChild(host);
  leaveBtn.addEventListener('click', leaveZoom);

  const client = window.ZoomMtgEmbedded.createClient();
  active = { client, host };

  try {
    await client.init({ zoomAppRoot: root, language: 'en-US', patchJsMedia: true });
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

  return { leave: leaveZoom };
}
