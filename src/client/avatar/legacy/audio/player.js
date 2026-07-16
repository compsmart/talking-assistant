// Gapless streaming playback of 24kHz PCM chunks from the Live API.
// Chunks are scheduled back-to-back on the AudioContext clock; the schedule
// time of each chunk is returned so the lip sync engine can analyze audio
// ahead of when it becomes audible.

export class PcmPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.gain = null;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // samples: Float32Array. Returns the ctx-clock time the chunk will start.
  enqueue(samples) {
    const ctx = this.ensureContext();
    const buf = ctx.createBuffer(1, samples.length, this.sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const startAt = Math.max(ctx.currentTime + 0.06, this.nextTime);
    src.start(startAt);
    this.nextTime = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return startAt;
  }

  // Immediately stop everything queued (Live API "interrupted" signal).
  flush() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.nextTime = 0;
  }

  get time() { return this.ctx ? this.ctx.currentTime : 0; }
  get playing() { return this.ctx !== null && this.nextTime > this.ctx.currentTime && this.sources.size > 0; }
}


