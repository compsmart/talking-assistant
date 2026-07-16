// Procedural inner mouth: teeth arches, gums, tongue, throat cavity.
// Built parametrically from the same anchors as the face rig, so it sits
// exactly behind the lip seam. Lower arch + tongue carry jawness = 1 and are
// rotated in the vertex shader about the same ear-axis pivot as the jawOpen
// morph, so teeth track the jaw perfectly.
//
// Vertex layout (expanded triangles, 9 floats each):
//   pos.xyz, normal.xyz, part, jawness, aux
// part: 0 gum, 1 tooth, 2 tongue, 3 cavity
// aux:  tongue = normalized distance from tongue root (drives tip animation)

import { ANCHOR } from './regions.js';

const PART = { gum: 0, tooth: 1, tongue: 2, cavity: 3 };

export function buildMouth(mesh, rig) {
  const pos = mesh.positions;
  const S = rig.unit;
  const [mx, my, mz] = rig.mouthCenter;
  const cL = [pos[ANCHOR.mouthCornerL * 3], pos[ANCHOR.mouthCornerL * 3 + 1], pos[ANCHOR.mouthCornerL * 3 + 2]];
  const cR = [pos[ANCHOR.mouthCornerR * 3], pos[ANCHOR.mouthCornerR * 3 + 1], pos[ANCHOR.mouthCornerR * 3 + 2]];
  const W = Math.hypot(cL[0] - cR[0], cL[1] - cR[1], cL[2] - cR[2]); // mouth width

  const seamY = my;
  const zFront = mz - 0.07 * S;   // front of the dental arches, behind the lips
  const archA = 0.60 * W;         // arch half-width
  const archB = 0.42 * S;         // arch depth
  const zBack = zFront - archB - 0.12 * S;

  const verts = []; // flat 9-float records, 3 per triangle

  const tri = (a, b, c, n, part, jaw, auxA = 0, auxB = 0, auxC = 0) => {
    verts.push(
      a[0], a[1], a[2], n[0], n[1], n[2], part, jaw, auxA,
      b[0], b[1], b[2], n[0], n[1], n[2], part, jaw, auxB,
      c[0], c[1], c[2], n[0], n[1], n[2], part, jaw, auxC,
    );
  };
  const quad = (a, b, c, d, n, part, jaw, aux = [0, 0, 0, 0]) => {
    tri(a, b, c, n, part, jaw, aux[0], aux[1], aux[2]);
    tri(a, c, d, n, part, jaw, aux[0], aux[2], aux[3]);
  };
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  // arch curve: t in [-1, 1] -> point on the dental arch + outward normal (xz)
  // s scales the arch (the lower/mandibular arch is slightly narrower + recessed)
  const arch = (t, s = 1) => {
    const ang = t * 1.25; // +-72 degrees
    const x = mx + archA * s * Math.sin(ang);
    const z = zFront - (1 - s) * 0.5 * S - archB * s * (1 - Math.cos(ang));
    return { x, z, nx: Math.sin(ang), nz: Math.cos(ang) };
  };

  // ---- teeth + gums for one arch ------------------------------------------
  // upper: gums above, teeth hang down. lower: mirrored, jawness 1.
  function dentalArch(isUpper) {
    const jaw = isUpper ? 0 : 1;
    const dir = isUpper ? 1 : -1;                    // gum side of the bite
    const as = isUpper ? 1 : 0.93;                   // lower arch narrower + recessed
    // upper incisors hang below the lip seam (visible when the mouth opens);
    // lower bite sits under them (overbite) and drops away with the jaw
    const biteY = isUpper ? seamY - 0.030 * S : seamY - 0.052 * S;
    const toothH = isUpper ? 0.095 * S : 0.085 * S;
    const gumY = biteY + dir * toothH;
    const gumTopY = gumY + dir * 0.075 * S;
    const thick = 0.055 * S;                          // tooth depth (outer->inner)
    const NT = 10;                                    // teeth per arch

    // Teeth are contiguous -- no gaps, flat bite edge. Separation is drawn,
    // not modeled: each tooth's faces are center-split with aux = 0 at the
    // boundaries and 1 at the crown center, which the shader shades into a
    // groove (wire mode draws the boundary edge itself).
    const scallop = 0;
    const taper = 0.012 * S;
    for (let i = 0; i < NT; i++) {
      const t0 = -1 + (2 * i) / NT;
      const t1 = -1 + (2 * (i + 1)) / NT;
      const tc = (t0 + t1) / 2;
      const p0 = arch(t0, as), pc = arch(tc, as), p1 = arch(t1, as);
      const o = (p, y) => [p.x, y, p.z];                                    // outer shell
      const q = (p, y) => [p.x - p.nx * thick, y, p.z - p.nz * thick];      // inner shell
      const ob = (p, y) => [p.x - p.nx * taper, y, p.z - p.nz * taper];     // tapered bite rim
      const nOut = norm([pc.nx, 0, pc.nz]);
      const nIn = [-nOut[0], 0, -nOut[2]];
      const nBite = [0, -dir, 0];
      const bE = biteY + scallop;                                            // scalloped corners
      // outer face (two quads, aux edge->center->edge)
      quad(o(p0, gumY), o(pc, gumY), ob(pc, biteY), ob(p0, bE), nOut, PART.tooth, jaw, [0, 1, 1, 0]);
      quad(o(pc, gumY), o(p1, gumY), ob(p1, bE), ob(pc, biteY), nOut, PART.tooth, jaw, [1, 0, 0, 1]);
      // inner face
      quad(q(p0, gumY), q(pc, gumY), q(pc, biteY), q(p0, bE), nIn, PART.tooth, jaw, [0, 1, 1, 0]);
      quad(q(pc, gumY), q(p1, gumY), q(p1, bE), q(pc, biteY), nIn, PART.tooth, jaw, [1, 0, 0, 1]);
      // bite face
      quad(ob(p0, bE), ob(pc, biteY), q(pc, biteY), q(p0, bE), nBite, PART.tooth, jaw, [0, 1, 1, 0]);
      quad(ob(pc, biteY), ob(p1, bE), q(p1, bE), q(pc, biteY), nBite, PART.tooth, jaw, [1, 0, 0, 1]);
      // arch end caps only (interior sides are gone with the gaps)
      if (i === 0) {
        const nS = norm([p0.nz, 0, -p0.nx]);
        quad(o(p0, gumY), ob(p0, bE), q(p0, bE), q(p0, gumY), nS, PART.tooth, jaw);
      }
      if (i === NT - 1) {
        const nS = norm([-p1.nz, 0, p1.nx]);
        quad(o(p1, gumY), ob(p1, bE), q(p1, bE), q(p1, gumY), nS, PART.tooth, jaw);
      }
    }

    // gum band: smooth strip over the tooth roots (outer + inner + crest)
    const NG = 22;
    for (let i = 0; i < NG; i++) {
      const t0 = -1 + (2 * i) / NG;
      const t1 = -1 + (2 * (i + 1)) / NG;
      const p0 = arch(t0, as), p1 = arch(t1, as);
      const bulge = 0.018 * S; // gums puff slightly outward
      const oG = (p, y, b) => [p.x + p.nx * b, y, p.z + p.nz * b];
      const qG = (p, y) => [p.x - p.nx * 0.06 * S, y, p.z - p.nz * 0.06 * S];
      const nOut = norm([(p0.nx + p1.nx) / 2, dir * 0.35, (p0.nz + p1.nz) / 2]);
      const nCrest = [0, dir, 0];
      quad(oG(p0, gumY, bulge), oG(p1, gumY, bulge), oG(p1, gumTopY, bulge * 0.4), oG(p0, gumTopY, bulge * 0.4), nOut, PART.gum, jaw);
      quad(oG(p0, gumTopY, bulge * 0.4), oG(p1, gumTopY, bulge * 0.4), qG(p1, gumTopY), qG(p0, gumTopY), nCrest, PART.gum, jaw); // crest
      quad(qG(p0, gumTopY), qG(p1, gumTopY), qG(p1, gumY), qG(p0, gumY), [-nOut[0], nOut[1], -nOut[2]], PART.gum, jaw); // inner
    }
  }
  dentalArch(true);
  dentalArch(false);

  // ---- tongue ----------------------------------------------------------------
  {
    const L = 0.42 * S;                 // root -> tip length
    const floorY = seamY - 0.085 * S;   // resting on the lower jaw floor
    const tipZ = zFront - 0.10 * S;
    const rootZ = tipZ - L;
    const NU = 12, NV = 8;
    const P = [];                        // grid points
    for (let iu = 0; iu <= NU; iu++) {
      const u = iu / NU;                 // 0 root -> 1 tip
      const width = 0.30 * S * (0.45 + 0.55 * Math.sin(Math.min(1, 0.25 + u) * Math.PI * 0.62));
      const row = [];
      for (let iv = 0; iv <= NV; iv++) {
        const v = iv / NV;
        const x = mx + (v - 0.5) * width;
        const dome = Math.sin(v * Math.PI);
        const groove = 0.35 * Math.exp(-(((v - 0.5) * 5) ** 2));
        const y = floorY + 0.055 * S * dome * (0.55 + 0.45 * Math.sin(u * Math.PI)) * (1 - groove);
        const z = rootZ + u * L;
        row.push([x, y, z]);
      }
      P.push(row);
    }
    for (let iu = 0; iu < NU; iu++) {
      for (let iv = 0; iv < NV; iv++) {
        const a = P[iu][iv], b = P[iu][iv + 1], c = P[iu + 1][iv + 1], d = P[iu + 1][iv];
        // per-face normal from the quad
        const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const e2 = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
        const n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
        const nn = n[1] < 0 ? [-n[0], -n[1], -n[2]] : n; // keep tongue normals up
        const u0 = iu / NU, u1 = (iu + 1) / NU;
        quad(a, b, c, d, nn, PART.tongue, 1, [u0, u0, u1, u1]);
      }
    }
  }

  // ---- throat cavity backdrop -------------------------------------------------
  {
    const NC = 12, NR = 3;
    const yTop = seamY + 0.30 * S, yBot = seamY - 0.30 * S;
    for (let i = 0; i < NC; i++) {
      const t0 = -1 + (2 * i) / NC, t1 = -1 + (2 * (i + 1)) / NC;
      const c0 = arch(t0), c1 = arch(t1);
      const back = (p, k) => [mx + (p.x - mx) * 1.15, 0, zBack + (p.z - zFront + archB) * 0.35];
      for (let r = 0; r < NR; r++) {
        const y0 = yBot + ((yTop - yBot) * r) / NR;
        const y1 = yBot + ((yTop - yBot) * (r + 1)) / NR;
        const b0 = back(c0), b1 = back(c1);
        quad([b0[0], y0, b0[2]], [b1[0], y0, b1[2]], [b1[0], y1, b1[2]], [b0[0], y1, b0[2]], [0, 0, 1], PART.cavity, 0.5);
      }
    }
  }

  return {
    data: new Float32Array(verts),
    vertexCount: verts.length / 9,
    zFront, zBack,
  };
}


