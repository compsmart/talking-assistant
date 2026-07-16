import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, test } from 'vitest';
import { containGeometry, encodeAnimation, mapVideoFrameToReference, normalizeEndpoint, removeEdgeConnectedBackground } from './AnimationPipeline.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'cowork-animation-')); temporary.push(path); return path; }

describe('animation endpoint geometry', () => {
  test('contains square references on 16:9 video and maps them back without a scale jump', async () => {
    const root = await directory(); const source = join(root, 'source.png'); const transparent = join(root, 'transparent.png'); const green = join(root, 'green.png'); const mapped = join(root, 'mapped.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 50, b: 30, alpha: 1 } } }).png().toFile(source);
    const geometry = await normalizeEndpoint(source, transparent, green, 128, 72); expect(geometry).toMatchObject({ left: 28, top: 0, width: 72, height: 72 });
    await mapVideoFrameToReference(transparent, mapped, geometry); const [expected, actual] = await Promise.all([sharp(source).ensureAlpha().raw().toBuffer(), sharp(mapped).ensureAlpha().raw().toBuffer()]); expect(actual.equals(expected)).toBe(true);
  });

  test('calculates portrait containment deterministically', () => { expect(containGeometry(100, 200, 720, 1280)).toMatchObject({ width: 640, height: 1280, left: 40, top: 0 }); });
});

describe('edge-connected matte', () => {
  test('preserves green subject interiors and confines partial alpha to one boundary pixel', async () => {
    const root = await directory(); const source = join(root, 'source.png'); const output = join(root, 'output.png'); const width = 12; const height = 12;
    const rgba = Buffer.alloc(width * height * 4); for (let index = 0; index < width * height; index++) { rgba[index * 4 + 1] = 255; rgba[index * 4 + 3] = 255; }
    for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) { const offset = (y * width + x) * 4; rgba[offset] = 12; rgba[offset + 1] = 90; rgba[offset + 2] = 24; }
    const interior = (5 * width + 5) * 4; rgba[interior] = 0; rgba[interior + 1] = 255; rgba[interior + 2] = 0;
    await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(source); await removeEdgeConnectedBackground(source, output, { backgroundColor: '#00ff00', tolerance: 48, feather: 1, despill: .5, edgeConnected: true });
    const data = await sharp(output).ensureAlpha().raw().toBuffer(); expect(data[interior + 3]).toBe(255); expect(data[(4 * width + 4) * 4 + 3]).toBe(255);
    const partial: number[] = []; for (let index = 0; index < width * height; index++) if (data[index * 4 + 3] > 0 && data[index * 4 + 3] < 255) partial.push(index); expect(partial.length).toBeGreaterThan(0); expect(partial.every((index) => { const x = index % width; const y = Math.floor(index / width); return x === 3 || x === 8 || y === 3 || y === 8; })).toBe(true);
  });

  test('whole-frame mode removes enclosed green holes and fully despills the retained contour', async () => {
    const root = await directory(); const source = join(root, 'hole.png'); const output = join(root, 'hole-output.png'); const width = 14; const height = 14;
    const rgba = Buffer.alloc(width * height * 4); for (let index = 0; index < width * height; index++) { rgba[index * 4 + 1] = 255; rgba[index * 4 + 3] = 255; }
    for (let y = 2; y <= 11; y++) for (let x = 2; x <= 11; x++) { const offset = (y * width + x) * 4; rgba[offset] = 35; rgba[offset + 1] = 45; rgba[offset + 2] = 55; }
    // An enclosed green opening plus a bright green antialias pixel on its rim.
    for (let y = 5; y <= 8; y++) for (let x = 5; x <= 8; x++) { const offset = (y * width + x) * 4; rgba[offset] = 0; rgba[offset + 1] = 255; rgba[offset + 2] = 0; }
    const fringe = (5 * width + 4) * 4; rgba[fringe] = 18; rgba[fringe + 1] = 205; rgba[fringe + 2] = 16;
    await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(source); await removeEdgeConnectedBackground(source, output, { backgroundColor: '#00ff00', tolerance: 50, feather: 1, despill: 1, edgeConnected: false });
    const data = await sharp(output).ensureAlpha().raw().toBuffer(); expect(data[(6 * width + 6) * 4 + 3]).toBe(0); expect(data[fringe + 3]).toBe(0);
    for (let index = 0; index < width * height; index++) if (data[index * 4 + 3] > 0 && data[index * 4 + 3] < 255) expect(data[index * 4 + 1]).toBeLessThanOrEqual(Math.max(data[index * 4], data[index * 4 + 2]));
  });
});

describe('animation encoding', () => {
  test('encodes exactly 48 lossless frames at 12 FPS for about four seconds', async () => {
    const root = await directory(); const frames = join(root, 'frames'); await import('node:fs/promises').then(({ mkdir }) => mkdir(frames));
    for (let index = 1; index <= 48; index++) await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: index * 4, g: 30, b: 50, alpha: 1 } } }).png().toFile(join(frames, `frame-${String(index).padStart(4, '0')}.png`));
    const output = join(root, 'animation.webp'); const validation = await encodeAnimation(frames, output); expect(validation).toMatchObject({ frameCount: 48, fps: 12 }); expect(validation.durationMs).toBeGreaterThanOrEqual(3990); expect(validation.durationMs).toBeLessThanOrEqual(4010); expect((await readFile(output)).length).toBeGreaterThan(100);
  }, 30_000);
});
