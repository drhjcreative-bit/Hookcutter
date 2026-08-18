/* ============================================================
   Halo — config.js
   Runtime configuration. The signalling URL defaults to the same
   origin that served the app (so it "just works" on Replit / any
   host running server/server.js). Override by setting
   window.HALO_SIGNAL_URL before the app loads, or ?signal= in the
   URL for quick testing.
   ============================================================ */

function deriveSignalUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('signal')) return params.get('signal');
  if (window.HALO_SIGNAL_URL) return window.HALO_SIGNAL_URL;
  // file:// or unknown host → no backend (simulated mode).
  if (location.protocol === 'file:' || !location.host) return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/rtc`;
}

export const CONFIG = {
  signalUrl: deriveSignalUrl(),
  // Public STUN keeps most peer connections working across NATs.
  // Add a TURN server here for restrictive networks.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  // How long to wait for the signalling socket before falling back
  // to the simulated demo peers.
  connectTimeoutMs: 2500,
};
