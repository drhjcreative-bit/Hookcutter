/* ============================================================
   Halo — overlays.js
   Snapchat-style overlays drawn onto the render canvas each frame.
   Two kinds:
     - 'sticker'  emoji/graphic anchored to the upper face area
     - 'frame'    a decorative border / vignette across the tile
   Face-anchored stickers use a light centre-weighted placement
   (no heavyweight face-tracking dependency, so it stays fast and
   private). Placement can be nudged in the studio.
   ============================================================ */

export const OVERLAYS = [
  { id: 'none',    name: 'None',    thumb: '🚫', kind: 'none' },
  { id: 'shades',  name: 'Shades',  thumb: '🕶', kind: 'sticker', glyph: '🕶', y: 0.34, scale: 0.42 },
  { id: 'crown',   name: 'Crown',   thumb: '👑', kind: 'sticker', glyph: '👑', y: 0.12, scale: 0.34 },
  { id: 'ears',    name: 'Ears',    thumb: '🐱', kind: 'sticker', glyph: '🐱', y: 0.1,  scale: 0.5 },
  { id: 'hearts',  name: 'Hearts',  thumb: '💕', kind: 'sticker', glyph: '💕', y: 0.28, scale: 0.3, anim: 'float' },
  { id: 'sparkle', name: 'Sparkle', thumb: '✨', kind: 'sticker', glyph: '✨', y: 0.2,  scale: 0.28, anim: 'twinkle' },
  { id: 'flower',  name: 'Bloom',   thumb: '🌸', kind: 'sticker', glyph: '🌸', y: 0.08, scale: 0.3 },
  { id: 'film',    name: 'Film',    thumb: '🎞', kind: 'frame', style: 'film' },
  { id: 'vignette',name: 'Vignette',thumb: '⬮',  kind: 'frame', style: 'vignette' },
  { id: 'neon',    name: 'Neon',    thumb: '🟪', kind: 'frame', style: 'neon' },
];

export function overlayById(id) {
  return OVERLAYS.find(o => o.id === id) || OVERLAYS[0];
}

/**
 * Draw the active overlay onto ctx (already holding the video frame).
 * @param nudge {x,y} normalised offset applied to stickers (studio drag).
 * @param t     animation time in ms.
 */
export function drawOverlay(ctx, overlay, w, h, t = 0, nudge = { x: 0, y: 0 }) {
  if (!overlay || overlay.kind === 'none') return;

  if (overlay.kind === 'sticker') {
    const size = Math.min(w, h) * overlay.scale;
    let cx = w / 2 + nudge.x * w;
    let cy = h * overlay.y + nudge.y * h;
    let alpha = 1;
    if (overlay.anim === 'float') cy += Math.sin(t / 500) * h * 0.02;
    if (overlay.anim === 'twinkle') alpha = 0.55 + 0.45 * Math.abs(Math.sin(t / 400));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(overlay.glyph, cx, cy);
    // A second, smaller accent for the animated ones.
    if (overlay.anim) {
      ctx.globalAlpha = alpha * 0.6;
      ctx.font = `${size * 0.5}px system-ui, "Apple Color Emoji", sans-serif`;
      ctx.fillText(overlay.glyph, cx + w * 0.16, cy - h * 0.05);
      ctx.fillText(overlay.glyph, cx - w * 0.16, cy + h * 0.03);
    }
    ctx.restore();
    return;
  }

  if (overlay.kind === 'frame') {
    ctx.save();
    if (overlay.style === 'vignette' || overlay.style === 'film') {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, overlay.style === 'film' ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (overlay.style === 'film') {
      // Sprocket bars.
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      const bar = h * 0.06;
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const hole = bar * 0.4;
      for (let x = hole; x < w; x += hole * 2.4) {
        ctx.fillRect(x, bar * 0.3, hole, bar * 0.4);
        ctx.fillRect(x, h - bar + bar * 0.3, hole, bar * 0.4);
      }
    }
    if (overlay.style === 'neon') {
      const lw = Math.min(w, h) * 0.03;
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(160,107,255,0.9)';
      ctx.shadowColor = 'rgba(108,140,255,0.9)';
      ctx.shadowBlur = lw * 2;
      ctx.strokeRect(lw / 2, lw / 2, w - lw, h - lw);
    }
    ctx.restore();
  }
}
