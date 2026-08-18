/* ============================================================
   Halo server
   One process, two jobs:
     1. Serve the static web/ client.
     2. Host a WebSocket signalling relay for a WebRTC mesh so
        real, anonymous participants can find each other in a room
        and exchange SDP/ICE. No accounts, no media touches the
        server — it only relays signalling (media is peer-to-peer).

   Mesh topology suits small anonymous rooms and deploys anywhere
   as a single Node process (Replit, Render, Fly, a VPS…).
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const PORT = process.env.PORT || 3000;
const MAX_ROOM = Number(process.env.HALO_MAX_ROOM || 8);

/* ---------------- Static file server ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null; // path traversal guard
  return resolved;
}

/* ---------------- Zoom Meeting SDK interop ----------------
   Optional. Set ZOOM_SDK_KEY / ZOOM_SDK_SECRET (a Zoom Marketplace
   "Meeting SDK" app's Client ID / Client Secret) and the client gains a
   "Join Zoom meeting" mode that enters REAL Zoom meetings via the
   official Meeting SDK. The secret never leaves this server — the
   browser only ever receives a short-lived HS256 join signature. */
const ZOOM_SDK_KEY = process.env.ZOOM_SDK_KEY || '';
const ZOOM_SDK_SECRET = process.env.ZOOM_SDK_SECRET || '';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function zoomSignature(meetingNumber, role) {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2; // 2h, within Zoom's 48h cap
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    appKey: ZOOM_SDK_KEY,
    sdkKey: ZOOM_SDK_KEY,
    mn: String(meetingNumber),
    role,
    iat,
    exp,
    tokenExp: exp,
  }));
  const sig = b64url(crypto.createHmac('sha256', ZOOM_SDK_SECRET)
    .update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/zoom-config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const enabled = !!(ZOOM_SDK_KEY && ZOOM_SDK_SECRET);
    res.end(JSON.stringify(enabled ? { enabled, sdkKey: ZOOM_SDK_KEY } : { enabled }));
    return true;
  }

  if (req.method === 'GET' && urlPath === '/health') {
    // Diagnostics: enough to debug setup, never enough to leak a credential.
    // Zoom Client IDs are ~22 chars and Client Secrets are 32, so a 32-char
    // "key" with a shorter "secret" almost certainly means the two are swapped.
    const keyLen = ZOOM_SDK_KEY.length;
    const secretLen = ZOOM_SDK_SECRET.length;
    const body = {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      signalling: { path: '/rtc', rooms: rooms.size, maxRoom: MAX_ROOM },
      zoom: {
        configured: !!(keyLen && secretLen),
        sdkKeySet: !!keyLen,
        sdkSecretSet: !!secretLen,
        sdkKeyLength: keyLen,
        sdkSecretLength: secretLen,
        sdkKeyPreview: keyLen ? ZOOM_SDK_KEY.slice(0, 4) + '…' : null,
        likelySwapped: keyLen === 32 && secretLen > 0 && secretLen < 32,
      },
    };
    if (!body.zoom.configured) {
      body.zoom.hint = 'Set ZOOM_SDK_KEY (Client ID) and ZOOM_SDK_SECRET (Client Secret), then restart the server.';
    } else if (body.zoom.likelySwapped) {
      body.zoom.hint = 'ZOOM_SDK_KEY looks like a Client Secret — the two values are probably swapped.';
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body, null, 2));
    return true;
  }

  if (req.method === 'POST' && urlPath === '/zoom-signature') {
    if (!ZOOM_SDK_KEY || !ZOOM_SDK_SECRET) {
      res.writeHead(503); res.end('Zoom SDK keys not configured'); return true;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { meetingNumber, role } = JSON.parse(body || '{}');
        const mn = String(meetingNumber || '').replace(/\D/g, '');
        if (!mn) { res.writeHead(400); res.end('meetingNumber required'); return; }
        const signature = zoomSignature(mn, role === 1 ? 1 : 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ signature, sdkKey: ZOOM_SDK_KEY }));
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  if (handleApi(req, res)) return;
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  let filePath = safeJoin(WEB_ROOT, urlPath);
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback to index.html for unknown non-asset routes.
      if (!path.extname(filePath)) {
        filePath = path.join(WEB_ROOT, 'index.html');
      } else {
        res.writeHead(404); return res.end('Not found');
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ---------------- Signalling relay ---------------- */
const wss = new WebSocketServer({ server, path: '/rtc' });

/** room -> Map(peerId -> { ws, name, avatar }) */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function roomPeers(room, exceptId) {
  const m = rooms.get(room);
  if (!m) return [];
  return [...m.entries()]
    .filter(([id]) => id !== exceptId)
    .map(([id, p]) => ({ id, name: p.name, avatar: p.avatar }));
}

function leave(ws) {
  const { room, id } = ws.meta || {};
  if (!room || !id) return;
  const m = rooms.get(room);
  if (!m) return;
  m.delete(id);
  for (const [, p] of m) send(p.ws, { type: 'peer-left', id });
  if (m.size === 0) rooms.delete(room);
  ws.meta = null;
}

wss.on('connection', (ws) => {
  ws.meta = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const room = String(msg.room || '').slice(0, 64) || 'lobby';
      const id = String(msg.id || '').slice(0, 64);
      if (!id) return;
      let m = rooms.get(room);
      if (!m) { m = new Map(); rooms.set(room, m); }
      if (m.size >= MAX_ROOM) { send(ws, { type: 'room-full', max: MAX_ROOM }); return; }

      const name = String(msg.name || 'Anon').slice(0, 40);
      const avatar = String(msg.avatar || '🙂').slice(0, 8);
      ws.meta = { room, id };
      // Tell the newcomer who is already here (they will initiate offers).
      send(ws, { type: 'peers', peers: roomPeers(room, id), self: { id } });
      // Announce to the room.
      for (const [, p] of m) send(p.ws, { type: 'peer-joined', peer: { id, name, avatar } });
      m.set(id, { ws, name, avatar });
      return;
    }

    // Relay an SDP/ICE signal to a specific peer in the same room.
    if (msg.type === 'signal') {
      const { room, id } = ws.meta || {};
      if (!room) return;
      const m = rooms.get(room);
      const target = m && m.get(msg.to);
      if (target) send(target.ws, { type: 'signal', from: id, data: msg.data });
      return;
    }

    // Optional: relay in-room chat (text/gif) to everyone else.
    if (msg.type === 'chat') {
      const { room, id } = ws.meta || {};
      if (!room) return;
      const m = rooms.get(room);
      if (!m) return;
      for (const [pid, p] of m) if (pid !== id) send(p.ws, { type: 'chat', from: id, name: msg.name, text: msg.text, gif: msg.gif });
      return;
    }

    // Presence updates (mute state etc.)
    if (msg.type === 'state') {
      const { room, id } = ws.meta || {};
      if (!room) return;
      const m = rooms.get(room);
      if (!m) return;
      for (const [pid, p] of m) if (pid !== id) send(p.ws, { type: 'state', from: id, muted: !!msg.muted, camOff: !!msg.camOff });
      return;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

/* keep-alive ping so idle proxies (Replit) don't drop sockets */
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) { try { client.ping(); } catch {} }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Halo server on :${PORT}  (web=${WEB_ROOT})`);
  if (ZOOM_SDK_KEY && ZOOM_SDK_SECRET) {
    console.log(`Zoom interop: ENABLED (sdkKey ${ZOOM_SDK_KEY.slice(0, 4)}…, ${ZOOM_SDK_KEY.length} chars)`);
    if (ZOOM_SDK_KEY.length === 32 && ZOOM_SDK_SECRET.length < 32) {
      console.warn('Zoom interop: WARNING — ZOOM_SDK_KEY looks like a Client Secret; the values may be swapped.');
    }
  } else {
    console.log('Zoom interop: disabled (set ZOOM_SDK_KEY and ZOOM_SDK_SECRET to enable). Diagnostics: /health');
  }
});
