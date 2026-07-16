// Photo-to-face mapping. MediaPipe FaceLandmarker (WASM, lazy-loaded from CDN
// on first use) detects 468+ landmarks in the uploaded photo. Because our mesh
// IS the canonical landmark topology, each detected landmark's normalized
// image position becomes that vertex's texture coordinate -- the photo warps
// exactly onto the animated head.

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarkerPromise = null;

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      return vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

// file: File/Blob. vertexCount: mesh vertex count (468).
// Returns { bitmap, uvs } or throws Error('no-face') / Error('load-failed').
export async function mapPhoto(file, vertexCount) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('load-failed'); });

  // Downscale very large photos before detection (keeps WASM fast); the
  // original bitmap is still used as the texture.
  let detectSrc = bitmap;
  const maxSide = 1024;
  if (Math.max(bitmap.width, bitmap.height) > maxSide) {
    const s = maxSide / Math.max(bitmap.width, bitmap.height);
    const cv = new OffscreenCanvas(Math.round(bitmap.width * s), Math.round(bitmap.height * s));
    cv.getContext('2d').drawImage(bitmap, 0, 0, cv.width, cv.height);
    detectSrc = cv;
  }

  const lm = await getLandmarker().catch(() => { throw new Error('load-failed'); });
  const res = lm.detect(detectSrc);
  const pts = res.faceLandmarks?.[0];
  if (!pts || pts.length < vertexCount) throw new Error('no-face');

  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uvs[i * 2] = pts[i].x;
    uvs[i * 2 + 1] = pts[i].y;
  }
  return { bitmap, uvs, landmarks: pts, aspect: bitmap.width / bitmap.height };
}


