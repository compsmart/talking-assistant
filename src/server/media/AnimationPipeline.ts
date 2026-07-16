import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { run } from '../process.js';
import type { AnimationEncodingSettings, AnimationMatteSettings } from '../../shared/protocol.js';

export const DEFAULT_MATTE: AnimationMatteSettings = { backgroundColor: '#00ff00', tolerance: 48, feather: 1, despill: 1, edgeConnected: false };
export const DEFAULT_ENCODING: AnimationEncodingSettings = { fps: 12, frameCount: 48, lossless: true, quality: 100 };

export interface EndpointGeometry { sourceWidth: number; sourceHeight: number; videoWidth: number; videoHeight: number; left: number; top: number; width: number; height: number }

export function containGeometry(sourceWidth: number, sourceHeight: number, videoWidth: number, videoHeight: number): EndpointGeometry {
  const scale = Math.min(videoWidth / sourceWidth, videoHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale));
  return { sourceWidth, sourceHeight, videoWidth, videoHeight, width, height, left: Math.floor((videoWidth - width) / 2), top: Math.floor((videoHeight - height) / 2) };
}

export async function normalizeEndpoint(source: string, transparentPath: string, greenPath: string, videoWidth: number, videoHeight: number) {
  const image = sharp(source, { animated: false }).autoOrient(); const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('The endpoint image has no readable dimensions.');
  const geometry = containGeometry(metadata.width, metadata.height, videoWidth, videoHeight);
  const subject = await image.ensureAlpha().resize(geometry.width, geometry.height, { fit: 'fill' }).png().toBuffer();
  await mkdir(dirname(transparentPath), { recursive: true });
  await sharp({ create: { width: videoWidth, height: videoHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: subject, left: geometry.left, top: geometry.top }]).png().toFile(transparentPath);
  await sharp({ create: { width: videoWidth, height: videoHeight, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).composite([{ input: subject, left: geometry.left, top: geometry.top }]).removeAlpha().png().toFile(greenPath);
  return geometry;
}

export async function mapVideoFrameToReference(source: string, destination: string, geometry: EndpointGeometry) {
  await sharp(source).extract({ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height })
    .resize(geometry.sourceWidth, geometry.sourceHeight, { fit: 'fill' }).ensureAlpha().png().toFile(destination);
}

export async function removeEdgeConnectedBackground(source: string, destination: string, settings: AnimationMatteSettings = DEFAULT_MATTE) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info; const pixels = width * height; const background = medianBorder(data, width, height);
  const matte = new Uint8Array(pixels); const queue = new Int32Array(pixels); let head = 0; let tail = 0;
  const matches = (index: number) => {
    const red = data[index * 4]; const green = data[index * 4 + 1]; const blue = data[index * 4 + 2];
    const distance = Math.max(Math.abs(red - background[0]), Math.abs(green - background[1]), Math.abs(blue - background[2]));
    // Include bright, green-dominant antialias pixels just outside the strict
    // tolerance. This removes the one-pixel neon fringe without eating dark
    // green clothing or other intentional subject interiors.
    const stageFringe = settings.edgeConnected && green > 140 && green > red + 60 && green > blue + 60 && distance <= settings.tolerance + 40;
    return distance <= settings.tolerance || stageFringe;
  };
  const add = (index: number) => { if (!matte[index] && matches(index)) { matte[index] = 1; queue[tail++] = index; } };
  if (settings.edgeConnected) {
    for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { add(y * width); add(y * width + width - 1); }
    while (head < tail) { const index = queue[head++]; const x = index % width; const y = Math.floor(index / width); if (x) add(index - 1); if (x + 1 < width) add(index + 1); if (y) add(index - width); if (y + 1 < height) add(index + width); }
  } else for (let index = 0; index < pixels; index++) if (matches(index)) matte[index] = 1;
  const output = Buffer.from(data); const feather = Math.max(0, Math.min(4, Math.round(settings.feather)));
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4;
    if (matte[index]) { output[offset + 3] = 0; continue; }
    output[offset + 3] = 255;
    const x = index % width; const y = Math.floor(index / width); let boundary = false;
    for (let dy = -feather; dy <= feather && !boundary; dy++) for (let dx = -feather; dx <= feather; dx++) {
      const nx = x + dx; const ny = y + dy; if (nx >= 0 && nx < width && ny >= 0 && ny < height && matte[ny * width + nx]) { boundary = true; break; }
    }
    if (boundary && feather) {
      output[offset + 3] = 192;
      const neutralGreen = Math.max(output[offset], output[offset + 2]);
      output[offset + 1] = Math.max(0, Math.round(output[offset + 1] * (1 - settings.despill) + Math.min(output[offset + 1], neutralGreen) * settings.despill));
    }
  }
  await sharp(output, { raw: { width, height, channels: 4 } }).png().toFile(destination);
  return { width, height, background: `#${background.map((value) => value.toString(16).padStart(2, '0')).join('')}`, removedPixels: matte.reduce((sum, value) => sum + value, 0) };
}

function medianBorder(data: Buffer, width: number, height: number): [number, number, number] {
  const values: number[][] = [[], [], []]; const strip = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 16)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x < strip || x >= width - strip || y < strip || y >= height - strip) {
    const offset = (y * width + x) * 4; for (let channel = 0; channel < 3; channel++) values[channel].push(data[offset + channel]);
  }
  return values.map((items) => { items.sort((a, b) => a - b); return items[Math.floor(items.length / 2)] || 0; }) as [number, number, number];
}

export async function extractFourSecondFrames(videoPath: string, directory: string) {
  await mkdir(directory, { recursive: true });
  await ffmpeg(['-y', '-i', videoPath, '-vf', 'setpts=0.5*PTS,fps=12', '-vsync', 'passthrough', '-frames:v', '48', join(directory, 'frame-%04d.png')]);
  const frames = (await readdir(directory)).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort().map((name) => join(directory, name));
  if (frames.length !== 48) throw new Error(`Animation extraction produced ${frames.length} frames; expected exactly 48.`);
  return frames;
}

export async function encodeAnimation(framesDirectory: string, destination: string, settings: AnimationEncodingSettings = DEFAULT_ENCODING) {
  await ffmpeg(['-y', '-framerate', String(settings.fps), '-start_number', '1', '-i', join(framesDirectory, 'frame-%04d.png'), '-frames:v', String(settings.frameCount), '-c:v', 'libwebp_anim', ...(settings.lossless ? ['-lossless', '1', '-compression_level', '6'] : ['-quality', String(settings.quality)]), '-loop', '0', '-pix_fmt', 'yuva420p', destination]);
  return validateAnimation(destination, settings);
}

export async function validateAnimation(path: string, settings: AnimationEncodingSettings = DEFAULT_ENCODING) {
  const data = await readFile(path); if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`${basename(path)} is not a WebP file.`);
  let offset = 12; let frameCount = 0; let durationMs = 0;
  while (offset + 8 <= data.length) { const type = data.toString('ascii', offset, offset + 4); const size = data.readUInt32LE(offset + 4); const payload = offset + 8; if (type === 'ANMF' && size >= 16) { frameCount++; durationMs += data[payload + 12] | (data[payload + 13] << 8) | (data[payload + 14] << 16); } offset = payload + size + (size % 2); }
  if (frameCount !== settings.frameCount) throw new Error(`Encoded animation has ${frameCount} frames; expected ${settings.frameCount}.`);
  if (Math.abs(durationMs - 4000) > 150) throw new Error(`Encoded animation is ${durationMs}ms; expected approximately 4000ms.`);
  return { frameCount, durationMs, fps: settings.fps };
}

async function ffmpeg(args: string[]) { const result = await run(config.ffmpegPath, args, { timeout: config.mediaTimeoutMs }); if (result.code) throw new Error(`FFmpeg failed: ${result.stderr || result.stdout}`); }
