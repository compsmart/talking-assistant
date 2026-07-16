// MediaPipe canonical face mesh landmark indices used as anchors for
// procedural morph generation. Index semantics are stable across the
// canonical model and FaceLandmarker output (first 468 points).
// Note: L/R are the subject's left/right (subject left = +x in mesh space).

export const ANCHOR = {
  noseTip: 4,
  noseBridge: 6,
  foreheadCenter: 10,
  chin: 152,
  mouthUpperOuter: 0,
  mouthUpperInner: 13,
  mouthLowerInner: 14,
  mouthLowerOuter: 17,
  mouthCornerR: 61,
  mouthCornerL: 291,
  eyeOuterR: 33,
  eyeInnerR: 133,
  eyeOuterL: 263,
  eyeInnerL: 362,
  eyeTopR: 159,
  eyeBottomR: 145,
  eyeTopL: 386,
  eyeBottomL: 374,
  browR: 105,
  browL: 334,
  browInnerR: 55,
  browInnerL: 285,
  cheekR: 50,
  cheekL: 280,
  earR: 234,
  earL: 454,
};

export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
// inner lip ring split by lip (corners 78/308 excluded)
export const LIP_UPPER_INNER = [191, 80, 81, 82, 13, 312, 311, 310, 415];
export const LIP_LOWER_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
export const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398];
export const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173];
export const BROW_L = [276, 283, 282, 295, 285, 300, 293, 334, 296];
export const BROW_R = [46, 53, 52, 65, 55, 70, 63, 105, 66];

export function centroidOf(positions, indices) {
  let x = 0, y = 0, z = 0;
  for (const i of indices) { x += positions[i * 3]; y += positions[i * 3 + 1]; z += positions[i * 3 + 2]; }
  const n = indices.length;
  return [x / n, y / n, z / n];
}


