// Procedural morph target generation. No artist assets: every deformation is
// sculpted at startup from the neutral mesh using landmark anchors, gaussian
// region masks and simple geometric operations (translate / attract / rotate).
//
// The rig is continuous (ARKit-style channels) rather than discrete visemes:
// lip sync and expressions both resolve to weights over these channels.

import { ANCHOR, EYE_L, EYE_R, LIP_UPPER_INNER, LIP_LOWER_INNER, centroidOf } from './regions.js';

export const M = {
  jawOpen: 0, lipPucker: 1, lipWide: 2, lipPress: 3, upperLipUp: 4, lowerLipDown: 5,
  cornerUpL: 6, cornerUpR: 7, cornerDown: 8,
  blinkL: 9, blinkR: 10, eyeWideL: 11, eyeWideR: 12,
  browUpL: 13, browUpR: 14, browDown: 15, browInnerUp: 16,
  cheekPuff: 17, noseSneer: 18,
};
export const NUM_MORPHS = 19;

// Expression presets: name -> sparse channel weights.
export const EXPRESSIONS = {
  neutral: {},
  happy: { cornerUpL: 0.9, cornerUpR: 0.9, cheekPuff: 0.15, eyeWideL: 0.1, eyeWideR: 0.1, browUpL: 0.15, browUpR: 0.15 },
  sad: { cornerDown: 0.8, browInnerUp: 0.9, blinkL: 0.25, blinkR: 0.25, lowerLipDown: 0.15 },
  angry: { browDown: 1.0, lipPress: 0.55, noseSneer: 0.5, cornerDown: 0.3 },
  surprised: { browUpL: 1.0, browUpR: 1.0, eyeWideL: 0.9, eyeWideR: 0.9, jawOpen: 0.45 },
  skeptical: { browUpL: 0.9, browDown: 0.25, cornerUpR: 0.25, lipPress: 0.35 },
  thinking: { browDown: 0.35, browInnerUp: 0.3, lipPucker: 0.3, lipPress: 0.25, cornerUpL: 0.15 },
  fear: { browInnerUp: 1.0, eyeWideL: 1.0, eyeWideR: 1.0, jawOpen: 0.3, cornerDown: 0.4 },
};

const v3 = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Smooth gaussian falloff from a point; returns weight per vertex.
function gaussMask(pos, n, center, radius) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = dist(v3(pos, i), center) / radius;
    w[i] = Math.exp(-d * d * 2.2);
  }
  return w;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The canonical model's lips are slightly parted. Seal them: every lip-region
// vertex moves toward the seam midline of its nearest inner-ring pair, so the
// neutral face has touching lips. Returns per-vertex lip data used by the
// mouth morphs: side (+1 upper / -1 lower) and closeness (0..1 lip membership).
function sealLips(mesh, S, mouthC) {
  const pos = mesh.positions;
  const n = mesh.vertexCount;
  const side = new Float32Array(n);
  const closeness = new Float32Array(n);
  const v3i = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

  const nearest = (p, ring) => {
    let best = ring[0], bd = Infinity;
    for (const r of ring) {
      const d = dist(p, v3i(r));
      if (d < bd) { bd = d; best = r; }
    }
    return [best, bd];
  };

  for (let i = 0; i < n; i++) {
    const p = v3i(i);
    if (dist(p, mouthC) > 0.85 * S) continue;
    const [u, du] = nearest(p, LIP_UPPER_INNER);
    const [l, dl] = nearest(p, LIP_LOWER_INNER);
    side[i] = du <= dl ? 1 : -1;
    const dNear = Math.min(du, dl);
    closeness[i] = Math.exp(-((dNear / (0.3 * S)) ** 2));
    const k = Math.exp(-((dNear / (0.18 * S)) ** 2));
    if (k < 1e-3) continue;
    const uy = pos[u * 3 + 1], ly = pos[l * 3 + 1];
    const uz = pos[u * 3 + 2], lz = pos[l * 3 + 2];
    const midY = (uy + ly) / 2, midZ = (uz + lz) / 2;
    const refY = side[i] > 0 ? uy : ly;
    const refZ = side[i] > 0 ? uz : lz;
    pos[i * 3 + 1] += (midY - refY) * k;
    pos[i * 3 + 2] += (midZ - refZ) * k * 0.7;
  }
  return { side, closeness };
}

export function buildMorphs(mesh) {
  const pos = mesh.positions;
  const n = mesh.vertexCount;
  const deltas = new Float32Array(NUM_MORPHS * n * 3);
  const D = (m) => deltas.subarray(m * n * 3, (m + 1) * n * 3);

  // Anchor geometry (all in neutral mesh space, unit = S below)
  const eyeCL = centroidOf(pos, EYE_L);
  const eyeCR = centroidOf(pos, EYE_R);
  const S = dist(eyeCL, eyeCR); // interocular distance = the rig's length unit

  // seal the parted canonical lips before any anchors/masks are derived
  const preMouthC = centroidOf(pos, [ANCHOR.mouthUpperInner, ANCHOR.mouthLowerInner]);
  const lip = sealLips(mesh, S, preMouthC);

  const mouthC = centroidOf(pos, [ANCHOR.mouthUpperInner, ANCHOR.mouthLowerInner]);
  const cornerL = v3(pos, ANCHOR.mouthCornerL);
  const cornerR = v3(pos, ANCHOR.mouthCornerR);
  const browLp = v3(pos, ANCHOR.browL);
  const browRp = v3(pos, ANCHOR.browR);
  const browILp = v3(pos, ANCHOR.browInnerL);
  const browIRp = v3(pos, ANCHOR.browInnerR);
  const cheekLp = v3(pos, ANCHOR.cheekL);
  const cheekRp = v3(pos, ANCHOR.cheekR);
  const nose = v3(pos, ANCHOR.noseTip);
  const earL = v3(pos, ANCHOR.earL);
  const earR = v3(pos, ANCHOR.earR);
  const seamY = mouthC[1];

  // --- jawOpen: rotate the lower face about the ear axis -------------------
  {
    const d = D(M.jawOpen);
    const pivotY = (earL[1] + earR[1]) / 2;
    const pivotZ = (earL[2] + earR[2]) / 2;
    const angle = 0.32; // radians at weight 1
    const mouth = gaussMask(pos, n, mouthC, 1.6 * S);
    for (let i = 0; i < n; i++) {
      const y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      // Below the lip seam. For lip vertices, membership (upper/lower) decides
      // instead of height -- the sealed lips share the same y, and this is
      // what splits the seam open. Corners move half-way so nothing tears.
      const yBased = smoothstep(seamY + 0.10 * S, seamY - 0.35 * S, y);
      const dc = Math.min(dist(v3(pos, i), cornerL), dist(v3(pos, i), cornerR));
      const cornerness = Math.exp(-((dc / (0.15 * S)) ** 2));
      const sideBased = lip.side[i] < 0 ? 1 - 0.55 * cornerness : 0.45 * cornerness;
      const below = yBased + (sideBased - yBased) * lip.closeness[i];
      const w = below * Math.max(mouth[i], smoothstep(1.2 * S, 0.3 * S, dist(v3(pos, i), v3(pos, ANCHOR.chin))));
      if (w < 1e-3) continue;
      const a = angle * w;
      const ry = y - pivotY, rz = z - pivotZ;
      const cos = Math.cos(a), sin = Math.sin(a);
      d[i * 3 + 1] = (ry * cos - rz * sin) - ry;
      d[i * 3 + 2] = (ry * sin + rz * cos) - rz;
    }
  }

  // --- lip shapes -----------------------------------------------------------
  const lipMask = gaussMask(pos, n, mouthC, 0.62 * S);
  // Lips slide over the dental arch, they cannot retract through it. Any morph
  // that pulls the mouth region backwards in z must fade that pull out on the
  // lip band itself (closeness -> 1), otherwise stacked weights (lipWide +
  // lipPress + corners during speech) push the lip surface behind the teeth.
  const overTeeth = (i) => 1 - 0.75 * lip.closeness[i];
  {
    const d = D(M.lipPucker); // round + protrude (OO / W)
    for (let i = 0; i < n; i++) {
      const w = lipMask[i];
      if (w < 1e-3) continue;
      d[i * 3] = (mouthC[0] - pos[i * 3]) * 0.55 * w;      // squeeze toward center
      d[i * 3 + 1] = (seamY - pos[i * 3 + 1]) * 0.18 * w;  // slight vertical squeeze
      d[i * 3 + 2] = 0.24 * S * w;                          // protrude
    }
  }
  {
    const d = D(M.lipWide); // stretch (EE / S)
    for (let i = 0; i < n; i++) {
      const w = lipMask[i];
      if (w < 1e-3) continue;
      const dx = pos[i * 3] - mouthC[0];
      d[i * 3] = dx * 0.42 * w;
      d[i * 3 + 1] = (seamY - pos[i * 3 + 1]) * 0.22 * w;
      d[i * 3 + 2] = -0.05 * S * w * overTeeth(i);
    }
  }
  {
    const d = D(M.lipPress); // lips pressed together (M / B / P closure)
    for (let i = 0; i < n; i++) {
      const w = lipMask[i];
      if (w < 1e-3) continue;
      d[i * 3 + 1] = (seamY - pos[i * 3 + 1]) * 0.5 * w;
      d[i * 3 + 2] = -0.03 * S * w * overTeeth(i);
    }
  }
  {
    const dU = D(M.upperLipUp), dL = D(M.lowerLipDown);
    for (let i = 0; i < n; i++) {
      const w = lipMask[i];
      if (w < 1e-3) continue;
      const y = pos[i * 3 + 1];
      const yUpper = smoothstep(seamY - 0.02 * S, seamY + 0.12 * S, y);
      const yLower = smoothstep(seamY + 0.02 * S, seamY - 0.12 * S, y);
      const su = lip.side[i] > 0 ? 1 : 0;
      const sl = lip.side[i] < 0 ? 1 : 0;
      // Weight the raise mostly by lip height. Fully routing the sealed inner
      // edge (closeness->1) to su=1 lifts the middle of the top lip above the
      // gum line, pinning it to the teeth and distorting the lip when talking.
      const upper = yUpper + (su - yUpper) * lip.closeness[i] * 0.5;
      const lower = yLower + (sl - yLower) * lip.closeness[i];
      dU[i * 3 + 1] = 0.12 * S * w * upper;
      dL[i * 3 + 1] = -0.16 * S * w * lower;
    }
  }

  // --- mouth corners ---------------------------------------------------------
  function cornerMorph(target, cp, sign) {
    const mask = gaussMask(pos, n, cp, 0.5 * S);
    const out = sign * (cp[0] > mouthC[0] ? 1 : -1);
    for (let i = 0; i < n; i++) {
      const w = mask[i];
      if (w < 1e-3) continue;
      target[i * 3] += out * 0.05 * S * w;
      target[i * 3 + 1] += sign * 0.13 * S * w;
      target[i * 3 + 2] += -0.05 * S * w * overTeeth(i); // pull back into the cheek
    }
  }
  cornerMorph(D(M.cornerUpL), cornerL, 1);
  cornerMorph(D(M.cornerUpR), cornerR, 1);
  cornerMorph(D(M.cornerDown), cornerL, -1);
  cornerMorph(D(M.cornerDown), cornerR, -1);

  // --- eyes -------------------------------------------------------------------
  function eyeMorphs(blinkT, wideT, eyeC) {
    const mask = gaussMask(pos, n, eyeC, 0.42 * S);
    for (let i = 0; i < n; i++) {
      const w = mask[i];
      if (w < 1e-3) continue;
      const y = pos[i * 3 + 1];
      const upper = smoothstep(eyeC[1] - 0.02 * S, eyeC[1] + 0.14 * S, y);
      const lower = smoothstep(eyeC[1] + 0.02 * S, eyeC[1] - 0.14 * S, y);
      // blink: upper lid sweeps down to the eye centerline, lower lid rises a bit
      blinkT[i * 3 + 1] += ((eyeC[1] - y) * 0.92 * upper + (eyeC[1] - y) * 0.35 * lower) * w;
      blinkT[i * 3 + 2] += 0.02 * S * w * upper;
      // wide: lids apart
      wideT[i * 3 + 1] += (0.07 * S * upper - 0.045 * S * lower) * w;
    }
  }
  eyeMorphs(D(M.blinkL), D(M.eyeWideL), eyeCL);
  eyeMorphs(D(M.blinkR), D(M.eyeWideR), eyeCR);

  // --- brows -------------------------------------------------------------------
  function browRaise(target, bp) {
    const mask = gaussMask(pos, n, bp, 0.5 * S);
    for (let i = 0; i < n; i++) {
      const w = mask[i];
      if (w < 1e-3) continue;
      target[i * 3 + 1] += 0.13 * S * w;
      target[i * 3 + 2] += 0.02 * S * w;
    }
  }
  browRaise(D(M.browUpL), browLp);
  browRaise(D(M.browUpR), browRp);
  {
    const d = D(M.browDown); // knit + lower (anger)
    for (const bp of [browILp, browIRp]) {
      const mask = gaussMask(pos, n, bp, 0.55 * S);
      const toCenter = bp[0] > nose[0] ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const w = mask[i];
        if (w < 1e-3) continue;
        d[i * 3] += toCenter * 0.045 * S * w;
        d[i * 3 + 1] += -0.09 * S * w;
        d[i * 3 + 2] += 0.015 * S * w;
      }
    }
  }
  {
    const d = D(M.browInnerUp); // worry / plead
    for (const bp of [browILp, browIRp]) {
      const mask = gaussMask(pos, n, bp, 0.4 * S);
      for (let i = 0; i < n; i++) {
        const w = mask[i];
        if (w < 1e-3) continue;
        d[i * 3 + 1] += 0.12 * S * w;
      }
    }
  }

  // --- cheeks / nose --------------------------------------------------------------
  {
    const d = D(M.cheekPuff);
    for (const cp of [cheekLp, cheekRp]) {
      const mask = gaussMask(pos, n, cp, 0.55 * S);
      const out = cp[0] > nose[0] ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const w = mask[i];
        if (w < 1e-3) continue;
        d[i * 3] += out * 0.06 * S * w;
        d[i * 3 + 2] += 0.05 * S * w;
      }
    }
  }
  {
    const d = D(M.noseSneer);
    const sideL = [nose[0] + 0.18 * S, nose[1] + 0.05 * S, nose[2] - 0.1 * S];
    const sideR = [nose[0] - 0.18 * S, nose[1] + 0.05 * S, nose[2] - 0.1 * S];
    for (const sp of [sideL, sideR]) {
      const mask = gaussMask(pos, n, sp, 0.3 * S);
      for (let i = 0; i < n; i++) {
        const w = mask[i];
        if (w < 1e-3) continue;
        d[i * 3 + 1] += 0.06 * S * w;
      }
    }
  }

  return {
    deltas, numMorphs: NUM_MORPHS, unit: S,
    eyeCenterL: eyeCL, eyeCenterR: eyeCR, mouthCenter: mouthC,
    jawPivot: [(earL[1] + earR[1]) / 2, (earL[2] + earR[2]) / 2],
    jawAngle: 0.32, // radians at jawOpen weight 1 (must match the morph above)
  };
}


