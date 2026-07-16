// AudioWorklet: captures mic samples and posts ~128ms Float32 chunks to the
// main thread, where they are converted to 16-bit PCM for the Live API.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      this.chunks.push(ch.slice());
      this.length += ch.length;
      if (this.length >= 2048) {
        const out = new Float32Array(this.length);
        let o = 0;
        for (const c of this.chunks) { out.set(c, o); o += c.length; }
        this.port.postMessage(out, [out.buffer]);
        this.chunks = [];
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);


