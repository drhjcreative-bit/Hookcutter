/* ============================================================
   Halo — identity.js
   Anonymous, throwaway identity. No accounts, no PII — a random
   handle + emoji avatar generated locally. Re-rollable so a user
   can shed a spammed identity instantly.
   ============================================================ */

const ADJ = ['Quiet', 'Neon', 'Velvet', 'Lunar', 'Amber', 'Cobalt', 'Silent',
  'Golden', 'Hazel', 'Crimson', 'Frost', 'Ivory', 'Onyx', 'Coral', 'Dusk',
  'Pixel', 'Echo', 'Solar', 'Nova', 'Mint', 'Violet', 'Slate'];
const NOUN = ['Fox', 'Heron', 'Comet', 'Otter', 'Falcon', 'Willow', 'Ember',
  'Sparrow', 'Koi', 'Lynx', 'Raven', 'Maple', 'Wren', 'Onyx', 'Sable',
  'Finch', 'Cove', 'Vale', 'Reef', 'Drift', 'Halo', 'Wisp'];
const AVATARS = ['🦊', '🐺', '🦉', '🐋', '🦅', '🐨', '🦋', '🐙', '🦩', '🦌',
  '🐢', '🦖', '🐬', '🦔', '🐝', '🦚', '🌙', '⭐️', '🔮', '🌵', '🍃', '🎈'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function makeIdentity() {
  const num = Math.floor(Math.random() * 900 + 100);
  return {
    name: `${pick(ADJ)} ${pick(NOUN)}`,
    handle: `anon-${num}`,
    avatar: pick(AVATARS),
    createdAt: Date.now(),
  };
}

/** A deterministic-ish avatar for simulated peers so tiles stay stable. */
export function peerIdentity(seed) {
  const a = ADJ[seed % ADJ.length];
  const n = NOUN[(seed * 7) % NOUN.length];
  return { name: `${a} ${n}`, avatar: AVATARS[(seed * 3) % AVATARS.length] };
}
