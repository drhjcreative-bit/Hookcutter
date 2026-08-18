/* ============================================================
   Halo — pipeline.js
   The real-time render engine. A single rAF loop processes the
   local camera once per frame into an offscreen canvas (filters,
   touch-up, low-light, warmth, vibrance, overlay, auto-rotation,
   mirror, post-effects) then blits the result to every visible
   target canvas (home preview, studio, call self-tile).
   ============================================================ */

import { media } from './media.js';
import { store } from './state.js';
import { buildFilterString, filterById } from './filters.js';
import { drawOverlay, overlayById } from './overlays.js';

class Pipeline {
  constructor() {
    this.targets = new Map();       // canvas -> { active }
    this.offscreen = document.createElement('canvas');
    this.octx = this.offscreen.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.overlayNudge = { x: 0, y: 0 };
    this.broadcastCanvas = null;    // fixed-size canvas fed to captureStream()
    this._loop = this._loop.bind(this);
  }

  register(canvas) {
    if (!this.targets.has(canvas)) this.targets.set(canvas, { active: true });
    this.ensureRunning();
    return () => this.targets.delete(canvas);
  }

  setActive(canvas, active) {
    const t = this.targets.get(canvas);
    if (t) t.active = active;
  }

  ensureRunning() {
    if (!this.running) { this.running = true; requestAnimationFrame(this._loop); }
  }

  orientationAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  _loop(t) {
    if (!this.running) return;
    requestAnimationFrame(this._loop);

    const anyActive = [...this.targets.values()].some(x => x.active) || !!this.broadcastCanvas;
    if (!anyActive) return;

    const v = media.video;
    const ready = media.ready && v.readyState >= 2 && v.videoWidth;

    if (!ready) {
      // Camera off: keep the broadcast track alive with a placeholder so
      // remote peers see a "camera off" tile instead of a frozen frame.
      if (this.broadcastCanvas) this._paintPlaceholder(this.broadcastCanvas);
      return;
    }

    const effects = store.get('effects');
    this._renderOffscreen(v, effects, t);

    for (const [canvas, meta] of this.targets) {
      if (meta.active) this._blit(canvas);
    }
    if (this.broadcastCanvas) this._blitFixed(this.broadcastCanvas);
  }

  _paintPlaceholder(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0c0c12';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#6a6a76';
    ctx.font = `${Math.round(h * 0.18)}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📷', w / 2, h / 2);
  }

  // Blit the processed offscreen into a fixed-size canvas (cover-fit),
  // ignoring layout size — used for the captureStream broadcast canvas.
  _blitFixed(canvas) {
    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    const ow = this.offscreen.width, oh = this.offscreen.height;
    if (!ow || !oh) return;
    const sAsp = ow / oh, dAsp = cw / ch;
    let sx = 0, sy = 0, sWidth = ow, sHeight = oh;
    if (sAsp > dAsp) { sWidth = oh * dAsp; sx = (ow - sWidth) / 2; }
    else { sHeight = ow / dAsp; sy = (oh - sHeight) / 2; }
    ctx.drawImage(this.offscreen, sx, sy, sWidth, sHeight, 0, 0, cw, ch);
  }

  /**
   * Build an outgoing MediaStream: the processed video (via a fixed-size
   * canvas captureStream) plus the given audio tracks. Used for WebRTC.
   */
  getBroadcastStream({ fps = 30, audioTracks = [] } = {}) {
    if (!this.broadcastCanvas) {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      this.broadcastCanvas = c;
      this._paintPlaceholder(c);
    }
    this.ensureRunning();
    const stream = this.broadcastCanvas.captureStream(fps);
    for (const track of audioTracks) stream.addTrack(track);
    return stream;
  }

  stopBroadcast() { this.broadcastCanvas = null; }

  _renderOffscreen(v, effects, t) {
    let vw = v.videoWidth, vh = v.videoHeight;
    const angle = effects.autorotate ? this.orientationAngle() : 0;
    const rotated = angle === 90 || angle === 270;

    const long = 560;
    const scale = long / Math.max(vw, vh);
    let ow = Math.round(vw * scale), oh = Math.round(vh * scale);
    if (rotated) { const s = ow; ow = oh; oh = s; }

    if (this.offscreen.width !== ow || this.offscreen.height !== oh) {
      this.offscreen.width = ow; this.offscreen.height = oh;
    }
    const ctx = this.octx;
    ctx.save();
    ctx.clearRect(0, 0, ow, oh);

    ctx.filter = buildFilterString(effects);

    // Transform: centre origin, apply rotation + mirror, then draw the video
    // sized to cover the (possibly rotated) canvas.
    ctx.translate(ow / 2, oh / 2);
    if (angle) ctx.rotate((-angle * Math.PI) / 180);
    if (effects.mirror) ctx.scale(-1, 1);

    const drawW = rotated ? oh : ow;
    const drawH = rotated ? ow : oh;
    // cover fit
    const sAsp = vw / vh, dAsp = drawW / drawH;
    let sx = 0, sy = 0, sWidth = vw, sHeight = vh;
    if (sAsp > dAsp) { sWidth = vh * dAsp; sx = (vw - sWidth) / 2; }
    else { sHeight = vw / dAsp; sy = (vh - sHeight) / 2; }
    ctx.drawImage(v, sx, sy, sWidth, sHeight, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    ctx.filter = 'none';

    // Post-effects operate in un-rotated screen space.
    const fdef = filterById(effects.filter);
    if (fdef.post) this._post(ctx, fdef.post, ow, oh, t);

    // Overlay on top.
    const overlay = overlayById(effects.overlay);
    drawOverlay(ctx, overlay, ow, oh, t, this.overlayNudge);
  }

  _post(ctx, kind, w, h, t) {
    if (kind === 'posterize') {
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      const levels = 5, step = 255 / (levels - 1);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.round(d[i] / step) * step;
        d[i + 1] = Math.round(d[i + 1] / step) * step;
        d[i + 2] = Math.round(d[i + 2] / step) * step;
      }
      ctx.putImageData(img, 0, 0);
    } else if (kind === 'bloom') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35;
      ctx.filter = 'blur(6px) brightness(1.3)';
      ctx.drawImage(this.offscreen, 0, 0, w, h);
      ctx.restore();
    } else if (kind === 'glitch') {
      const slices = 5;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < slices; i++) {
        const sy = Math.floor((Math.sin(t / 120 + i) * 0.5 + 0.5) * (h - h / slices));
        const sh = h / slices / 2;
        const dx = Math.sin(t / 90 + i * 2) * w * 0.03;
        ctx.globalAlpha = 0.5;
        ctx.drawImage(this.offscreen, 0, sy, w, sh, dx, sy, w, sh);
      }
      ctx.restore();
    }
  }

  _blit(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const ctx = canvas.getContext('2d');
    const ow = this.offscreen.width, oh = this.offscreen.height;
    if (!ow || !oh) return;
    // cover
    const sAsp = ow / oh, dAsp = cw / ch;
    let sx = 0, sy = 0, sWidth = ow, sHeight = oh;
    if (sAsp > dAsp) { sWidth = oh * dAsp; sx = (ow - sWidth) / 2; }
    else { sHeight = ow / dAsp; sy = (oh - sHeight) / 2; }
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.offscreen, sx, sy, sWidth, sHeight, 0, 0, cw, ch);
  }

  /** Grab the current processed frame as RGBA for GIF capture etc. */
  grabFrame() {
    const w = this.offscreen.width, h = this.offscreen.height;
    if (!w || !h) return null;
    return { w, h, data: this.octx.getImageData(0, 0, w, h).data };
  }
}

export const pipeline = new Pipeline();
