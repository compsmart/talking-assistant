// All WGSL for the app. Buffers use flat array<f32> with manual indexing to
// avoid vec3 stride/alignment pitfalls in storage buffers.

export const NUM_MORPHS_WGSL = 19;

// ---------------------------------------------------------------------------
// Compute pass 1: morphed position = base + sum(weight_i * delta_i)
// ---------------------------------------------------------------------------
export const MORPH_COMPUTE = /* wgsl */`
struct MorphParams { vertexCount: u32, numMorphs: u32, _p0: u32, _p1: u32 };

@group(0) @binding(0) var<storage, read> basePos: array<f32>;
@group(0) @binding(1) var<storage, read> deltas: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> outPos: array<f32>;
@group(0) @binding(4) var<uniform> mp: MorphParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let v = gid.x;
  if (v >= mp.vertexCount) { return; }
  var p = vec3<f32>(basePos[v*3u], basePos[v*3u+1u], basePos[v*3u+2u]);
  let stride = mp.vertexCount * 3u;
  for (var m = 0u; m < mp.numMorphs; m++) {
    let w = weights[m];
    if (abs(w) < 1e-4) { continue; }
    let o = m * stride + v * 3u;
    p += w * vec3<f32>(deltas[o], deltas[o+1u], deltas[o+2u]);
  }
  outPos[v*3u] = p.x; outPos[v*3u+1u] = p.y; outPos[v*3u+2u] = p.z;
}
`;

// ---------------------------------------------------------------------------
// Compute pass 2: smooth vertex normals from adjacent triangles
// ---------------------------------------------------------------------------
export const NORMAL_COMPUTE = /* wgsl */`
struct MorphParams { vertexCount: u32, numMorphs: u32, _p0: u32, _p1: u32 };

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> tris: array<u32>;
@group(0) @binding(2) var<storage, read> adjOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> adjTris: array<u32>;
@group(0) @binding(4) var<storage, read_write> normals: array<f32>;
@group(0) @binding(5) var<uniform> mp: MorphParams;

fn readP(i: u32) -> vec3<f32> { return vec3<f32>(pos[i*3u], pos[i*3u+1u], pos[i*3u+2u]); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let v = gid.x;
  if (v >= mp.vertexCount) { return; }
  var nrm = vec3<f32>(0.0);
  let start = adjOffsets[v];
  let end = adjOffsets[v + 1u];
  for (var k = start; k < end; k++) {
    let t = adjTris[k] * 3u;
    let a = readP(tris[t]);
    let b = readP(tris[t+1u]);
    let c = readP(tris[t+2u]);
    nrm += cross(b - a, c - a); // area-weighted
  }
  let len = max(length(nrm), 1e-6);
  nrm /= len;
  normals[v*3u] = nrm.x; normals[v*3u+1u] = nrm.y; normals[v*3u+2u] = nrm.z;
}
`;

// ---------------------------------------------------------------------------
// Shared frame uniforms
// ---------------------------------------------------------------------------
const FRAME_STRUCT = /* wgsl */`
struct Frame {
  viewProj: mat4x4<f32>,
  model: mat4x4<f32>,
  camPos: vec4<f32>,
  // p0: time, wireToSkin, glowIntensity, pointSize
  p0: vec4<f32>,
  // p1: irisL.xy, irisR.xy (model-space offsets for the iris sprites)
  p1: vec4<f32>,
  // p2: eyeCenterL.xyz, unit ; p3: eyeCenterR.xyz, talkEnergy
  p2: vec4<f32>,
  p3: vec4<f32>,
  // wireColor.rgb, unused ; rimColor.rgb, hologramMotion
  wireColor: vec4<f32>,
  rimColor: vec4<f32>,
};
`;

// ---------------------------------------------------------------------------
// Face pass: expanded (non-indexed) triangles, barycentric wireframe + skin
// ---------------------------------------------------------------------------
export const FACE_SHADER = /* wgsl */`
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> pos: array<f32>;
@group(0) @binding(2) var<storage, read> normals: array<f32>;
@group(0) @binding(3) var<storage, read> tris: array<u32>;
@group(0) @binding(4) var<storage, read> photoUV: array<f32>;
@group(0) @binding(5) var photoTex: texture_2d<f32>;
@group(0) @binding(6) var photoSamp: sampler;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) bary: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) vid: f32,
};

fn readP(i: u32) -> vec3<f32> { return vec3<f32>(pos[i*3u], pos[i*3u+1u], pos[i*3u+2u]); }
fn readN(i: u32) -> vec3<f32> { return vec3<f32>(normals[i*3u], normals[i*3u+1u], normals[i*3u+2u]); }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let idx = tris[vi];
  let corner = vi % 3u;
  var out: VOut;
  let world = (F.model * vec4<f32>(readP(idx), 1.0)).xyz;
  out.clip = F.viewProj * vec4<f32>(world, 1.0);
  out.bary = vec3<f32>(f32(corner == 0u), f32(corner == 1u), f32(corner == 2u));
  out.worldPos = world;
  out.normal = normalize((F.model * vec4<f32>(readN(idx), 0.0)).xyz);
  out.uv = vec2<f32>(photoUV[idx*2u], photoUV[idx*2u+1u]);
  out.vid = f32(idx);
  return out;
}

fn hash1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }

fn aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let time = F.p0.x;
  let blend = F.p0.y;
  let glow = F.p0.z;
  let talk = F.p3.w;
  let hologramMotion = F.rimColor.w;

  // --- wireframe: distance to nearest triangle edge, AA via fwidth
  let d = min(in.bary.x, min(in.bary.y, in.bary.z));
  let w = fwidth(d);
  // fade out subpixel triangles (dense lip/eye rings) so they do not fuse
  // into a solid blown-out patch
  let density = saturate(0.05 / max(w, 1e-4) - 0.2);
  let lineCore = (1.0 - smoothstep(0.0, w * 1.6, d)) * density;
  let lineGlow = exp(-d * 30.0) * density;

  let view = normalize(F.camPos.xyz - in.worldPos);
  let nrm = select(-in.normal, in.normal, front);
  let fres = pow(saturate(1.0 - abs(dot(view, nrm))), 2.0);

  // slow energy pulse traveling up the face + per-vertex shimmer
  let pulse = mix(1.0, 0.72 + 0.28 * sin(time * 1.7 + in.worldPos.y * 5.0 - in.worldPos.z * 2.0), hologramMotion);
  let shimmer = mix(1.0, 0.85 + 0.3 * sin(time * 3.1 + hash1(in.vid) * 6.2831), hologramMotion);
  let talkBoost = 1.0 + talk * 0.9;

  var wireCol = F.wireColor.rgb * (lineCore * 2.1 + lineGlow * 0.6) * pulse * shimmer * glow * talkBoost;
  wireCol += F.rimColor.rgb * fres * 0.22 * glow; // faint holographic shell
  // depth fade: farther half of the head dims
  let depthFade = clamp(0.35 + 0.65 * smoothstep(-0.9, 0.6, in.worldPos.z), 0.0, 1.0);
  wireCol *= depthFade;

  // --- skin: photo texture, plainly lit, kept below the bloom threshold so
  // the skin never glows -- the slider is a pure cross-fade
  var skinCol = vec3<f32>(0.0);
  if (blend > 0.001) {
    let tex = textureSample(photoTex, photoSamp, in.uv).rgb;
    let l1 = normalize(vec3<f32>(0.35, 0.5, 0.9));
    let l2 = normalize(vec3<f32>(-0.6, -0.2, 0.4));
    let light = 0.58 + 0.45 * max(dot(nrm, l1), 0.0) + 0.12 * max(dot(nrm, l2), 0.0);
    skinCol = tex * min(light, 1.0) * 0.9;
  }

  // The wire material is premultiplied and translucent between lines so the
  // configured digital background remains visible through the mesh openings.
  let wireAlpha = clamp((lineCore + lineGlow * 0.55 + fres * 0.12) * depthFade * clamp(glow, 0.0, 1.0), 0.0, 1.0);
  let alpha = mix(wireAlpha, 1.0, blend);
  return vec4<f32>(mix(wireCol, skinCol, blend), alpha);
}
`;

// ---------------------------------------------------------------------------
// Inner mouth pass: teeth, gums, tongue, cavity. Real vertex buffer.
// Lower jaw parts (jawness 1) rotate about the same pivot as the jawOpen
// morph so teeth track the face exactly.
// ---------------------------------------------------------------------------
export const MOUTH_SHADER = /* wgsl */`
${FRAME_STRUCT}
// x jawAngle (radians, already scaled by jawOpen weight), y tongueRaise,
// z pivotY, w pivotZ ; m1: x zFront, y zBack, z mouthOpen, w lipRecede
struct MouthParams { m0: vec4<f32>, m1: vec4<f32> };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> MP: MouthParams;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) bary: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) part: f32,
  @location(4) localZ: f32,
  @location(5) aux: f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) posIn: vec3<f32>,
  @location(1) nrmIn: vec3<f32>,
  @location(2) misc: vec3<f32>, // part, jawness, aux
) -> VOut {
  var p = posIn;
  var nl = nrmIn;
  let part = misc.x;
  let jawness = misc.y;
  let aux = misc.z;
  let time = F.p0.x;

  // tongue: tip lifts and waves while talking
  if (part == 2.0) {
    let lift = MP.m0.y * aux * aux;
    p.y += lift * 0.055;
    p.z += lift * 0.012;
    p.y += sin(time * 8.5 + aux * 5.0) * 0.008 * MP.m0.y * aux;
  }

  // keep the arch behind lips that active morphs are pulling backwards
  p.z -= MP.m1.w;

  // jaw rotation about the ear axis
  let a = MP.m0.x * jawness;
  if (a > 0.0001) {
    let c = cos(a); let s = sin(a);
    let ry = p.y - MP.m0.z; let rz = p.z - MP.m0.w;
    p.y = MP.m0.z + ry * c - rz * s;
    p.z = MP.m0.w + ry * s + rz * c;
    let ny = nl.y * c - nl.z * s;
    nl.z = nl.y * s + nl.z * c;
    nl.y = ny;
  }

  var out: VOut;
  let world = (F.model * vec4<f32>(p, 1.0)).xyz;
  out.clip = F.viewProj * vec4<f32>(world, 1.0);
  let corner = vi % 3u;
  out.bary = vec3<f32>(f32(corner == 0u), f32(corner == 1u), f32(corner == 2u));
  out.worldPos = world;
  out.normal = normalize((F.model * vec4<f32>(nl, 0.0)).xyz);
  out.part = part;
  out.localZ = p.z;
  out.aux = aux;
  return out;
}

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let blend = F.p0.y;
  let glow = F.p0.z;
  let part = in.part;

  // depth into the mouth dims everything (cheap cavity occlusion)
  let ao = 0.25 + 0.75 * smoothstep(MP.m1.y, MP.m1.x, in.localZ);

  // wireframe mode: the hologram has no human anatomy inside -- the whole
  // inner mouth is a near-void, just a faint cyan depth hint. Teeth/gums/
  // tongue only appear as the skin fades in.
  let view = normalize(F.camPos.xyz - in.worldPos);
  let nv = select(-in.normal, in.normal, front);
  let fres = pow(saturate(1.0 - abs(dot(view, nv))), 1.5);
  let wireCol = F.wireColor.rgb * (0.015 + 0.05 * fres) * glow * ao;

  // skin-mode materials
  var mat = vec3<f32>(0.0);
  if (part == 0.0) { mat = vec3<f32>(0.42, 0.18, 0.19); }        // gums
  if (part == 1.0) {
    // teeth: shaded separator groove between crowns (aux: 0 boundary, 1 center)
    mat = vec3<f32>(0.88, 0.85, 0.78) * (0.55 + 0.45 * smoothstep(0.0, 0.35, in.aux));
  }
  if (part == 2.0) { mat = vec3<f32>(0.60, 0.26, 0.28); }        // tongue
  if (part == 3.0) { mat = vec3<f32>(0.10, 0.045, 0.05); }       // cavity
  let nrm = select(-in.normal, in.normal, front);
  let l1 = normalize(vec3<f32>(0.2, 0.4, 1.0));
  let light = 0.45 + 0.5 * max(dot(nrm, l1), 0.0);
  // MP.m1.z = mouth openness: hold the inner mouth dark until the lips part, so
  // a closed mouth reads as a natural dark lip line, not a strip of teeth
  let openFade = smoothstep(0.02, 0.5, MP.m1.z);
  let skinCol = mat * min(light, 1.0) * ao * 0.9 * openFade;

  let wireAlpha = clamp((0.015 + 0.05 * fres) * glow * ao, 0.0, 0.2);
  let alpha = mix(wireAlpha, openFade, blend);
  return vec4<f32>(mix(wireCol, skinCol, blend), alpha);
}
`;

// ---------------------------------------------------------------------------
// Point pass: instanced billboard sprites on vertices + 2 iris sprites
// ---------------------------------------------------------------------------
export const POINTS_SHADER = /* wgsl */`
${FRAME_STRUCT}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> pos: array<f32>;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) intensity: f32,
  @location(2) isIris: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VOut {
  let corner = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let count = arrayLength(&pos) / 3u;
  var p: vec3<f32>;
  var size = F.p0.w;
  var intensity = 0.42;
  var isIris = 0.0;
  if (inst < count) {
    p = vec3<f32>(pos[inst*3u], pos[inst*3u+1u], pos[inst*3u+2u]);
  } else if (inst == count) {
    p = F.p2.xyz + vec3<f32>(F.p1.x, F.p1.y, 0.06); // left iris
    size *= 3.4; intensity = 1.5 * F.p2.w; isIris = 1.0; // p2.w dims during blinks
  } else {
    p = F.p3.xyz + vec3<f32>(F.p1.z, F.p1.w, 0.06); // right iris
    size *= 3.4; intensity = 1.5 * F.p2.w; isIris = 1.0;
  }
  let world = (F.model * vec4<f32>(p, 1.0)).xyz;
  var clip = F.viewProj * vec4<f32>(world, 1.0);
  // billboard offset in clip space, keeping sprites screen-sized-ish
  clip = vec4<f32>(clip.xy + corner * size * clip.w * vec2<f32>(1.0, F.camPos.w), clip.zw);
  clip.z -= 0.0012 * clip.w; // nudge toward camera to sit on the surface

  var out: VOut;
  out.clip = clip;
  out.local = corner;
  // fade points as skin takes over; depth fade like the wires
  let depthFade = clamp(0.3 + 0.7 * smoothstep(-0.9, 0.6, p.z), 0.0, 1.0);
  out.intensity = intensity * (1.0 - F.p0.y) * depthFade * F.p0.z;
  out.isIris = isIris;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let r = length(in.local);
  if (r > 1.0) { discard; }
  let core = exp(-r * r * 6.0);
  let halo = exp(-r * 2.2) * 0.4;
  var col = F.wireColor.rgb * (core + halo) * in.intensity;
  if (in.isIris > 0.5) {
    let t = F.p0.x;
    col = mix(F.wireColor.rgb, vec3<f32>(1.0), 0.35) * (core * (1.3 + 0.3 * sin(t * 2.3)) + halo);
    col *= in.intensity * 1.4;
  }
  return vec4<f32>(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Post: fullscreen helpers
// ---------------------------------------------------------------------------
const FS_TRIANGLE = /* wgsl */`
struct VOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var out: VOut;
  let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  out.clip = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return out;
}
`;

export const BACKGROUND_SHADER = /* wgsl */`
${FS_TRIANGLE}
struct BackgroundParams { base: vec4<f32>, accent: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> P: BackgroundParams;
fn hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn line(v: f32, width: f32) -> f32 { return 1.0 - smoothstep(0.0, width, abs(fract(v) - 0.5)); }
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let mode = P.p0.x; let intensity = P.p0.y; let t = P.p0.z; let particleAmount = P.p0.w;
  let uv = in.uv; let aspect = P.p1.x; var signal = 0.0;
  if (mode > 0.5 && mode < 1.5) {
    let p = vec2<f32>((uv.x - 0.5) * aspect, uv.y + t * 0.025);
    let grid = max(line(p.x * 13.0, 0.055), line(p.y * 13.0, 0.055));
    let sweep = pow(max(0.0, 1.0 - abs(fract(p.y * 0.22 - t * 0.08) - 0.5) * 8.0), 3.0);
    signal = grid * (0.18 + 0.35 * sweep);
  } else if (mode > 1.5 && mode < 2.5) {
    let columns = floor(uv.x * 44.0); let row = floor((1.0 - uv.y + t * (0.08 + hash(vec2<f32>(columns, 2.0)) * 0.12)) * 55.0);
    let glyph = step(0.72, hash(vec2<f32>(columns, row))) * (0.25 + 0.75 * hash(vec2<f32>(row, columns)));
    signal = glyph * smoothstep(0.0, 0.3, fract((1.0 - uv.y) * 2.0 + hash(vec2<f32>(columns, 1.0)) - t * 0.12));
  } else if (mode > 2.5) {
    let cell = floor(vec2<f32>(uv.x * aspect, uv.y) * 90.0); let local = fract(vec2<f32>(uv.x * aspect, uv.y) * 90.0) - 0.5;
    let star = step(0.975, hash(cell)) * exp(-length(local) * 18.0);
    signal = star * (0.5 + 0.5 * sin(t * 2.0 + hash(cell) * 6.283));
  }
  let particleCell = floor(vec2<f32>(uv.x * aspect, uv.y) * 34.0);
  let particleLocal = fract(vec2<f32>(uv.x * aspect, uv.y + t * 0.012) * 34.0) - 0.5;
  let particles = step(1.0 - particleAmount * 0.18, hash(particleCell)) * exp(-length(particleLocal) * 14.0) * particleAmount;
  // Digital effects are an emissive layer over the user's base color. The
  // separate face-shadow pass is composited over this complete layer later.
  let digital = P.accent.rgb * (signal * intensity * 2.2 + particles * 1.15);
  return vec4<f32>(P.base.rgb + digital, 1.0);
}
`;

// A separate, stationary layer between the digital background and face. Its
// premultiplied dark center fully occludes effects behind the mesh, then fades
// smoothly to transparent so the chosen background remains visible outside.
export const FACE_SHADOW_SHADER = /* wgsl */`
${FS_TRIANGLE}
struct BackgroundParams { base: vec4<f32>, accent: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> P: BackgroundParams;
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let aspect = P.p1.x;
  let faceDistance = length((in.uv - vec2<f32>(0.5, 0.51)) * vec2<f32>(aspect * 0.72, 1.0));
  let alpha = 1.0 - smoothstep(0.16, 0.68, faceDistance);
  let shadow = vec3<f32>(0.0015, 0.0025, 0.006);
  return vec4<f32>(shadow * alpha, alpha);
}
`;

export const BRIGHT_SHADER = /* wgsl */`
${FS_TRIANGLE}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, in.uv).rgb;
  let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  // threshold sits above skin brightness (<= ~0.9): only the HDR wires bloom
  let knee = smoothstep(0.95, 1.55, lum);
  return vec4<f32>(c * knee, 1.0);
}
`;

// 9-tap tent downsample (CoD-style bloom chain)
export const DOWNSAMPLE_SHADER = /* wgsl */`
${FS_TRIANGLE}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSample(src, samp, in.uv).rgb * 0.25;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0, -1.0)).rgb * 0.0625;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0, -1.0)).rgb * 0.0625;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0,  1.0)).rgb * 0.0625;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0,  1.0)).rgb * 0.0625;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0,  0.0)).rgb * 0.125;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0,  0.0)).rgb * 0.125;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 0.0, -1.0)).rgb * 0.125;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 0.0,  1.0)).rgb * 0.125;
  return vec4<f32>(c, 1.0);
}
`;

// tent upsample, rendered additively onto the larger level
export const UPSAMPLE_SHADER = /* wgsl */`
${FS_TRIANGLE}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSample(src, samp, in.uv).rgb * 4.0;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0,  0.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0,  0.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 0.0, -1.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 0.0,  1.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0, -1.0)).rgb;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0, -1.0)).rgb;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>(-1.0,  1.0)).rgb;
  c += textureSample(src, samp, in.uv + ts * vec2<f32>( 1.0,  1.0)).rgb;
  return vec4<f32>(c / 16.0, 1.0);
}
`;

export const COMPOSITE_SHADER = /* wgsl */`
${FS_TRIANGLE}
struct PostParams { p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: PostParams;

fn aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}
fn hash2(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453); }

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let time = P.p0.x; let bloomAmount = P.p0.y; let aberration = P.p0.z; let vignette = P.p0.w;
  let scanlineAmount = P.p1.x; let motion = P.p1.z; let effectTime = time * motion; let glitchAmount = P.p1.y * motion;
  // One brief glitch at a randomized point in every ten-second window.
  let glitchCycle = floor(effectTime / 10.0);
  let cycleTime = effectTime - glitchCycle * 10.0;
  let glitchStart = 0.75 + hash2(vec2<f32>(glitchCycle, 17.0)) * 8.5;
  let glitchDuration = 0.12 + hash2(vec2<f32>(glitchCycle, 29.0)) * 0.16;
  let glitchAge = cycleTime - glitchStart;
  let glitchActive = step(0.0, glitchAge) * (1.0 - step(glitchDuration, glitchAge));
  let glitchEnvelope = sin(3.14159 * clamp(glitchAge / glitchDuration, 0.0, 1.0)) * glitchActive;
  let band = floor(in.uv.y * 28.0);
  let bandGate = step(0.55, hash2(vec2<f32>(glitchCycle, band)));
  let glitchOffset = (hash2(vec2<f32>(band, glitchCycle + 41.0)) - 0.5) * 0.075 * glitchAmount * glitchEnvelope * bandGate;
  let sampleUv = clamp(in.uv + vec2<f32>(glitchOffset, 0.0), vec2<f32>(0.001), vec2<f32>(0.999));
  let center = sampleUv - 0.5;
  let r2 = dot(center, center);

  // chromatic aberration: radial channel split
  let ab = aberration * r2;
  var col: vec3<f32>;
  col.r = textureSample(scene, samp, sampleUv + center * ab).r;
  col.g = textureSample(scene, samp, sampleUv).g;
  col.b = textureSample(scene, samp, sampleUv - center * ab).b;

  col += textureSample(bloomTex, samp, sampleUv).rgb * bloomAmount;

  // scanlines + slow roll bar
  let dims = vec2<f32>(textureDimensions(scene));
  let scan = 1.0 - scanlineAmount * (0.5 + 0.5 * sin(in.uv.y * dims.y * 3.14159));
  let roll = 1.0 + scanlineAmount * 0.45 * smoothstep(0.02, 0.0, abs(fract(in.uv.y * 0.25 + effectTime * 0.02) - 0.5) - 0.02);
  col *= scan * roll;

  // vignette
  col *= 1.0 - vignette * smoothstep(0.15, 0.65, r2);

  col = aces(col);
  // fine grain dither to kill banding
  col += (hash2(in.uv * dims + effectTime) - 0.5) * (1.5 / 255.0);
  return vec4<f32>(col, 1.0);
}
`;
