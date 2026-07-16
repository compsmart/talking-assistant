// Face shape adaptation: deform the neutral mesh so its proportions match
// the face in the uploaded photo. Landmark i corresponds to vertex i, so the
// detected layout IS a measurement of the subject's face -- after removing
// the photo's head pose:
//   1. de-roll (eye line horizontal) + similarity-normalize (interocular)
//   2. per-vertex XY deltas vs the canonical face
//   3. mirror-symmetrize the delta field (cancels yaw skew to first order)
//   4. laplacian-smooth + clamp (kills landmark jitter and outliers)
//   5. blend onto the pristine mesh in XY; depth stays canonical (a single
//      photo carries no trustworthy z)

import { EYE_L, EYE_R, centroidOf } from '../face/regions.js';

const BLEND = 0.75;          // how much of the detected shape to adopt
const MAX_DELTA = 0.30;      // per-vertex cap, in units of interocular S

// nearest vertex to (-x, y, z): built once, canonical mesh is symmetric
function buildMirrorMap(pos, n) {
  const map = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = -pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let best = i, bd = Infinity;
    for (let j = 0; j < n; j++) {
      const dx = pos[j * 3] - x, dy = pos[j * 3 + 1] - y, dz = pos[j * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = j; }
    }
    map[i] = best;
  }
  return map;
}

function buildNeighbors(tris, n) {
  const nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b);
  }
  return nb.map((s) => [...s]);
}

let mirrorMap = null;
let neighbors = null;

// pristine: unmodified canonical positions. landmarks: FaceLandmarker points
// (normalized image coords). aspect: imageWidth / imageHeight.
// Writes the adapted positions into mesh.positions (pristine + blended delta).
export function adaptMeshToFace(mesh, pristine, landmarks, aspect) {
  const n = mesh.vertexCount;
  if (!mirrorMap) mirrorMap = buildMirrorMap(pristine, n);
  if (!neighbors) neighbors = buildNeighbors(mesh.tris, n);

  // detected points in aspect-true space, y flipped to match mesh-up
  const det = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    det[i * 2] = landmarks[i].x * aspect;
    det[i * 2 + 1] = -landmarks[i].y;
  }
  const c2 = (idx) => {
    let x = 0, y = 0;
    for (const i of idx) { x += det[i * 2]; y += det[i * 2 + 1]; }
    return [x / idx.length, y / idx.length];
  };
  const dEyeL = c2(EYE_L), dEyeR = c2(EYE_R);

  // canonical reference frame
  const cEyeL = centroidOf(pristine, EYE_L), cEyeR = centroidOf(pristine, EYE_R);
  const S = Math.hypot(cEyeL[0] - cEyeR[0], cEyeL[1] - cEyeR[1]);
  const cMid = [(cEyeL[0] + cEyeR[0]) / 2, (cEyeL[1] + cEyeR[1]) / 2];

  // similarity align: de-roll about the eye line, scale interocular to S
  const ex = dEyeL[0] - dEyeR[0], ey = dEyeL[1] - dEyeR[1];
  const dS = Math.hypot(ex, ey);
  if (dS < 1e-6) return false;
  const roll = Math.atan2(ey, ex); // 0 when eyes are level
  const cos = Math.cos(-roll), sin = Math.sin(-roll);
  const scale = S / dS;
  const dMid = [(dEyeL[0] + dEyeR[0]) / 2, (dEyeL[1] + dEyeR[1]) / 2];

  let delta = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const px = det[i * 2] - dMid[0], py = det[i * 2 + 1] - dMid[1];
    const ax = (px * cos - py * sin) * scale + cMid[0];
    const ay = (px * sin + py * cos) * scale + cMid[1];
    delta[i * 2] = ax - pristine[i * 3];
    delta[i * 2 + 1] = ay - pristine[i * 3 + 1];
  }

  // symmetrize: average each delta with its mirrored partner's mirrored delta
  const sym = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const m = mirrorMap[i];
    sym[i * 2] = (delta[i * 2] - delta[m * 2]) / 2;
    sym[i * 2 + 1] = (delta[i * 2 + 1] + delta[m * 2 + 1]) / 2;
  }
  delta = sym;

  // two rounds of laplacian smoothing over the mesh graph
  for (let iter = 0; iter < 2; iter++) {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0;
      const nbs = neighbors[i];
      for (const j of nbs) { ax += delta[j * 2]; ay += delta[j * 2 + 1]; }
      out[i * 2] = delta[i * 2] * 0.5 + (ax / nbs.length) * 0.5;
      out[i * 2 + 1] = delta[i * 2 + 1] * 0.5 + (ay / nbs.length) * 0.5;
    }
    delta = out;
  }

  // clamp outliers and write the blended shape (XY only, canonical depth)
  const cap = MAX_DELTA * S;
  for (let i = 0; i < n; i++) {
    let dx = delta[i * 2], dy = delta[i * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len > cap) { dx *= cap / len; dy *= cap / len; }
    mesh.positions[i * 3] = pristine[i * 3] + dx * BLEND;
    mesh.positions[i * 3 + 1] = pristine[i * 3 + 1] + dy * BLEND;
    mesh.positions[i * 3 + 2] = pristine[i * 3 + 2];
  }
  return true;
}


