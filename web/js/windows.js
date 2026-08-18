/* ============================================================
   Halo — windows.js
   Modular floating windows: draggable, resizable, minimisable.
   Used for the in-app browser and any panel you want to pop out
   over the call (chat, notes, etc.). Pointer-based so it works
   with touch on iPad and mouse on desktop.
   ============================================================ */

import { haptic } from './ui.js';

let z = 10;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function createWindow({ title = 'Window', body, x, y, w, h } = {}) {
  const layer = document.getElementById('windowsLayer');
  if (!layer) return null;

  const win = document.createElement('div');
  win.className = 'float-win';
  const stage = layer.getBoundingClientRect();
  const startW = w || Math.min(420, stage.width * 0.82);
  const startH = h || Math.min(460, stage.height * 0.55);
  win.style.width = startW + 'px';
  win.style.height = startH + 'px';
  win.style.left = (x ?? Math.max(8, (stage.width - startW) / 2)) + 'px';
  win.style.top = (y ?? Math.max(60, (stage.height - startH) / 3)) + 'px';
  win.style.zIndex = ++z;

  win.innerHTML = `
    <div class="win-head">
      <span class="win-dot close" data-win="close">✕</span>
      <span class="win-dot min" data-win="min"></span>
      <span class="win-dot max" data-win="max"></span>
      <span class="win-title">${title}</span>
    </div>
    <div class="win-body"></div>
    <div class="win-resize" data-win="resize"></div>
  `;
  const bodyEl = win.querySelector('.win-body');
  if (body instanceof Node) bodyEl.appendChild(body);

  layer.appendChild(win);
  win.addEventListener('pointerdown', () => { win.style.zIndex = ++z; }, true);

  // Controls
  win.querySelector('[data-win="close"]').addEventListener('click', () => { haptic(); win.remove(); });
  win.querySelector('[data-win="min"]').addEventListener('click', () => { haptic(); win.classList.toggle('minimized'); });
  win.querySelector('[data-win="max"]').addEventListener('click', () => {
    haptic();
    const s = layer.getBoundingClientRect();
    win.style.left = '6px'; win.style.top = '56px';
    win.style.width = (s.width - 12) + 'px';
    win.style.height = (s.height - 100) + 'px';
  });

  // Drag by header
  makeDraggable(win, win.querySelector('.win-head'), layer);
  // Resize by corner
  makeResizable(win, win.querySelector('[data-win="resize"]'), layer);

  return { el: win, body: bodyEl, close: () => win.remove() };
}

function makeDraggable(win, handle, layer) {
  let sx, sy, ox, oy, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.dataset.win) return; // ignore control dots
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY;
    ox = parseFloat(win.style.left); oy = parseFloat(win.style.top);
    handle.style.cursor = 'grabbing';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const s = layer.getBoundingClientRect();
    const nx = clamp(ox + (e.clientX - sx), 0, s.width - win.offsetWidth);
    const ny = clamp(oy + (e.clientY - sy), 0, s.height - 44);
    win.style.left = nx + 'px';
    win.style.top = ny + 'px';
  });
  const end = () => { dragging = false; handle.style.cursor = 'grab'; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function makeResizable(win, handle, layer) {
  let sx, sy, ow, oh, resizing = false;
  handle.addEventListener('pointerdown', (e) => {
    resizing = true;
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY;
    ow = win.offsetWidth; oh = win.offsetHeight;
  });
  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const s = layer.getBoundingClientRect();
    win.style.width = clamp(ow + (e.clientX - sx), 220, s.width - parseFloat(win.style.left)) + 'px';
    win.style.height = clamp(oh + (e.clientY - sy), 160, s.height - parseFloat(win.style.top)) + 'px';
  });
  const end = () => { resizing = false; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ---------- In-app browser ---------- */
export function openBrowserWindow(initialUrl = 'https://en.wikipedia.org/wiki/Videotelephony') {
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.height = '100%';
  body.innerHTML = `
    <div class="browser-bar">
      <input type="text" inputmode="url" placeholder="Search or enter address" />
      <button data-go>Go</button>
    </div>
    <div style="flex:1;position:relative;background:#fff">
      <iframe referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div>
  `;
  const input = body.querySelector('input');
  const iframe = body.querySelector('iframe');
  const goBtn = body.querySelector('[data-go]');

  const normalize = (raw) => {
    const s = raw.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w-]+(\.[\w-]+)+/.test(s) && !s.includes(' ')) return 'https://' + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  };
  const navigate = (raw) => {
    const url = normalize(raw);
    if (!url) return;
    input.value = url;
    iframe.src = url;
  };
  goBtn.addEventListener('click', () => navigate(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(input.value); });

  const win = createWindow({ title: 'Browser', body });
  navigate(initialUrl);
  return win;
}
