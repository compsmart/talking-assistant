// Embedded canonical MediaPipe face mesh. Kept in source so the cowork app is self-contained.
import { LIPS_INNER } from './regions.js';
import { FACE_MESH_BASE64 } from './mesh-data.js';

export async function loadFaceMesh() {
  const binary = atob(FACE_MESH_BASE64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const buf = bytes.buffer;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46414345) throw new Error('embedded face mesh: bad magic');
  const vertexCount = dv.getUint32(4, true);
  const triCount = dv.getUint32(8, true);
  const edgeCount = dv.getUint32(12, true);
  let o = 16;
  const positions = new Float32Array(buf, o, vertexCount * 3); o += vertexCount * 12;
  const uvs = new Float32Array(buf, o, vertexCount * 2); o += vertexCount * 8;
  const tris = new Uint32Array(buf, o, triCount * 3).slice(); o += triCount * 12;
  const edges = new Uint32Array(buf, o, edgeCount * 2);
  const inner = new Set(LIPS_INNER);
  const solid = [], cap = [];
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    (inner.has(a) && inner.has(b) && inner.has(c) ? cap : solid).push(a, b, c);
  }
  tris.set(solid); tris.set(cap, solid.length);
  const renderTriCount = solid.length / 3;
  const counts = new Uint32Array(vertexCount);
  for (let t = 0; t < triCount * 3; t++) counts[tris[t]]++;
  const adjOffsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) adjOffsets[v + 1] = adjOffsets[v] + counts[v];
  const adjTris = new Uint32Array(adjOffsets[vertexCount]);
  const cursor = adjOffsets.slice(0, vertexCount);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) {
    const v = tris[t * 3 + k]; adjTris[cursor[v]++] = t;
  }
  return { vertexCount, triCount, renderTriCount, edgeCount, positions, uvs, tris, edges, adjOffsets, adjTris };
}

