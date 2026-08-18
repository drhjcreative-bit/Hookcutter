/* ============================================================
   Halo — state.js
   A tiny observable store persisted to localStorage. Everything
   the app remembers between sessions lives here: identity, recent
   meetings, inbox conversations, and studio effect settings.
   GIFs live in IndexedDB (see gifbank.js) because they are large.
   ============================================================ */

import { makeIdentity } from './identity.js';

const KEY = 'halo.state.v1';

const DEFAULT_EFFECTS = {
  filter: 'none',
  overlay: 'none',
  touchup: 0,
  lowlight: 0,
  warmth: 0,
  vibrance: 0,
  autorotate: false,
  mirror: true,
};

function seedConversations() {
  const now = Date.now();
  const mk = (name, avatar, text, mins, unread = 0) => ({
    id: 'c' + Math.random().toString(36).slice(2, 9),
    name, avatar, unread,
    messages: [{ from: 'them', text, at: now - mins * 60000 }],
    updatedAt: now - mins * 60000,
  });
  return [
    mk('Neon Fox', '🦊', 'see you in the room 👋', 4, 2),
    mk('Studio Crew', '🎬', 'dropped the new overlay pack', 55, 0),
    mk('Lunar Otter', '🐨', 'that low-light fix is unreal', 180, 1),
  ];
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      parsed.effects = { ...DEFAULT_EFFECTS, ...(parsed.effects || {}) };
      return parsed;
    }
  } catch (_) {}
  return {
    identity: makeIdentity(),
    recents: [],
    conversations: seedConversations(),
    effects: { ...DEFAULT_EFFECTS },
  };
}

class Store {
  constructor() {
    this.data = load();
    this.listeners = new Set();
  }

  get(path) { return path ? this.data[path] : this.data; }

  set(patch) {
    Object.assign(this.data, patch);
    this.persist();
    this.emit();
  }

  update(fn) {
    fn(this.data);
    this.persist();
    this.emit();
  }

  subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) cb(this.data); }

  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (_) {}
  }

  /* ---- domain helpers ---- */
  rerollIdentity() { this.set({ identity: makeIdentity() }); }

  addRecent(meeting) {
    this.update((d) => {
      d.recents = [meeting, ...d.recents.filter(m => m.code !== meeting.code)].slice(0, 8);
    });
  }

  deleteConversation(id) {
    this.update((d) => { d.conversations = d.conversations.filter(c => c.id !== id); });
  }

  markConversationRead(id) {
    this.update((d) => {
      const c = d.conversations.find(x => x.id === id);
      if (c) c.unread = 0;
    });
  }

  setEffect(key, value) {
    this.update((d) => { d.effects[key] = value; });
  }

  resetEffects() { this.set({ effects: { ...DEFAULT_EFFECTS } }); }

  unreadCount() {
    return this.data.conversations.reduce((n, c) => n + (c.unread || 0), 0);
  }
}

export const store = new Store();
export { DEFAULT_EFFECTS };
