/* ============================================================
   Halo — inbox.js
   Conversation list with swipe-to-delete and an Edit mode, plus a
   lightweight chat view (sheet) that can send text and GIFs from
   the bank. Conversations persist in the store; deleting one
   removes it immediately and permanently.
   ============================================================ */

import { store } from './state.js';
import { openSheet, closeSheet, haptic, toast, escapeHtml } from './ui.js';
import { listGifs, gifUrl } from './gifbank.js';

let editMode = false;
let filter = '';

export function initInbox() {
  const search = document.getElementById('inboxSearch');
  if (search) {
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); render(); });
  }
  const editBtn = document.querySelector('[data-action="inbox-edit"]');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      editMode = !editMode;
      editBtn.textContent = editMode ? 'Done' : 'Edit';
      render();
    });
  }
  store.subscribe(() => { render(); updateBadge(); });
  render();
  updateBadge();
}

export function updateBadge() {
  const badge = document.getElementById('inboxBadge');
  if (!badge) return;
  const n = store.unreadCount();
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

function render() {
  const list = document.getElementById('convoList');
  const empty = document.getElementById('inboxEmpty');
  if (!list) return;
  const convos = store.get('conversations')
    .filter(c => !filter || c.name.toLowerCase().includes(filter))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  list.innerHTML = '';
  empty.hidden = convos.length > 0;

  for (const c of convos) {
    list.appendChild(row(c));
  }
}

function row(c) {
  const li = document.createElement('li');
  li.style.position = 'relative';
  li.style.overflow = 'hidden';
  li.style.borderRadius = 'var(--r-md)';

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.style.cssText = 'position:absolute;top:0;right:0;height:100%;width:88px;background:var(--red);color:#fff;font-weight:700;border-radius:var(--r-md)';
  del.addEventListener('click', () => removeConvo(c));
  li.appendChild(del);

  const last = c.messages[c.messages.length - 1];
  const surface = document.createElement('div');
  surface.className = 'list-row';
  surface.style.background = 'var(--bg)';
  surface.style.position = 'relative';
  surface.style.transition = 'transform 0.22s var(--ease)';
  surface.innerHTML = `
    ${editMode ? '<span style="color:var(--red);font-size:22px;margin-right:2px">⊖</span>' : ''}
    <div class="avatar">${c.avatar}</div>
    <div class="row-main">
      <div class="row-title">${escapeHtml(c.name)}</div>
      <div class="row-sub">${escapeHtml(last ? (last.gif ? 'GIF' : last.text) : '')}</div>
    </div>
    <div class="row-meta">${timeAgo(c.updatedAt)}${c.unread ? `<div style="margin-top:4px"><span style="display:inline-block;min-width:18px;height:18px;line-height:18px;background:var(--accent);color:#fff;border-radius:9px;font-size:11px;font-weight:700">${c.unread}</span></div>` : ''}</div>
  `;

  if (editMode) {
    surface.querySelector('span').addEventListener('click', (e) => { e.stopPropagation(); removeConvo(c); });
  }

  // swipe to reveal delete
  attachSwipe(surface, del.offsetWidth || 88, () => openChat(c));
  li.appendChild(surface);
  return li;
}

function attachSwipe(surface, revealW, onTap) {
  let startX = 0, curX = 0, dragging = false, open = false, moved = false;
  const W = 88;
  surface.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false;
    startX = e.clientX; curX = open ? -W : 0;
    surface.style.transition = 'none';
    surface.setPointerCapture(e.pointerId);
  });
  surface.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let dx = e.clientX - startX + (open ? -W : 0);
    if (Math.abs(e.clientX - startX) > 6) moved = true;
    dx = Math.max(-W, Math.min(0, dx));
    curX = dx;
    surface.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    surface.style.transition = 'transform 0.22s var(--ease)';
    open = curX < -W / 2;
    surface.style.transform = `translateX(${open ? -W : 0}px)`;
  };
  surface.addEventListener('pointerup', (e) => {
    const wasMoved = moved;
    end();
    if (!wasMoved && !open) onTap();
  });
  surface.addEventListener('pointercancel', end);
}

function removeConvo(c) {
  haptic(14);
  store.deleteConversation(c.id);
  toast('Conversation deleted');
}

function openChat(c) {
  store.markConversationRead(c.id);
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.height = '68vh';

  const log = document.createElement('div');
  log.className = 'chat-log';
  log.style.flex = '1';
  log.style.overflowY = 'auto';

  const paint = () => {
    log.innerHTML = c.messages.map(m => {
      const cls = m.from === 'me' ? 'me' : 'them';
      const inner = m.gif ? `<img src="${m.gif}" alt="gif">` : escapeHtml(m.text);
      return `<div class="chat-msg ${cls}">${cls === 'them' ? `<div class="chat-author">${escapeHtml(c.name)}</div>` : ''}${inner}</div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  };
  paint();

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  inputRow.innerHTML = `
    <button class="chat-send" data-gif style="background:var(--bg-elev-2);color:var(--text)">GIF</button>
    <input type="text" placeholder="Message" />
    <button class="chat-send" data-send>➤</button>
  `;
  const input = inputRow.querySelector('input');
  const send = (msg) => {
    c.messages.push(msg);
    c.updatedAt = Date.now();
    store.persist(); store.emit();
    paint();
  };
  inputRow.querySelector('[data-send]').addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) return;
    send({ from: 'me', text: v, at: Date.now() });
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value.trim(); if (v) { send({ from: 'me', text: v, at: Date.now() }); input.value = ''; } }
  });
  inputRow.querySelector('[data-gif]').addEventListener('click', async () => {
    const gifs = await listGifs();
    if (!gifs.length) { toast('Your GIF bank is empty'); return; }
    const picker = document.createElement('div');
    picker.className = 'gif-grid';
    gifs.slice(0, 12).forEach(g => {
      const cell = document.createElement('div');
      cell.className = 'gif-cell';
      cell.innerHTML = `<img src="${gifUrl(g)}" alt="${escapeHtml(g.name)}">`;
      cell.addEventListener('click', () => { send({ from: 'me', gif: gifUrl(g), at: Date.now() }); closeSheet(); openChat(c); });
      picker.appendChild(cell);
    });
    openSheet('Send a GIF', picker);
  });

  wrap.appendChild(log);
  wrap.appendChild(inputRow);
  openSheet(c.name, wrap);
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
