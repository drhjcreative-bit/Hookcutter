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

const server = http.createServer((req, res) => {
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
});
