// Predictive lip sync. PCM chunks are analyzed the moment they arrive from
// the network -- before they are audible -- so the mouth-shape timeline
// exists ahead of playback. This enables things reactive approaches cannot
// do, like closing the lips *before* a plosive burst (m/b/p).
//
// Features per 10.7ms hop (512-sample hann window, 24kHz):
//   RMS energy, spectral centroid, band energies
// mapped heuristically onto continuous mouth channels:
//   jawOpen, lipPucker, lipWide, lipPress, upperLipUp

const FFT_N = 512;
const HOP = 256;

// in-place iterative radix-2 FFT (re/im arrays of length FFT_N)
function fft(re, im) {
  const n = FFT_N;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const HANN = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class LipSync {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.frames = []; // { t, jawOpen, lipPucker, lipWide, lipPress, upperLipUp, energy } sorted by t
    this.tail = new Float32Array(0); // carry-over samples between chunks
    this.tailTime = 0;
    this.peak = 0.08; // adaptive gain reference
    this.re = new Float32Array(FFT_N);
    this.im = new Float32Array(FFT_N);
    // smoothing state (per-channel envelope followers)
    this.state = { jawOpen: 0, lipPucker: 0, lipWide: 0, lipPress: 0, upperLipUp: 0, energy: 0 };
  }

  clear() {
    this.frames.length = 0;
    this.tail = new Float32Array(0);
  }

  // samples scheduled to start playing at ctx-clock time startTime
  feed(samples, startTime) {
    const sr = this.sampleRate;
    let buf, t0;
    if (this.tail.length > 0 && Math.abs(this.tailTime + this.tail.length / sr - startTime) < 0.02) {
      buf = new Float32Array(this.tail.length + samples.length);
      buf.set(this.tail); buf.set(samples, this.tail.length);
      t0 = this.tailTime;
    } else {
      buf = samples; t0 = startTime;
    }

    let i = 0;
    for (; i + FFT_N <= buf.length; i += HOP) {
      const t = t0 + (i + FFT_N * 0.5) / sr;
      this.#analyze(buf, i, t);
    }
    // keep unanalyzed remainder for the next chunk
    this.tail = buf.slice(i);
    this.tailTime = t0 + i / sr;

    // prune frames older than 5s
    const cutoff = t0 - 5;
    if (this.frames.length > 800) {
      let k = 0;
      while (k < this.frames.length && this.frames[k].t < cutoff) k++;
      if (k > 0) this.frames.splice(0, k);
    }
  }

  #analyze(buf, off, t) {
    const { re, im } = this;
    let rms = 0;
    for (let i = 0; i < FFT_N; i++) {
      const s = buf[off + i];
      re[i] = s * HANN[i];
      im[i] = 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / FFT_N);
    this.peak = Math.max(this.peak * 0.9995, rms, 0.03);
    const en = clamp01(rms / this.peak);

    fft(re, im);

    const binHz = this.sampleRate / FFT_N; // 46.875 Hz
    const bandEdges = [80, 300, 800, 2500, 5500, 11000];
    const bands = [0, 0, 0, 0, 0];
    let centroid = 0, total = 1e-9;
    const half = FFT_N / 2;
    for (let k = 1; k < half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const hz = k * binHz;
      centroid += mag * hz;
      total += mag;
      for (let b = 0; b < 5; b++) {
        if (hz >= bandEdges[b] && hz < bandEdges[b + 1]) { bands[b] += mag; break; }
      }
    }
    centroid /= total;
    const bsum = bands[0] + bands[1] + bands[2] + bands[3] + bands[4] + 1e-9;
    const low = (bands[0] + bands[1]) / bsum;   // voiced vowel body
    const mid = bands[2] / bsum;                // vowel color / formant 2
    const high = (bands[3] + bands[4]) / bsum;  // fricative hiss

    let jawOpen = 0, lipPucker = 0, lipWide = 0, lipPress = 0, upperLipUp = 0;
    if (en > 0.06) {
      const cN = clamp01(centroid / 4200);
      const fric = clamp01(high * 2.6 - 0.28);
      const vowel = 1 - fric;
      jawOpen = clamp01(Math.pow(en, 0.65) * (0.25 + 0.95 * vowel) * (0.4 + 0.8 * (low + mid)));
      // wide (EE/IH/S): energy in F2 region or hiss
      lipWide = clamp01((mid * 2.2 - 0.35) * vowel + fric * 0.75) * clamp01(en * 2);
      // round (OO/OH/W): dark spectrum, low centroid, low F2
      lipPucker = clamp01((low * 1.9 - 0.6) * (1 - cN * 1.6)) * vowel * clamp01(en * 2);
      upperLipUp = fric * 0.5 * clamp01(en * 2);
      jawOpen *= 1 - fric * 0.7; // fricatives keep the jaw nearly closed
    }

    const frame = { t, jawOpen, lipPucker, lipWide, lipPress, upperLipUp, energy: en };
    const frames = this.frames;

    // plosive lookahead: a burst out of silence => press lips shut just before
    const prev = frames[frames.length - 1];
    if (prev && prev.energy < 0.1 && en > 0.4) {
      for (let k = frames.length - 1; k >= 0 && k >= frames.length - 8; k--) {
        if (t - frames[k].t > 0.09) break;
        frames[k].lipPress = Math.max(frames[k].lipPress, 0.85);
        frames[k].jawOpen *= 0.15;
      }
    }
    frames.push(frame);
  }

  // Sample the timeline at playback time t, with per-channel attack/release.
  sample(t, dt) {
    const frames = this.frames;
    let target = null;
    if (frames.length > 0 && t >= frames[0].t - 0.05 && t <= frames[frames.length - 1].t + 0.15) {
      // binary search for the frame pair around t
      let lo = 0, hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
      }
      const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
      const span = Math.max(b.t - a.t, 1e-4);
      const u = clamp01((t - a.t) / span);
      target = {};
      for (const ch of ['jawOpen', 'lipPucker', 'lipWide', 'lipPress', 'upperLipUp', 'energy']) {
        target[ch] = a[ch] + (b[ch] - a[ch]) * u;
      }
    }

    // envelope: fast attack, slower release; slower channels for lip shapes
    const rates = {
      jawOpen: [30, 11], lipPucker: [16, 7], lipWide: [16, 7],
      lipPress: [45, 18], upperLipUp: [20, 9], energy: [20, 5],
    };
    const s = this.state;
    for (const ch of Object.keys(rates)) {
      const tv = target ? target[ch] : 0;
      const [atk, rel] = rates[ch];
      const rate = tv > s[ch] ? atk : rel;
      s[ch] += (tv - s[ch]) * (1 - Math.exp(-dt * rate));
    }
    return s;
  }
}


