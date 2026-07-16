// Minimal column-major mat4 helpers (WebGPU/WGSL convention).

export function identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function perspective(fovyRad, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovyRad / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (near * far) / (near - far);
  return out;
}

export function multiply(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function translation(x, y, z, out = new Float32Array(16)) {
  identity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

// Model matrix from euler yaw/pitch/roll + translation + uniform scale.
export function compose(yaw, pitch, roll, tx, ty, tz, s, out = new Float32Array(16)) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  out[0] = (cy * cr + sy * sp * sr) * s;
  out[1] = (cp * sr) * s;
  out[2] = (-sy * cr + cy * sp * sr) * s;
  out[3] = 0;
  out[4] = (-cy * sr + sy * sp * cr) * s;
  out[5] = (cp * cr) * s;
  out[6] = (sy * sr + cy * sp * cr) * s;
  out[7] = 0;
  out[8] = (sy * cp) * s;
  out[9] = (-sp) * s;
  out[10] = (cy * cp) * s;
  out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}


