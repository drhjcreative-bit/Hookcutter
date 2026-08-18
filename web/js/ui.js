/* ============================================================
   Halo — ui.js
   Small, shared UI primitives: toasts, the bottom sheet, and a
   haptic tap helper. Kept dependency-free and framework-free.
   ============================================================ */

const toastHost = () => document.getElementById('toastHost');

export function toast(message, ms = 2000) {
  const host = toastHost();
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

/** Light haptic on supported devices (iOS Safari ignores silently). */
export function haptic(pattern = 8) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (_) {} }
}

/* ---------- Bottom sheet ---------- */
const sheet = () => document.getElementById('sheet');
const scrim = () => document.getElementById('sheetScrim');
const sheetTitle = () => document.getElementById('sheetTitle');
const sheetBody = () => document.getElementById('sheetBody');

let onCloseCb = null;

export function openSheet(title, buildBody, onClose = null) {
  sheetTitle().textContent = title;
  const body = sheetBody();
  body.innerHTML = '';
  if (typeof buildBody === 'string') body.innerHTML = buildBody;
  else if (buildBody instanceof Node) body.appendChild(buildBody);
  else if (typeof buildBody === 'function') buildBody(body);
  onCloseCb = onClose;
  scrim().hidden = false;
  sheet().hidden = false;
  haptic(10);
}

export function closeSheet() {
  const s = sheet();
  if (s.hidden) return;
  s.hidden = true;
  scrim().hidden = true;
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
}

/** Build a simple action-list node for use inside a sheet. */
export function actionList(actions) {
  const frag = document.createDocumentFragment();
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'sheet-action' + (a.danger ? ' danger' : '');
    btn.innerHTML = `<span class="sa-ic">${a.icon || ''}</span><span>${a.label}</span>`;
    btn.addEventListener('click', () => { haptic(); a.onClick && a.onClick(); });
    frag.appendChild(btn);
  }
  return frag;
}

export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
