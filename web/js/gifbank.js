/* ============================================================
   Halo — gifbank.js
   A personal GIF bank stored in IndexedDB. Any image you upload
   (JPEG/PNG/etc.) is automatically encoded to a real animated-GIF
   container before it is saved, so the bank is always .gif. Also
   exposes a place to build your own bank and (optionally) pull
   from Tenor/Giphy if an API key is provided.
   ============================================================ */

import { imageToGif, GifEncoder } from './gif-encoder.js';
import { pipeline } from './pipeline.js';

const DB_NAME = 'halo-gifbank';
const STORE = 'gifs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

export async function listGifs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE).objectStore(STORE).openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteGif(id) {
  return tx('readwrite', (store) => store.delete(id));
}

async function saveGif(record) {
  await tx('readwrite', (store) => store.put(record));
  return record;
}

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/**
 * Import an image File. Always converts to GIF bytes first (even PNG/JPEG),
 * stores the .gif blob, and returns the saved record.
 */
export async function importImageAsGif(file) {
  const img = await decodeImage(file);
  const wasGif = file.type === 'image/gif';
  const bytes = imageToGif(img, 640);
  const blob = new Blob([bytes], { type: 'image/gif' });
  const record = {
    id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: file.name.replace(/\.[^.]+$/, '') || 'clip',
    blob,
    origin: wasGif ? 'gif' : 'converted',
    createdAt: Date.now(),
  };
  return saveGif(record);
}

/**
 * Capture a short animated GIF from the live processed camera feed.
 * frames drawn from the pipeline's current output.
 */
export async function captureLiveGif({ frames = 8, gap = 90 } = {}) {
  const first = pipeline.grabFrame();
  if (!first) throw new Error('no camera frame');
  const enc = new GifEncoder(first.w, first.h);
  enc.addFrame(first.data, { delay: gap });
  for (let i = 1; i < frames; i++) {
    await new Promise(r => setTimeout(r, gap));
    const f = pipeline.grabFrame();
    if (f && f.w === first.w && f.h === first.h) enc.addFrame(f.data, { delay: gap });
  }
  const blob = new Blob([enc.render()], { type: 'image/gif' });
  return saveGif({
    id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: 'live-' + new Date().toLocaleTimeString(),
    blob, origin: 'live', createdAt: Date.now(),
  });
}

/** Object URL cache so grids don't leak. */
const urlCache = new Map();
export function gifUrl(record) {
  if (!urlCache.has(record.id)) urlCache.set(record.id, URL.createObjectURL(record.blob));
  return urlCache.get(record.id);
}
export function revokeGifUrl(id) {
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}
