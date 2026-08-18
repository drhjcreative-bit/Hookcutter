/* ============================================================
   Halo — gif-encoder.js
   Dependency-free GIF89a encoder.
   - Median-cut colour quantisation (per frame, local colour table)
   - Standard GIF variable-length-code LZW compression
   - Multi-frame + Netscape looping support (single frame works too)

   Usage:
     const enc = new GifEncoder(w, h);        // dimensions in px
     enc.addFrame(rgba, { delay: 120 });      // rgba = Uint8ClampedArray (w*h*4)
     const bytes = enc.render();              // Uint8Array of a valid .gif
   ============================================================ */

/* ---------- Median-cut quantiser ---------- */
function quantize(rgba, maxColors = 256) {
  // Build a histogram in RGB555 space to keep median-cut fast.
  const hist = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] >> 3, g = rgba[i + 1] >> 3, b = rgba[i + 2] >> 3;
    const key = (r << 10) | (g << 5) | b;
    hist.set(key, (hist.get(key) || 0) + 1);
  }

  // Unique colours as {r,g,b,count} in full 8-bit space (centre of the 555 cell).
  const colors = [];
  for (const [key, count] of hist) {
    const r = ((key >> 10) & 31) << 3;
    const g = ((key >> 5) & 31) << 3;
    const b = (key & 31) << 3;
    colors.push({ r: r | 4, g: g | 4, b: b | 4, count });
  }

  if (colors.length <= maxColors) {
    return buildPalette(colors, hist);
  }

  // Median cut.
  let boxes = [makeBox(colors)];
  while (boxes.length < maxColors) {
    // Split the box with the largest weighted colour range.
    let target = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.colors.length < 2) continue;
      const score = b.range * b.count;
      if (score > bestScore) { bestScore = score; target = i; }
    }
    if (target === -1) break;

    const box = boxes[target];
    const ch = box.widestChannel;
    box.colors.sort((a, z) => a[ch] - z[ch]);
    // Split at the weighted median.
    const half = box.count / 2;
    let acc = 0, split = 0;
    for (; split < box.colors.length - 1; split++) {
      acc += box.colors[split].count;
      if (acc >= half) break;
    }
    const left = makeBox(box.colors.slice(0, split + 1));
    const right = makeBox(box.colors.slice(split + 1));
    boxes.splice(target, 1, left, right);
  }

  const palette = boxes.map(avgColor);
  return finalize(palette, hist);
}

function makeBox(colors) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, count = 0;
  for (const c of colors) {
    if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
    if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
    if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
    count += c.count;
  }
  const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
  const range = Math.max(dr, dg, db);
  const widestChannel = dr >= dg && dr >= db ? 'r' : dg >= db ? 'g' : 'b';
  return { colors, count, range, widestChannel };
}

function avgColor(box) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const c of box.colors) { r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; n += c.count; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function buildPalette(colors, hist) {
  const palette = colors.map(c => [c.r, c.g, c.b]);
  return finalize(palette, hist);
}

// Map every histogram colour to its nearest palette entry, then return a
// closure that maps a full-res pixel to a palette index (cached by RGB555).
function finalize(palette, hist) {
  const cache = new Map();
  const nearest = (r, g, b) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const indexOf = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache.get(key);
    if (idx === undefined) { idx = nearest(r, g, b); cache.set(key, idx); }
    return idx;
  };
  return { palette, indexOf };
}

/* ---------- LZW compression (GIF flavour) ---------- */
function lzwEncode(minCodeSize, indices) {
  const out = [];
  const bitBuf = new BitWriter(out);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  bitBuf.write(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prefix * 4096 + k; // unique key for (prefix,k)
    if (dict.has(combined)) {
      prefix = dict.get(combined);
    } else {
      bitBuf.write(prefix, codeSize);
      if (nextCode < 4096) {
        dict.set(combined, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        // Table full — reset.
        bitBuf.write(clearCode, codeSize);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
  }
  bitBuf.write(prefix, codeSize);
  bitBuf.write(eoiCode, codeSize);
  bitBuf.flush();
  return out;
}

// Packs codes LSB-first into a flat byte array.
class BitWriter {
  constructor(out) { this.out = out; this.cur = 0; this.bits = 0; }
  write(code, size) {
    this.cur |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.out.push(this.cur & 0xff);
      this.cur >>= 8;
      this.bits -= 8;
    }
  }
  flush() {
    if (this.bits > 0) { this.out.push(this.cur & 0xff); this.cur = 0; this.bits = 0; }
  }
}

/* ---------- Byte stream builder ---------- */
class ByteStream {
  constructor() { this.bytes = []; }
  byte(b) { this.bytes.push(b & 0xff); }
  bytesArr(arr) { for (const b of arr) this.bytes.push(b & 0xff); }
  short(s) { this.bytes.push(s & 0xff, (s >> 8) & 0xff); }
  str(s) { for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i)); }
  // Split a byte array into GIF sub-blocks (<=255 bytes each) terminated by 0x00.
  subBlocks(data) {
    let p = 0;
    while (p < data.length) {
      const n = Math.min(255, data.length - p);
      this.byte(n);
      for (let i = 0; i < n; i++) this.byte(data[p + i]);
      p += n;
    }
    this.byte(0);
  }
  finish() { return new Uint8Array(this.bytes); }
}

/* ---------- Encoder ---------- */
export class GifEncoder {
  constructor(width, height, { loop = 0 } = {}) {
    this.width = width | 0;
    this.height = height | 0;
    this.loop = loop; // 0 = forever
    this.frames = [];
  }

  /** rgba: Uint8ClampedArray|Uint8Array length w*h*4. delay in ms. */
  addFrame(rgba, { delay = 100 } = {}) {
    const q = quantize(rgba, 256);
    const n = this.width * this.height;
    const indices = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      indices[i] = q.indexOf(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    this.frames.push({ palette: q.palette, indices, delay });
    return this;
  }

  render() {
    const s = new ByteStream();
    // Header
    s.str('GIF89a');
    // Logical screen descriptor (no global colour table)
    s.short(this.width);
    s.short(this.height);
    s.byte(0x70); // no GCT, colour resolution
    s.byte(0);    // background colour index
    s.byte(0);    // pixel aspect ratio

    // Netscape looping extension (only needed for >1 frame)
    if (this.frames.length > 1) {
      s.byte(0x21); s.byte(0xff); s.byte(0x0b);
      s.str('NETSCAPE2.0');
      s.byte(0x03); s.byte(0x01);
      s.short(this.loop);
      s.byte(0x00);
    }

    for (const frame of this.frames) {
      // Pad palette to a power of two.
      let tableSize = 2;
      while (tableSize < frame.palette.length) tableSize <<= 1;
      const minCodeSize = Math.max(2, Math.log2(tableSize) | 0);
      const gctBits = minCodeSize - 1; // field encodes size as 2^(n+1)

      // Graphics control extension (delay + no transparency)
      s.byte(0x21); s.byte(0xf9); s.byte(0x04);
      s.byte(0x00); // no disposal, no transparency
      s.short(Math.max(2, Math.round(frame.delay / 10))); // 1/100s
      s.byte(0x00); // transparent colour index (unused)
      s.byte(0x00); // block terminator

      // Image descriptor
      s.byte(0x2c);
      s.short(0); s.short(0);
      s.short(this.width); s.short(this.height);
      s.byte(0x80 | gctBits); // local colour table, size

      // Local colour table
      for (let i = 0; i < tableSize; i++) {
        const c = frame.palette[i] || [0, 0, 0];
        s.byte(c[0]); s.byte(c[1]); s.byte(c[2]);
      }

      // LZW image data
      s.byte(minCodeSize);
      const compressed = lzwEncode(minCodeSize, frame.indices);
      s.subBlocks(compressed);
    }

    s.byte(0x3b); // trailer
    return s.finish();
  }
}

/**
 * Convenience: convert an ImageBitmap-like source drawn on a canvas to GIF bytes.
 * Accepts a canvas/HTMLImageElement, returns Uint8Array of a single-frame GIF.
 */
export function imageToGif(source, maxDim = 640) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const enc = new GifEncoder(w, h);
  enc.addFrame(data, { delay: 100 });
  return enc.render();
}
