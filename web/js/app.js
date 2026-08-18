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

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const app = $('#app');
const previewCanvas = $('#previewCanvas');
const studioCanvas = $('#studioCanvas');

let callTimer = null;

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

  participants.start(3);

  // timer
  const t0 = Date.now();
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  haptic(20);
}

function leaveCall() {
  clearInterval(callTimer);
  participants.stop();
  $('#windowsLayer').innerHTML = '';
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
    toast(on ? 'Unmuted' : 'Muted');
  });
  $('[data-ctrl="cam"]').addEventListener('click', async () => {
    await media.toggleCamera();
    updateControlStates();
    participants.render();
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

function openCallChat() {
  const c = { id: 'call', name: 'In‑meeting chat', avatar: '💬', messages: window.__callMsgs || (window.__callMsgs = []) };
  import('./inbox.js'); // ensure module warm
  // reuse a simple inline chat
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:64vh';
  const log = document.createElement('div');
  log.className = 'chat-log'; log.style.cssText = 'flex:1;overflow-y:auto';
  const paint = () => {
    log.innerHTML = c.messages.map(m => `<div class="chat-msg ${m.from === 'me' ? 'me' : 'them'}">${m.gif ? `<img src="${m.gif}">` : escapeHtml(m.text)}</div>`).join('') || '<p style="color:var(--text-faint);text-align:center;padding:30px">No messages yet</p>';
    log.scrollTop = log.scrollHeight;
  };
  paint();
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  inputRow.innerHTML = `<button class="chat-send" data-gif style="background:var(--bg-elev-2);color:var(--text)">GIF</button><input placeholder="Message everyone"><button class="chat-send" data-send>➤</button>`;
  const input = inputRow.querySelector('input');
  const send = (msg) => { c.messages.push(msg); paint(); };
  inputRow.querySelector('[data-send]').addEventListener('click', () => { const v = input.value.trim(); if (v) { send({ from: 'me', text: v }); input.value = ''; } });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) { send({ from: 'me', text: v }); input.value = ''; } } });
  inputRow.querySelector('[data-gif]').addEventListener('click', async () => {
    const gifs = await listGifs();
    if (!gifs.length) return toast('GIF bank is empty');
    const picker = document.createElement('div'); picker.className = 'gif-grid';
    gifs.slice(0, 12).forEach(g => { const cell = document.createElement('div'); cell.className = 'gif-cell'; cell.innerHTML = `<img src="${gifUrl(g)}">`; cell.addEventListener('click', () => { send({ from: 'me', gif: gifUrl(g) }); closeSheet(); openCallChat(); }); picker.appendChild(cell); });
    openSheet('Send a GIF', picker);
  });
  wrap.append(log, inputRow);
  openSheet('Chat', wrap);
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

function joinMeetingPrompt() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<input class="search" id="joinCode" placeholder="Enter meeting code" inputmode="numeric" style="margin-bottom:14px">`;
  const btn = document.createElement('button');
  btn.className = 'pill-btn'; btn.style.width = '100%'; btn.textContent = 'Join meeting';
  btn.addEventListener('click', () => {
    const code = $('#joinCode', wrap).value.trim() || genCode();
    closeSheet();
    startCall({ title: 'Meeting ' + code, code, emoji: '🎥', at: Date.now() });
  });
  wrap.appendChild(btn);
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
