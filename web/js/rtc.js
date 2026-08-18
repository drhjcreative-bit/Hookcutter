/* ============================================================
   Halo — rtc.js
   WebRTC mesh client. Connects to the signalling relay, joins a
   room, and maintains one RTCPeerConnection per remote peer.
   The newcomer always initiates offers to existing peers (glare
   avoidance). The local outgoing stream is the *processed* canvas
   (filters/overlays baked in) plus the mic track, so peers see
   exactly what the studio shows.

   Emits lifecycle callbacks; participants.js turns them into tiles.
   ============================================================ */

import { CONFIG } from './config.js';

export class MeshClient {
  constructor({ room, identity, localStream, handlers }) {
    this.room = room;
    this.identity = identity;
    this.localStream = localStream;       // MediaStream (canvas video + mic audio)
    this.h = handlers || {};
    this.ws = null;
    this.selfId = identity.handle + '-' + Math.random().toString(36).slice(2, 8);
    this.peers = new Map();                // id -> { pc, name, avatar }
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!CONFIG.signalUrl) return reject(new Error('no-signal-url'));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { this.ws && this.ws.close(); } catch {} reject(new Error('timeout')); }
      }, CONFIG.connectTimeoutMs);

      let ws;
      try { ws = new WebSocket(CONFIG.signalUrl); }
      catch (e) { clearTimeout(timer); return reject(e); }
      this.ws = ws;

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._send({ type: 'join', room: this.room, id: this.selfId, name: this.identity.name, avatar: this.identity.avatar });
        resolve(this);
      };
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ws-error')); } };
      ws.onclose = () => { if (!this.closed && this.h.onDisconnect) this.h.onDisconnect(); };
      ws.onmessage = (ev) => this._onMessage(ev);
    });
  }

  _send(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  async _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'peers':
        // Existing peers — we initiate an offer to each.
        for (const p of msg.peers) await this._createPeer(p, true);
        break;
      case 'peer-joined':
        // A newcomer will call us; just pre-register so the tile exists.
        await this._createPeer(msg.peer, false);
        break;
      case 'peer-left':
        this._removePeer(msg.id);
        break;
      case 'signal':
        await this._onSignal(msg.from, msg.data);
        break;
      case 'chat':
        this.h.onChat && this.h.onChat(msg);
        break;
      case 'state':
        this.h.onState && this.h.onState(msg.from, { muted: msg.muted, camOff: msg.camOff });
        break;
      case 'room-full':
        this.h.onRoomFull && this.h.onRoomFull(msg.max);
        break;
    }
  }

  async _createPeer(info, initiator) {
    if (this.peers.has(info.id)) return this.peers.get(info.id);
    const pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
    const entry = { pc, name: info.name, avatar: info.avatar };
    this.peers.set(info.id, entry);
    this.h.onPeerAdd && this.h.onPeerAdd(info.id, { name: info.name, avatar: info.avatar });

    // Push our local tracks.
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this._send({ type: 'signal', to: info.id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.h.onRemoteStream && this.h.onRemoteStream(info.id, stream);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // leave cleanup to peer-left; failed can be transient
      }
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._send({ type: 'signal', to: info.id, data: { sdp: pc.localDescription } });
      } catch (e) { /* ignore */ }
    }
    return entry;
  }

  async _onSignal(from, data) {
    let entry = this.peers.get(from);
    if (!entry) entry = await this._createPeer({ id: from, name: 'Anon', avatar: '🙂' }, false);
    const pc = entry.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this._send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    } catch (e) { /* ignore malformed */ }
  }

  _removePeer(id) {
    const entry = this.peers.get(id);
    if (entry) { try { entry.pc.close(); } catch {} this.peers.delete(id); }
    this.h.onPeerRemove && this.h.onPeerRemove(id);
  }

  sendChat(payload) { this._send({ type: 'chat', ...payload }); }
  sendState(state) { this._send({ type: 'state', ...state }); }

  close() {
    this.closed = true;
    for (const [id] of this.peers) this._removePeer(id);
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }
}
