/* ============================================================
   Halo — app.js
   Application bootstrap and orchestration. Wires views, the
   studio, the call surface, the GIF bank, the in-app browser,
   and the anonymous identity together.
   ============================================================ */

import { store } from './state.js';
import { media } from './media.js';
import { pipeline } from './pipeline.js';
import { FILTERS } from './filters.js';
import { OVERLAYS } from './overlays.js';
import { participants } from './participants.js';
import { initInbox, updateBadge } from './inbox.js';
import { importImageAsGif, listGifs, deleteGif, gifUrl, captureLiveGif } from './gifbank.js';
import { openBrowserWindow } from './windows.js';
import { openSheet, closeSheet, actionList, toast, haptic, escapeHtml } from './ui.js';
import { MeshClient } from './rtc.js';
import { CONFIG } from './config.js';
import { getZoomConfig, joinZoomMeeting } from './zoom.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const app = $('#app');
const previewCanvas = $('#previewCanvas');
const studioCanvas = $('#studioCanvas');

let callTimer = null;
let mesh = null;

/* ---------------- View routing ---------------- */
function setView(name) {
  app.dataset.view = name;
  $$('.view').forEach(v => { v.hidden = v.dataset.viewPanel !== name; });
  $$('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  // camera preview only runs on views that show it
  pipeline.setActive(previewCanvas, name === 'home');
  pipeline.setActive(studioCanvas, name === 'studio');
  if (name === 'studio') syncStudioControls();
  updatePreviewFallback();
}

/* ---------------- Identity + home ---------------- */
function renderIdentity() {
  const id = store.get('identity');
  $('#identityName').textContent = id.name;
  $('#heroAvatar').textContent = id.avatar;
}

function renderRecents() {
  const list = $('#recentList');
  const recents = store.get('recents');
  if (!recents.length) {
    list.innerHTML = `<li style="color:var(--text-faint);font-size:14px;padding:10px 6px">No recent meetings yet — start one above.</li>`;
    return;
  }
  list.innerHTML = '';
  recents.forEach(m => {
    const li = document.createElement('li');
    li.className = 'list-row';
    li.innerHTML = `
      <div class="avatar grad">${m.emoji || '🎥'}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(m.title)}</div>
        <div class="row-sub">Code ${escapeHtml(m.code)}</div>
      </div>
      <div class="row-meta">${new Date(m.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>`;
    li.addEventListener('click', () => startCall(m));
    list.appendChild(li);
  });
}

function updatePreviewFallback() {
  const fb = $('#heroFallback');
  if (fb) fb.style.opacity = media.ready ? '0' : '1';
}

/* ---------------- Studio ---------------- */
function buildRail(railId, items, key) {
  const rail = $('#' + railId);
  rail.innerHTML = '';
  items.forEach(item => {
    const chip = document.createElement('button');
    chip.className = 'fx-chip' + (store.get('effects')[key] === item.id ? ' active' : '');
    chip.dataset.id = item.id;
    chip.innerHTML = `<div class="fx-thumb">${item.thumb}</div><span class="fx-name">${item.name}</span>`;
    chip.addEventListener('click', () => {
      haptic();
      store.setEffect(key, item.id);
      $$('.fx-chip', rail).forEach(c => c.classList.toggle('active', c.dataset.id === item.id));
    });
    rail.appendChild(chip);
  });
}

function syncStudioControls() {
  const fx = store.get('effects');
  $$('[data-adjust]').forEach(el => {
    const k = el.dataset.adjust;
    if (el.type === 'checkbox') el.checked = !!fx[k];
    else el.value = fx[k];
  });
  $('#studioHint').style.opacity = media.ready ? '0' : '1';
}

function initStudio() {
  buildRail('filterRail', FILTERS, 'filter');
  buildRail('overlayRail', OVERLAYS, 'overlay');

  $$('[data-studio-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('[data-studio-tab]').forEach(t => t.classList.toggle('active', t === tab));
      $$('[data-studio-panel]').forEach(p => { p.hidden = p.dataset.studioPanel !== tab.dataset.studioTab; });
    });
  });

  $$('[data-adjust]').forEach(el => {
    const k = el.dataset.adjust;
    el.addEventListener('input', () => {
      const val = el.type === 'checkbox' ? el.checked : Number(el.value);
      store.setEffect(k, val);
    });
  });

  $('[data-action="studio-reset"]').addEventListener('click', () => {
    store.resetEffects();
    buildRail('filterRail', FILTERS, 'filter');
    buildRail('overlayRail', OVERLAYS, 'overlay');
    syncStudioControls();
    toast('Effects reset');
  });
}

/* ---------------- Call ---------------- */
async function startCall(meeting) {
  const m = meeting || {
    title: 'Instant Meeting',
    code: genCode(),
    emoji: '🎥',
    at: Date.now(),
  };
  store.addRecent(m);

  const surface = $('#callSurface');
  surface.hidden = false;
  surface.setAttribute('aria-hidden', 'false');
  $('#callTitle').textContent = m.title;

  if (!media.ready) await media.start();
  updateControlStates();

  await connectRoom(m);

  // timer
  const t0 = Date.now();
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  haptic(20);
}

// Demo peers are OPT-IN only (?demo=1). Filling a failed call with fake
// participants made a broken connection look like a working meeting.
const DEMO_MODE = new URLSearchParams(location.search).has('demo');

function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', String(code).replace(/\s+/g, ''));
  return url.toString();
}

/** The banner that tells the truth about the call's connection state. */
function setRoomStatus(state, meeting) {
  const stage = $('#callStage');
  if (!stage) return;
  let el = $('#roomStatus');
  if (state === 'hidden') { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'roomStatus';
    el.className = 'room-status';
    stage.appendChild(el);
  }
  el.classList.toggle('warn', state === 'offline');

  if (state === 'connecting') {
    el.innerHTML = `<div class="rs-main"><div class="rs-title">Connecting…</div>
      <div class="rs-sub">Reaching the meeting server</div></div>`;
    return;
  }

  if (state === 'alone') {
    el.innerHTML = `<div class="rs-main"><div class="rs-title">You're the only one here</div>
      <div class="rs-sub">Others join with code <span class="rs-code">${escapeHtml(meeting.code)}</span></div></div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Copy invite';
    btn.addEventListener('click', async () => {
      const link = inviteLink(meeting.code);
      try {
        if (navigator.share) { await navigator.share({ title: 'Join my Halo room', url: link }); }
        else { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
      } catch { toast(link, 6000); }
    });
    el.appendChild(btn);
    return;
  }

  if (state === 'offline') {
    el.innerHTML = `<div class="rs-main"><div class="rs-title">Can't reach the meeting server</div>
      <div class="rs-sub">Nobody else can join this room right now.</div></div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => connectRoom(meeting));
    el.appendChild(btn);
    return;
  }

  if (state === 'demo') {
    el.innerHTML = `<div class="rs-main"><div class="rs-title">Demo mode</div>
      <div class="rs-sub">These participants are simulated — remove ?demo=1 for real calls.</div></div>`;
  }
}

/** Show the banner only while the call has no real peers. */
function refreshRoomStatus(meeting) {
  if (!mesh) return;
  const others = participants.people.filter(p => !p.isSelf).length;
  setRoomStatus(others > 0 ? 'hidden' : 'alone', meeting);
}

async function connectRoom(m) {
  const room = String(m.code).replace(/\s+/g, '');
  const audioTracks = media.stream ? media.stream.getAudioTracks() : [];
  const outStream = pipeline.getBroadcastStream({ audioTracks });

  if (DEMO_MODE) {
    participants.start(3);
    setRoomStatus('demo', m);
    return;
  }

  if (!CONFIG.signalUrl) {
    participants.startReal();
    setRoomStatus('offline', m);
    return;
  }

  participants.startReal();
  setRoomStatus('connecting', m);

  if (mesh) { mesh.close(); mesh = null; }
  mesh = new MeshClient({
    room,
    identity: store.get('identity'),
    localStream: outStream,
    handlers: {
      onPeerAdd: (id, info) => { participants.addRealPeer(id, info); refreshRoomStatus(m); },
      onRemoteStream: (id, stream) => participants.attachStream(id, stream),
      onPeerRemove: (id) => { participants.removeRealPeer(id); refreshRoomStatus(m); },
      onState: (id, st) => participants.setPeerState(id, st),
      onChat: (msg) => { pushCallChat({ from: 'them', text: msg.text, gif: msg.gif, name: msg.name }); },
      onRoomFull: (max) => toast(`Room full (max ${max})`),
      onDisconnect: () => { setRoomStatus('offline', m); },
    },
  });

  try {
    await mesh.connect();
    refreshRoomStatus(m);
  } catch (_) {
    mesh = null;
    // Be honest: no fake people, just what actually happened.
    setRoomStatus('offline', m);
  }
}

function leaveCall() {
  clearInterval(callTimer);
  if (mesh) { mesh.close(); mesh = null; }
  pipeline.stopBroadcast();
  participants.stop();
  setRoomStatus('hidden');
  $('#windowsLayer').innerHTML = '';
  window.__callMsgs = [];
  const surface = $('#callSurface');
  surface.hidden = true;
  surface.setAttribute('aria-hidden', 'true');
  toast('You left the meeting');
}

function updateControlStates() {
  const mic = $('[data-ctrl="mic"]');
  const cam = $('[data-ctrl="cam"]');
  mic.classList.toggle('off', !media.micOn);
  $('.ctrl-label', mic).textContent = media.micOn ? 'Mute' : 'Unmute';
  cam.classList.toggle('off', !media.camOn);
  $('.ctrl-label', cam).textContent = media.camOn ? 'Video' : 'Start';
}

function initCallControls() {
  $('[data-ctrl="mic"]').addEventListener('click', () => {
    const on = media.toggleMic();
    participants.setSelfMuted(!on);
    updateControlStates();
    if (mesh) mesh.sendState({ muted: !on, camOff: !media.camOn });
    toast(on ? 'Unmuted' : 'Muted');
  });
  $('[data-ctrl="cam"]').addEventListener('click', async () => {
    await media.toggleCamera();
    updateControlStates();
    participants.render();
    if (mesh) mesh.sendState({ muted: !media.micOn, camOff: !media.camOn });
  });
  $('[data-ctrl="studio"]').addEventListener('click', () => openEffectsSheet());
  $('[data-ctrl="participants"]').addEventListener('click', () => openParticipantsSheet());
  $('[data-ctrl="chat"]').addEventListener('click', () => openCallChat());
  $('[data-ctrl="more"]').addEventListener('click', () => openMoreSheet());

  $('[data-action="leave-call"]').addEventListener('click', leaveCall);
  $('[data-action="cycle-layout"]').addEventListener('click', () => {
    const l = participants.cycleLayout();
    toast(l === 'gallery' ? 'Gallery view' : 'Spotlight view');
  });
  $('[data-action="flip-camera"]').addEventListener('click', () => media.flip());
}

function openEffectsSheet() {
  const wrap = document.createElement('div');
  const preview = document.createElement('div');
  preview.style.cssText = 'aspect-ratio:1;max-height:34vh;margin:0 auto 14px;border-radius:var(--r-lg);overflow:hidden;background:#000;width:100%';
  const cvs = document.createElement('canvas');
  cvs.style.cssText = 'width:100%;height:100%;object-fit:cover';
  preview.appendChild(cvs);
  wrap.appendChild(preview);
  const unreg = pipeline.register(cvs);

  const railFilters = document.createElement('div');
  railFilters.className = 'chip-rail';
  FILTERS.forEach(f => railFilters.appendChild(fxChip(f, 'filter')));
  const railOverlays = document.createElement('div');
  railOverlays.className = 'chip-rail';
  OVERLAYS.forEach(o => railOverlays.appendChild(fxChip(o, 'overlay')));

  const lbl1 = section('Filters'); const lbl2 = section('Overlays');
  wrap.append(lbl1, railFilters, lbl2, railOverlays);

  // quick adjust
  wrap.appendChild(sliderRow('Touch up', 'touchup', 0, 100));
  wrap.appendChild(sliderRow('Low light', 'lowlight', 0, 100));
  wrap.appendChild(switchRow('Auto‑rotation video', 'autorotate'));

  openSheet('Effects', wrap, () => unreg());
}

function fxChip(item, key) {
  const chip = document.createElement('button');
  chip.className = 'fx-chip' + (store.get('effects')[key] === item.id ? ' active' : '');
  chip.innerHTML = `<div class="fx-thumb">${item.thumb}</div><span class="fx-name">${item.name}</span>`;
  chip.addEventListener('click', () => {
    haptic();
    store.setEffect(key, item.id);
    [...chip.parentElement.children].forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
  });
  return chip;
}

function section(text) {
  const h = document.createElement('h2');
  h.className = 'section-label';
  h.textContent = text;
  return h;
}

function sliderRow(label, key, min, max) {
  const row = document.createElement('label');
  row.className = 'slider-row';
  row.innerHTML = `<span>${label}</span>`;
  const input = document.createElement('input');
  input.type = 'range'; input.min = min; input.max = max; input.value = store.get('effects')[key];
  input.addEventListener('input', () => store.setEffect(key, Number(input.value)));
  row.appendChild(input);
  return row;
}

function switchRow(label, key) {
  const row = document.createElement('label');
  row.className = 'switch-row';
  row.innerHTML = `<span>${label}</span>`;
  const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = !!store.get('effects')[key];
  input.addEventListener('change', () => store.setEffect(key, input.checked));
  row.appendChild(input);
  return row;
}

function openParticipantsSheet() {
  const wrap = document.createElement('div');
  participants.people.forEach(p => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="avatar">${p.avatar}</div>
      <div class="row-main"><div class="row-title">${p.isSelf ? 'You' : escapeHtml(p.name)}</div>
      <div class="row-sub">${p.hidden ? 'Hidden' : p.muted ? 'Muted' : 'Active'}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'text-btn';
    btn.textContent = p.hidden ? 'Show' : 'Hide';
    btn.addEventListener('click', () => {
      if (p.hidden) { p.hidden = false; participants.render(); }
      else participants.hide(p.id);
      closeSheet();
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
  openSheet(`People · ${participants.people.length}`, wrap);
}

function openMoreSheet() {
  openSheet('More', actionList([
    { icon: '🔄', label: (participants.autoRotate ? 'Stop' : 'Start') + ' auto‑rotate spotlight', onClick: () => { const on = participants.toggleAutoRotate(); closeSheet(); toast(on ? 'Auto‑rotate on' : 'Auto‑rotate off'); } },
    { icon: '◎', label: 'Open in‑app browser', onClick: () => { closeSheet(); openBrowserWindow(); } },
    { icon: '◍', label: 'Send a GIF', onClick: () => { closeSheet(); openCallChat(); } },
    { icon: '📸', label: 'Capture GIF of my video', onClick: async () => { closeSheet(); toast('Capturing…'); try { await captureLiveGif(); toast('Saved to GIF bank'); } catch { toast('Camera needed'); } } },
    { icon: '▦', label: 'Toggle layout', onClick: () => { closeSheet(); participants.cycleLayout(); } },
  ]));
}

// Append a message to the in-meeting chat buffer and repaint if open.
function pushCallChat(msg) {
  const buf = window.__callMsgs || (window.__callMsgs = []);
  buf.push(msg);
  if (window.__repaintCallChat) window.__repaintCallChat();
  else if (msg.from === 'them') toast(`${msg.name || 'Someone'}: ${msg.gif ? 'GIF' : (msg.text || '')}`);
}

function openCallChat() {
  const messages = window.__callMsgs || (window.__callMsgs = []);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:64vh';
  const log = document.createElement('div');
  log.className = 'chat-log'; log.style.cssText = 'flex:1;overflow-y:auto';
  const paint = () => {
    log.innerHTML = messages.map(m => `<div class="chat-msg ${m.from === 'me' ? 'me' : 'them'}">${m.from === 'them' && m.name ? `<div class="chat-author">${escapeHtml(m.name)}</div>` : ''}${m.gif ? `<img src="${m.gif}">` : escapeHtml(m.text)}</div>`).join('') || '<p style="color:var(--text-faint);text-align:center;padding:30px">No messages yet</p>';
    log.scrollTop = log.scrollHeight;
  };
  paint();
  window.__repaintCallChat = paint;

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  inputRow.innerHTML = `<button class="chat-send" data-gif style="background:var(--bg-elev-2);color:var(--text)">GIF</button><input placeholder="Message everyone"><button class="chat-send" data-send>➤</button>`;
  const input = inputRow.querySelector('input');
  const me = store.get('identity');
  const send = (msg) => {
    pushCallChat({ ...msg, from: 'me' });
    if (mesh) mesh.sendChat({ name: me.name, text: msg.text, gif: msg.gif });
  };
  inputRow.querySelector('[data-send]').addEventListener('click', () => { const v = input.value.trim(); if (v) { send({ text: v }); input.value = ''; } });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) { send({ text: v }); input.value = ''; } } });
  inputRow.querySelector('[data-gif]').addEventListener('click', async () => {
    const gifs = await listGifs();
    if (!gifs.length) return toast('GIF bank is empty');
    const picker = document.createElement('div'); picker.className = 'gif-grid';
    gifs.slice(0, 12).forEach(g => { const cell = document.createElement('div'); cell.className = 'gif-cell'; cell.innerHTML = `<img src="${gifUrl(g)}">`; cell.addEventListener('click', () => { send({ gif: gifUrl(g) }); closeSheet(); openCallChat(); }); picker.appendChild(cell); });
    openSheet('Send a GIF', picker);
  });
  wrap.append(log, inputRow);
  openSheet('Chat', wrap, () => { window.__repaintCallChat = null; });
}

/* ---------------- GIF bank ---------------- */
async function openGifBank() {
  const wrap = document.createElement('div');

  const uploader = document.createElement('label');
  uploader.className = 'gif-uploader';
  uploader.innerHTML = `<span>＋ Upload image — auto‑saved as GIF</span>`;
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.hidden = true;
  uploader.appendChild(fileInput);
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    toast('Converting to GIF…');
    for (const f of files) {
      try { await importImageAsGif(f); } catch { toast('Could not import ' + f.name); }
    }
    toast('Saved as GIF');
    closeSheet();
    openGifBank();
  });
  wrap.appendChild(uploader);

  const captureBtn = document.createElement('button');
  captureBtn.className = 'pill-btn ghost';
  captureBtn.style.cssText = 'width:100%;margin-bottom:14px';
  captureBtn.textContent = '📸 Capture a live GIF from camera';
  captureBtn.addEventListener('click', async () => {
    if (!media.ready) { toast('Turn on your camera first'); return; }
    toast('Recording…');
    try { await captureLiveGif(); toast('Saved'); closeSheet(); openGifBank(); }
    catch { toast('Capture failed'); }
  });
  wrap.appendChild(captureBtn);

  const grid = document.createElement('div');
  grid.className = 'gif-grid';
  const gifs = await listGifs();
  if (!gifs.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;color:var(--text-faint);text-align:center;padding:24px">Your bank is empty. Upload an image or capture one.</p>';
  } else {
    gifs.forEach(g => {
      const cell = document.createElement('div');
      cell.className = 'gif-cell';
      cell.innerHTML = `<img src="${gifUrl(g)}" alt="${escapeHtml(g.name)}"><span class="gif-tag">${g.origin === 'converted' ? 'GIF' : g.origin.toUpperCase()}</span><button class="gif-del">✕</button>`;
      cell.querySelector('.gif-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteGif(g.id);
        cell.remove();
        toast('Deleted');
      });
      grid.appendChild(cell);
    });
  }
  wrap.appendChild(grid);

  openSheet('GIF Bank', wrap);
}

/* ---------------- Meeting helpers ---------------- */
function genCode() {
  const n = () => Math.floor(Math.random() * 900 + 100);
  return `${n()} ${n()} ${n()}`;
}

async function joinZoomFlow(meetingNumber, passcode = '', userName) {
  toast('Connecting to Zoom…');
  try {
    await joinZoomMeeting({
      meetingNumber,
      passcode,
      userName: userName || store.get('identity').name,
    });
  } catch (e) {
    const msg = e && e.message === 'zoom-not-configured'
      ? 'Zoom keys not configured on the server — see /health'
      : `Zoom: ${(e && (e.message || e.reason)) || 'could not join'}`;
    toast(msg, 6000);
    console.error('[Halo] Zoom join failed:', e && e.raw ? e.raw : e);
  }
}

async function joinMeetingPrompt() {
  const zoomCfg = await getZoomConfig();
  const wrap = document.createElement('div');

  /* ---- Halo room pane ---- */
  const haloPane = document.createElement('div');
  haloPane.innerHTML = `<input class="search" id="joinCode" placeholder="Enter meeting code" inputmode="numeric" style="margin-bottom:14px">`;
  const haloHint = document.createElement('p');
  haloHint.style.cssText = 'font-size:12px;color:var(--text-faint);margin:-6px 0 14px';
  haloHint.textContent = 'A Halo room only connects people using this app with the same code. It is not a Zoom meeting ID.';
  haloPane.appendChild(haloHint);

  const haloBtn = document.createElement('button');
  haloBtn.className = 'pill-btn'; haloBtn.style.width = '100%'; haloBtn.textContent = 'Join Halo room';
  haloBtn.addEventListener('click', () => {
    const raw = $('#joinCode', haloPane).value.trim();
    const digits = raw.replace(/\D/g, '');
    // Zoom meeting IDs are 9-11 digits. Typing one here silently creates an
    // empty Halo room, which is the single most confusing thing this app can
    // do — so intercept it and offer the right destination instead.
    if (zoomCfg.enabled && digits.length >= 9 && digits.length <= 11) {
      closeSheet();
      openSheet('That looks like a Zoom ID', actionList([
        { icon: '🎥', label: 'Join it as a real Zoom meeting', onClick: () => { closeSheet(); joinZoomFlow(digits); } },
        { icon: '＃', label: 'No — make a Halo room with this code', onClick: () => { closeSheet(); startCall({ title: 'Meeting ' + digits, code: digits, emoji: '🎥', at: Date.now() }); } },
      ]));
      return;
    }
    const code = raw || genCode();
    closeSheet();
    startCall({ title: 'Meeting ' + code, code, emoji: '🎥', at: Date.now() });
  });
  haloPane.appendChild(haloBtn);

  /* ---- Real Zoom pane (shown when SDK keys are configured) ---- */
  const zoomPane = document.createElement('div');
  zoomPane.hidden = true;
  if (zoomCfg.enabled) {
    const me = store.get('identity');
    zoomPane.innerHTML = `
      <input class="search" data-z="mn" placeholder="Zoom meeting ID" inputmode="numeric" style="margin-bottom:10px">
      <input class="search" data-z="pw" placeholder="Passcode (if any)" style="margin-bottom:10px">
      <input class="search" data-z="name" placeholder="Display name" value="${escapeHtml(me.name)}" style="margin-bottom:14px">
      <p style="font-size:12px;color:var(--text-faint);margin:0 0 14px">Joins the real Zoom meeting via Zoom's official SDK. Halo filters/overlays apply in Halo rooms only.</p>`;
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'pill-btn'; zoomBtn.style.width = '100%'; zoomBtn.textContent = 'Join Zoom meeting';
    zoomBtn.addEventListener('click', async () => {
      const mn = zoomPane.querySelector('[data-z="mn"]').value.replace(/\D/g, '');
      if (!mn) { toast('Enter the Zoom meeting ID'); return; }
      const passcode = zoomPane.querySelector('[data-z="pw"]').value.trim();
      const userName = zoomPane.querySelector('[data-z="name"]').value.trim() || store.get('identity').name;
      closeSheet();
      await joinZoomFlow(mn, passcode, userName);
    });
    zoomPane.appendChild(zoomBtn);
  }

  if (zoomCfg.enabled) {
    const tabs = document.createElement('div');
    tabs.className = 'seg-tabs';
    tabs.innerHTML = `<button class="seg active" data-join-tab="halo">Halo room</button><button class="seg" data-join-tab="zoom">Zoom meeting</button>`;
    tabs.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-join-tab]');
      if (!seg) return;
      tabs.querySelectorAll('.seg').forEach(s => s.classList.toggle('active', s === seg));
      haloPane.hidden = seg.dataset.joinTab !== 'halo';
      zoomPane.hidden = seg.dataset.joinTab !== 'zoom';
    });
    wrap.appendChild(tabs);
  }

  wrap.append(haloPane, zoomPane);

  if (!zoomCfg.enabled) {
    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:12px;color:var(--text-faint);margin-top:14px';
    hint.textContent = 'Want to join real Zoom meetings from here? Add ZOOM_SDK_KEY & ZOOM_SDK_SECRET on the server (see README).';
    wrap.appendChild(hint);
  }

  openSheet('Join a meeting', wrap);
}

/* ---------------- Global action delegation ---------------- */
function initActions() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-tab]');
    if (!el) return;
    if (el.dataset.tab) { haptic(); setView(el.dataset.tab); return; }
    const action = el.dataset.action;
    switch (action) {
      case 'reroll-identity': store.rerollIdentity(); renderIdentity(); toast('New anonymous identity'); break;
      case 'toggle-preview-cam': togglePreviewCam(el); break;
      case 'open-studio': setView('studio'); break;
      case 'new-meeting': haptic(); startCall(); break;
      case 'join-meeting': joinMeetingPrompt(); break;
      case 'open-gifbank': openGifBank(); break;
      case 'open-browser': openBrowserWindowSafely(); break;
      case 'close-sheet': closeSheet(); break;
    }
  });
  $('#sheetScrim').addEventListener('click', closeSheet);
}

async function togglePreviewCam(btn) {
  const on = await media.toggleCamera();
  btn.textContent = on ? 'Stop camera' : 'Preview camera';
  updatePreviewFallback();
  syncStudioControls();
  if (on === false && typeof on !== 'boolean') toast('Camera unavailable');
}

function openBrowserWindowSafely() {
  // The browser lives on the call stage; open a call surface if none.
  if ($('#callSurface').hidden) {
    startCall().then(() => openBrowserWindow());
  } else {
    openBrowserWindow();
  }
}

/* ---------------- Boot ---------------- */
function boot() {
  renderIdentity();
  renderRecents();
  initStudio();
  initInbox();
  initCallControls();
  initActions();
  store.subscribe(() => { renderRecents(); updateBadge(); });

  media.onChange(() => { updatePreviewFallback(); syncStudioControls(); updateControlStates(); });

  pipeline.register(previewCanvas);
  pipeline.register(studioCanvas);
  pipeline.setActive(previewCanvas, true);
  pipeline.setActive(studioCanvas, false);

  setView('home');

  // Deep link: ?room=CODE drops straight into that Halo room, so an invite
  // link is one tap instead of "type these nine digits".
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    const code = roomParam.replace(/\s+/g, '');
    startCall({ title: 'Meeting ' + code, code, emoji: '🎥', at: Date.now() });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
