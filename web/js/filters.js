/* ============================================================
   Halo — filters.js
   Photobooth-style filters. Each filter is expressed as a CSS
   filter string (GPU-friendly, real-time on iPad) plus an
   optional compositing pass for the more stylised looks.
   ============================================================ */

export const FILTERS = [
  { id: 'none',     name: 'Normal',   thumb: '⚪️', css: 'none' },
  { id: 'mono',     name: 'Mono',     thumb: '⬛️', css: 'grayscale(1) contrast(1.05)' },
  { id: 'vivid',    name: 'Vivid',    thumb: '🌈', css: 'saturate(1.55) contrast(1.08)' },
  { id: 'noir',     name: 'Noir',     thumb: '🎩', css: 'grayscale(1) contrast(1.5) brightness(0.92)' },
  { id: 'warmglow', name: 'Warm',     thumb: '🌇', css: 'sepia(0.35) saturate(1.35) brightness(1.05)' },
  { id: 'cool',     name: 'Cool',     thumb: '❄️', css: 'saturate(1.2) hue-rotate(-12deg) brightness(1.03)' },
  { id: 'thermal',  name: 'Thermal',  thumb: '🔥', css: 'saturate(2.4) hue-rotate(90deg) contrast(1.6)' },
  { id: 'comic',    name: 'Comic',    thumb: '💥', css: 'saturate(2) contrast(1.7) brightness(1.05)', post: 'posterize' },
  { id: 'xray',     name: 'X-Ray',    thumb: '☠️', css: 'invert(1) grayscale(1) contrast(1.3)' },
  { id: 'dream',    name: 'Dream',    thumb: '💭', css: 'saturate(1.3) brightness(1.08) blur(0.6px)', post: 'bloom' },
  { id: 'retro',    name: 'Retro',    thumb: '📼', css: 'sepia(0.55) saturate(1.4) contrast(1.1) hue-rotate(-8deg)' },
  { id: 'pop',      name: 'Pop',      thumb: '🟣', css: 'saturate(1.8) hue-rotate(25deg) contrast(1.2)' },
  { id: 'glitch',   name: 'Glitch',   thumb: '📡', css: 'saturate(1.6) contrast(1.25)', post: 'glitch' },
  { id: 'ghost',    name: 'Ghost',    thumb: '👻', css: 'brightness(1.2) contrast(0.9) opacity(0.92)', post: 'bloom' },
];

export function filterById(id) {
  return FILTERS.find(f => f.id === id) || FILTERS[0];
}

/**
 * Build the combined CSS filter string from the selected filter plus the
 * numeric adjustment sliders (touch-up, low-light, warmth, vibrance).
 */
export function buildFilterString(effects) {
  const base = filterById(effects.filter).css;
  const parts = base && base !== 'none' ? [base] : [];

  // Touch up appearance: gentle brighten + soften + saturate.
  if (effects.touchup > 0) {
    const t = effects.touchup / 100;
    parts.push(`brightness(${(1 + t * 0.12).toFixed(3)})`);
    parts.push(`saturate(${(1 + t * 0.15).toFixed(3)})`);
    parts.push(`blur(${(t * 0.9).toFixed(2)}px)`);
  }

  // Low light: lift shadows via brightness + contrast.
  if (effects.lowlight > 0) {
    const l = effects.lowlight / 100;
    parts.push(`brightness(${(1 + l * 0.55).toFixed(3)})`);
    parts.push(`contrast(${(1 + l * 0.12).toFixed(3)})`);
    parts.push(`saturate(${(1 + l * 0.1).toFixed(3)})`);
  }

  // Warmth: positive = warmer (sepia), negative = cooler (hue shift).
  if (effects.warmth) {
    const w = effects.warmth / 100;
    if (w > 0) parts.push(`sepia(${(w * 0.6).toFixed(3)})`);
    else parts.push(`hue-rotate(${Math.round(w * 30)}deg)`);
  }

  // Vibrance.
  if (effects.vibrance > 0) {
    parts.push(`saturate(${(1 + effects.vibrance / 100 * 0.6).toFixed(3)})`);
  }

  return parts.length ? parts.join(' ') : 'none';
}
