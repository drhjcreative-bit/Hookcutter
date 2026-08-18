/* ============================================================
   Halo — media.js
   Camera + microphone lifecycle. One shared local stream drives
   the home preview, the studio, and the call self-tile. Handles
   front/back flip and graceful failure (no camera / denied).
   ============================================================ */

class Media {
  constructor() {
    this.stream = null;
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.autoplay = true;
    this.facing = 'user';
    this.camOn = false;
    this.micOn = true;
    this.listeners = new Set();
  }

  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) cb(this); }

  get ready() { return !!this.stream && this.camOn; }

  async start(facing = this.facing) {
    this.facing = facing;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      this._attach(stream);
      this.camOn = true;
      this.applyMic();
      this.emit();
      return true;
    } catch (err) {
      this.camOn = false;
      this.emit();
      return err && err.name ? err.name : 'error';
    }
  }

  _attach(stream) {
    this._stopTracks();
    this.stream = stream;
    this.video.srcObject = stream;
    const p = this.video.play();
    if (p && p.catch) p.catch(() => {});
  }

  _stopTracks() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
  }

  stopCamera() {
    this._stopTracks();
    this.video.srcObject = null;
    this.camOn = false;
    this.emit();
  }

  async toggleCamera() {
    if (this.camOn) { this.stopCamera(); return false; }
    await this.start();
    return this.camOn;
  }

  toggleMic() {
    this.micOn = !this.micOn;
    this.applyMic();
    this.emit();
    return this.micOn;
  }

  applyMic() {
    if (!this.stream) return;
    this.stream.getAudioTracks().forEach(t => { t.enabled = this.micOn; });
  }

  async flip() {
    if (!this.camOn) return;
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    await this.start(this.facing);
  }

  get frameSize() {
    return { w: this.video.videoWidth || 1280, h: this.video.videoHeight || 720 };
  }
}

export const media = new Media();
