/* ============================================================
   Halo — participants.js
   Owns the in-call video grid: the real self tile (driven by the
   pipeline) plus simulated peers. Supports hiding individual
   participant windows, gallery/spotlight layouts, and an
   auto-rotating spotlight ("auto rotation video mode" for the
   stage — cycles the focused speaker hands-free).
   ============================================================ */

import { pipeline } from './pipeline.js';
import { media } from './media.js';
import { store } from './state.js';
import { peerIdentity } from './identity.js';
import { openSheet, actionList, haptic, toast } from './ui.js';

class Participants {
  constructor() {
    this.grid = null;
    this.people = [];
    this.layout = 'gallery';
    this.spotlightId = null;
    this.autoRotate = false;
    this._rotTimer = null;
    this._talkTimer = null;
    this._selfCanvas = null;
    this._unregister = null;
  }

  _selfPerson() {
    const me = store.get('identity');
    return { id: 'self', name: me.name, avatar: me.avatar, isSelf: true, muted: !media.micOn, hidden: false, talking: false };
  }

  // Simulated demo peers (offline / no backend).
  start(peerCount = 3) {
    this.grid = document.getElementById('videoGrid');
    this.people = [this._selfPerson()];
    for (let i = 0; i < peerCount; i++) {
      const p = peerIdentity(i + 3);
      this.people.push({ id: 'p' + i, name: p.name, avatar: p.avatar, isSelf: false, muted: Math.random() > 0.5, hidden: false, talking: false });
    }
    this.spotlightId = this.people[0].id;
    this.render();
    this._startTalkSim();
  }

  // Real mesh mode: start with just self; peers arrive via signalling.
  startReal() {
    this.grid = document.getElementById('videoGrid');
    this.people = [this._selfPerson()];
    this.spotlightId = 'self';
    this.render();
  }

  addRealPeer(id, info) {
    if (this.people.find(p => p.id === id)) return;
    this.people.push({ id, name: info.name, avatar: info.avatar, isSelf: false, muted: false, camOff: false, hidden: false, talking: false, stream: null });
    this.render();
  }

  attachStream(id, stream) {
    const p = this.people.find(x => x.id === id);
    if (!p) return;
    p.stream = stream;
    this.render();
  }

  removeRealPeer(id) {
    this.people = this.people.filter(p => p.id !== id);
    if (this.spotlightId === id) { const v = this.visible(); this.spotlightId = v.length ? v[0].id : null; }
    this.render();
  }

  setPeerState(id, st) {
    const p = this.people.find(x => x.id === id);
    if (!p) return;
    if ('muted' in st) p.muted = st.muted;
    if ('camOff' in st) p.camOff = st.camOff;
    this.render();
  }

  stop() {
    clearInterval(this._talkTimer);
    clearInterval(this._rotTimer);
    if (this._unregister) { this._unregister(); this._unregister = null; }
    if (this.grid) this.grid.innerHTML = '';
    this.people = [];
  }

  visible() { return this.people.filter(p => !p.hidden); }

  setLayout(layout) {
    this.layout = layout;
    this.render();
  }

  cycleLayout() {
    this.setLayout(this.layout === 'gallery' ? 'spotlight' : 'gallery');
    return this.layout;
  }

  toggleAutoRotate() {
    this.autoRotate = !this.autoRotate;
    clearInterval(this._rotTimer);
    if (this.autoRotate) {
      this.setLayout('spotlight');
      this._rotTimer = setInterval(() => {
        const vis = this.visible();
        if (vis.length < 2) return;
        const idx = vis.findIndex(p => p.id === this.spotlightId);
        this.spotlightId = vis[(idx + 1) % vis.length].id;
        this.render();
      }, 3500);
    }
    return this.autoRotate;
  }

  hide(id) {
    const p = this.people.find(x => x.id === id);
    if (!p) return;
    p.hidden = true;
    if (this.spotlightId === id) {
      const v = this.visible();
      this.spotlightId = v.length ? v[0].id : null;
    }
    this.render();
    toast(p.isSelf ? 'Self view hidden' : `${p.name} hidden`);
  }

  showAll() {
    this.people.forEach(p => { p.hidden = false; });
    this.render();
  }

  spotlight(id) {
    this.spotlightId = id;
    this.setLayout('spotlight');
  }

  setSelfMuted(muted) {
    const self = this.people.find(p => p.isSelf);
    if (self) { self.muted = muted; this.render(); }
  }

  _startTalkSim() {
    clearInterval(this._talkTimer);
    this._talkTimer = setInterval(() => {
      let changed = false;
      for (const p of this.people) {
        if (p.isSelf) continue;
        const talk = !p.muted && Math.random() > 0.7;
        if (talk !== p.talking) { p.talking = talk; changed = true; }
      }
      if (changed) this._refreshTalkClasses();
    }, 1400);
  }

  _refreshTalkClasses() {
    if (!this.grid) return;
    for (const p of this.people) {
      const tile = this.grid.querySelector(`[data-pid="${p.id}"]`);
      if (tile) tile.classList.toggle('talking', p.talking);
    }
  }

  render() {
    if (!this.grid) return;
    if (this._unregister) { this._unregister(); this._unregister = null; }
    this._selfCanvas = null;
    this.grid.innerHTML = '';

    const vis = this.visible();
    this.grid.dataset.layout = this.layout;
    this.grid.dataset.count = String(vis.length);

    if (this.layout === 'spotlight') {
      const spot = vis.find(p => p.id === this.spotlightId) || vis[0];
      if (spot) this.grid.appendChild(this._tile(spot, true));
      const strip = document.createElement('div');
      strip.className = 'strip';
      vis.filter(p => spot && p.id !== spot.id).forEach(p => strip.appendChild(this._tile(p, false)));
      this.grid.appendChild(strip);
    } else {
      vis.forEach(p => this.grid.appendChild(this._tile(p, false)));
    }

    // Hidden pill
    const hiddenCount = this.people.length - vis.length;
    let pill = document.querySelector('.hidden-pill');
    if (hiddenCount > 0) {
      if (!pill) {
        pill = document.createElement('button');
        pill.className = 'hidden-pill';
        pill.addEventListener('click', () => { haptic(); this.showAll(); });
        document.getElementById('callStage').appendChild(pill);
      }
      pill.textContent = `${hiddenCount} hidden · show`;
    } else if (pill) {
      pill.remove();
    }

    if (this._selfCanvas) {
      this._unregister = pipeline.register(this._selfCanvas);
    }
  }

  _tile(p, isSpot) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (p.isSelf ? ' self' : '') + (isSpot ? ' spot' : '') + (p.talking ? ' talking' : '');
    if (p.isSelf && store.get('effects').mirror) tile.classList.add('mirror');
    tile.dataset.pid = p.id;

    if (p.isSelf && media.ready) {
      const canvas = document.createElement('canvas');
      tile.appendChild(canvas);
      this._selfCanvas = canvas;
      // mirror handled inside pipeline; remove CSS mirror to avoid double flip
      tile.classList.remove('mirror');
    } else if (!p.isSelf && p.stream && !p.camOff) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.muted = false;
      video.srcObject = p.stream;
      const play = video.play();
      if (play && play.catch) play.catch(() => {});
      tile.classList.remove('mirror');
      tile.appendChild(video);
    } else {
      const av = document.createElement('div');
      av.className = 'tile-avatar';
      av.textContent = p.avatar;
      tile.appendChild(av);
    }

    const tag = document.createElement('div');
    tag.className = 'tile-tag';
    tag.innerHTML = `${p.muted ? '<span class="muted-ic">🔇</span>' : ''}<span>${p.isSelf ? 'You' : p.name}</span>`;
    tile.appendChild(tag);

    const menu = document.createElement('button');
    menu.className = 'tile-menu';
    menu.textContent = '⋯';
    menu.addEventListener('click', (e) => { e.stopPropagation(); this._tileMenu(p); });
    tile.appendChild(menu);

    return tile;
  }

  _tileMenu(p) {
    const actions = [
      { icon: '🎯', label: 'Spotlight', onClick: () => { this.spotlight(p.id); closeAndToast(`Spotlighting ${p.isSelf ? 'you' : p.name}`); } },
      { icon: '🙈', label: p.isSelf ? 'Hide self view' : 'Hide this window', onClick: () => { this.hide(p.id); import('./ui.js').then(m => m.closeSheet()); } },
    ];
    if (p.isSelf) {
      actions.push({ icon: '✦', label: 'Open effects', onClick: () => { document.querySelector('[data-ctrl="studio"]').click(); import('./ui.js').then(m => m.closeSheet()); } });
    }
    openSheet(p.isSelf ? 'You' : p.name, actionList(actions));
  }
}

function closeAndToast(msg) {
  import('./ui.js').then(m => { m.closeSheet(); m.toast(msg); });
}

export const participants = new Participants();
