// Layered animation mixer. Produces per-frame morph weights + head matrix:
//   idle life (blink, breathing drift, saccades, head noise)
// + expression layer (spring-smoothed preset)
// + mouth layer (live lip sync params)
// + mouse parallax head orientation

import { M, NUM_MORPHS, EXPRESSIONS } from './morphs.js';
import { compose } from '../gpu/mat4.js';

// Micro-gestures: small involuntary movements fired at random intervals.
// talkSafe gestures avoid the lip channels so they never fight the lip sync.
const GESTURES = [
  { name: 'noseTwitch', dur: 0.45, shape: 'twitch', talkSafe: true, ch: { noseSneer: 0.6, upperLipUp: 0.12 } },
  { name: 'nostrilFlare', dur: 1.3, shape: 'bump', talkSafe: true, ch: { noseSneer: 0.35 } },
  { name: 'pout', dur: 1.7, shape: 'bump', talkSafe: false, ch: { lipPucker: 0.5, cornerDown: 0.15 } },
  { name: 'lipPress', dur: 1.1, shape: 'bump', talkSafe: false, ch: { lipPress: 0.55 } },
  { name: 'smirkL', dur: 1.4, shape: 'bump', talkSafe: false, ch: { cornerUpL: 0.38, cheekPuff: 0.08 } },
  { name: 'smirkR', dur: 1.4, shape: 'bump', talkSafe: false, ch: { cornerUpR: 0.38, cheekPuff: 0.08 } },
  { name: 'browFlash', dur: 0.7, shape: 'bump', talkSafe: true, ch: { browUpL: 0.42, browUpR: 0.3 } },
  { name: 'browKnit', dur: 1.5, shape: 'bump', talkSafe: true, ch: { browDown: 0.32 } },
  { name: 'squint', dur: 1.2, shape: 'bump', talkSafe: true, ch: { blinkL: 0.28, blinkR: 0.28, cheekPuff: 0.1 } },
];
const GESTURE_SHAPES = {
  bump: (u) => Math.sin(Math.PI * u),
  twitch: (u) => Math.sin(Math.PI * u) * (0.4 + 0.6 * Math.abs(Math.cos(3 * Math.PI * u))),
};

// layered pseudo-noise from incommensurate sines; smooth and cheap
function noise(t, seed) {
  return (
    Math.sin(t * 0.31 + seed * 1.7) * 0.55 +
    Math.sin(t * 0.113 + seed * 3.1) * 0.3 +
    Math.sin(t * 0.73 + seed * 5.3) * 0.15
  );
}

export class Animator {
  constructor() {
    this.weights = new Float32Array(NUM_MORPHS);
    this.exprCurrent = new Float32Array(NUM_MORPHS);
    this.exprTarget = new Float32Array(NUM_MORPHS);
    this.expression = 'neutral';
    this.mouth = { jawOpen: 0, lipPucker: 0, lipWide: 0, lipPress: 0, upperLipUp: 0 };
    this.headMat = new Float32Array(16);
    this.mouse = { x: 0, y: 0 };
    this.smoothMouse = { x: 0, y: 0 };
    this.nextBlink = 1.5;
    this.blinkPhase = -1; // <0 idle, otherwise seconds into the blink
    this.nextSaccade = 0.8;
    this.saccade = { x: 0, y: 0 };
    this.irisSmooth = { x: 0, y: 0 };
    this.talkEnergy = 0;
    this.emphasis = 0;
    this.pulses = [];
    this.gestures = [];
    this.nextGesture = 2.5;
    this.lastGesture = -1;
    this.pendingHold = 0; // seconds a just-set expression should hold (0 = forever)
    this.revertAt = 0;    // wall-clock time (animator t) to revert to neutral
    this.sleep = 0;       // 0 = awake, 1 = eyes fully closed (offline)
    this.lipSeal = 0;     // 0 = off, 1 = hold lips shut when idle
  }

  setSleep(v) { this.sleep = Math.min(1, Math.max(0, v)); }
  setLipSeal(v) { this.lipSeal = Math.min(1, Math.max(0, v)); }

  // start a named micro-gesture (or a random suitable one)
  gesture(name) {
    let idx;
    if (name) {
      idx = GESTURES.findIndex((g) => g.name === name);
      if (idx < 0) return;
    } else {
      const talking = this.talkEnergy > 0.15;
      const pool = GESTURES
        .map((g, i) => ({ g, i }))
        .filter(({ g, i }) => i !== this.lastGesture && (!talking || g.talkSafe));
      if (!pool.length) return;
      idx = pool[Math.floor(Math.random() * pool.length)].i;
    }
    this.lastGesture = idx;
    this.gestures.push({ def: GESTURES[idx], t: 0, scale: 0.7 + Math.random() * 0.6 });
  }

  // transient channel boost (e.g. brow raise on an exclamation)
  pulse(channel, amount = 0.5, seconds = 0.9) {
    this.pulses.push({ ch: M[channel], amt: amount, t: 0, dur: seconds });
  }

  // holdSeconds: Infinity keeps it until changed (manual buttons); a finite
  // value auto-reverts to neutral after that time (model-driven expressions,
  // which should punctuate the current line, not linger).
  setExpression(name, holdSeconds = Infinity) {
    if (!EXPRESSIONS[name]) return;
    this.expression = name;
    this.exprTarget.fill(0);
    for (const [ch, v] of Object.entries(EXPRESSIONS[name])) this.exprTarget[M[ch]] = v;
    // schedule a wall-clock revert (resolved against `t` in update, so it is
    // exactly holdSeconds regardless of frame rate); 0 = held indefinitely
    this.pendingHold = (name !== 'neutral' && Number.isFinite(holdSeconds)) ? holdSeconds : 0;
    this.revertAt = 0;
  }

  setMouse(nx, ny) { this.mouse.x = nx; this.mouse.y = ny; }

  // mouthParams from lipsync: {jawOpen, lipPucker, lipWide, lipPress, upperLipUp, energy}
  update(t, dt, mouthParams) {
    dt = Math.min(dt, 0.1);
    const w = this.weights;
    w.fill(0);

    // auto-revert short-lived (model-driven) expressions to neutral
    if (this.pendingHold > 0) { this.revertAt = t + this.pendingHold; this.pendingHold = 0; }
    if (this.revertAt > 0 && t >= this.revertAt) {
      this.revertAt = 0;
      this.setExpression('neutral');
      this.onRevert?.();
    }

    // --- expression layer: exponential approach (smooth, no overshoot)
    const k = 1 - Math.exp(-dt * 7);
    for (let i = 0; i < NUM_MORPHS; i++) {
      this.exprCurrent[i] += (this.exprTarget[i] - this.exprCurrent[i]) * k;
      w[i] = this.exprCurrent[i];
    }

    // --- mouth layer (additive; lip sync rides on top of the expression)
    if (mouthParams) {
      w[M.jawOpen] = Math.min(1, w[M.jawOpen] + mouthParams.jawOpen);
      w[M.lipPucker] += mouthParams.lipPucker;
      w[M.lipWide] += mouthParams.lipWide;
      w[M.lipPress] += mouthParams.lipPress;
      w[M.upperLipUp] += mouthParams.upperLipUp;
      this.talkEnergy += (mouthParams.energy - this.talkEnergy) * (1 - Math.exp(-dt * 6));
    } else {
      this.talkEnergy *= Math.exp(-dt * 3);
    }

    // --- idle lip seal: hold the lips gently shut while not talking, releasing
    // as speech energy rises (opt-in; 0 = off, so desktop is unaffected)
    if (this.lipSeal > 0) {
      const quiet = Math.max(0, 1 - this.talkEnergy * 4);
      const seal = this.lipSeal * quiet;
      w[M.jawOpen] *= 1 - seal;                                // close any resting jaw
      w[M.lipPress] = Math.max(w[M.lipPress], seal * 0.18);    // press the seam shut
    }

    // --- idle: blink scheduler
    if (this.blinkPhase < 0 && t > this.nextBlink) {
      this.blinkPhase = 0;
      this.nextBlink = t + 2 + Math.random() * 4 + (Math.random() < 0.15 ? 0.25 : 0); // occasional double
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      const ph = this.blinkPhase / 0.13; // 130ms blink
      const amt = ph < 1 ? Math.sin(ph * Math.PI) : 0;
      if (ph >= 1) this.blinkPhase = -1;
      w[M.blinkL] = Math.max(w[M.blinkL], amt);
      w[M.blinkR] = Math.max(w[M.blinkR], amt);
    }

    // --- offline: hold the eyes shut while asleep
    if (this.sleep > 0) {
      w[M.blinkL] = Math.max(w[M.blinkL], this.sleep);
      w[M.blinkR] = Math.max(w[M.blinkR], this.sleep);
    }

    // --- micro-gestures: random subtle life (nose twitch, pout, smirk...)
    if (t > this.nextGesture) {
      this.gesture();
      const talking = this.talkEnergy > 0.15;
      this.nextGesture = t + (talking ? 6 + Math.random() * 9 : 3.5 + Math.random() * 8);
    }
    for (let i = this.gestures.length - 1; i >= 0; i--) {
      const g = this.gestures[i];
      g.t += dt;
      const u = g.t / g.def.dur;
      if (u >= 1) { this.gestures.splice(i, 1); continue; }
      const v = GESTURE_SHAPES[g.def.shape](u) * g.scale;
      for (const [ch, amp] of Object.entries(g.def.ch)) w[M[ch]] += amp * v;
    }

    // --- transient pulses (sentiment cues from the transcript)
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      if (p.t >= p.dur) { this.pulses.splice(i, 1); continue; }
      w[p.ch] += p.amt * Math.sin((p.t / p.dur) * Math.PI);
    }

    // --- idle: micro brow life
    w[M.browUpL] += Math.max(0, noise(t, 11)) * 0.05;
    w[M.browUpR] += Math.max(0, noise(t, 12)) * 0.05;

    // --- saccades (iris sprites)
    if (t > this.nextSaccade) {
      this.nextSaccade = t + 0.6 + Math.random() * 2.4;
      this.saccade.x = (Math.random() - 0.5) * 0.024;
      this.saccade.y = (Math.random() - 0.5) * 0.012;
    }
    const ks = 1 - Math.exp(-dt * 18); // saccades are fast
    this.irisSmooth.x += (this.saccade.x + this.smoothMouse.x * 0.018 - this.irisSmooth.x) * ks;
    this.irisSmooth.y += (this.saccade.y + this.smoothMouse.y * 0.012 - this.irisSmooth.y) * ks;
    // never let the pupil leave the eye
    const irisLen = Math.hypot(this.irisSmooth.x, this.irisSmooth.y);
    if (irisLen > 0.03) {
      this.irisSmooth.x *= 0.03 / irisLen;
      this.irisSmooth.y *= 0.03 / irisLen;
    }

    // --- head: noise drift + mouse parallax + talk emphasis nod
    const km = 1 - Math.exp(-dt * 3.5);
    this.smoothMouse.x += (this.mouse.x - this.smoothMouse.x) * km;
    this.smoothMouse.y += (this.mouse.y - this.smoothMouse.y) * km;
    this.emphasis += ((this.talkEnergy > 0.55 ? 1 : 0) - this.emphasis) * (1 - Math.exp(-dt * 4));

    const yaw = noise(t, 1) * 0.045 + this.smoothMouse.x * 0.22;
    const pitch = noise(t, 2) * 0.03 - this.smoothMouse.y * 0.15 + this.emphasis * 0.02 + Math.sin(t * 0.6) * 0.006;
    const roll = noise(t, 3) * 0.02;
    const breathe = Math.sin(t * 0.9) * 0.006;
    compose(yaw, pitch, roll, 0, breathe, 0, 1.15, this.headMat);

    // clamp all channels
    for (let i = 0; i < NUM_MORPHS; i++) w[i] = Math.min(1.2, Math.max(0, w[i]));
    const irisDim = Math.pow(1 - Math.min(1, Math.max(w[M.blinkL], w[M.blinkR])), 2);
    return { weights: w, head: this.headMat, iris: this.irisSmooth, irisDim, talkEnergy: this.talkEnergy };
  }
}


