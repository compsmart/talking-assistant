import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageProcessingService } from './ImageProcessingService.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(width: number, height: number, paint: (data: Buffer) => void) {
  const root = await mkdtemp(join(tmpdir(), 'cowork-images-')); roots.push(root); await mkdir(join(root, 'uploads'), { recursive: true });
  const data = Buffer.alloc(width * height * 4, 255); paint(data);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(join(root, 'uploads', 'source.png'));
  const context = { id: 'test', name: 'Test', draftDir: root };
  return { root, service: new ImageProcessingService({ active: () => context } as any) };
}

function pixel(data: Buffer, width: number, x: number, y: number, red: number, green: number, blue: number, alpha = 255) {
  const offset = (y * width + x) * 4; data[offset] = red; data[offset + 1] = green; data[offset + 2] = blue; data[offset + 3] = alpha;
}

describe('ImageProcessingService', () => {
  it('removes an edge-connected flat background and crops the result', async () => {
    const { root, service } = await fixture(8, 6, (data) => {
      for (let y = 1; y <= 4; y++) for (let x = 2; x <= 5; x++) pixel(data, 8, x, y, 220, 20, 30);
    });
    const result = await service.removeBackground({ sourcePath: 'uploads/source.png', name: 'subject', mode: 'edge', backgroundColor: '#ffffff', tolerance: 0, crop: true });
    expect(result).toMatchObject({ path: 'assets/processed/backgrounds/subject.webp', width: 4, height: 4, removedPixels: 32, mode: 'edge' });
    const metadata = await sharp(await readFile(join(root, result.path))).metadata(); expect(metadata).toMatchObject({ width: 4, height: 4 });
  });

  it('extracts connected regions as individually transparent assets in visual order', async () => {
    const { root, service } = await fixture(12, 7, (data) => {
      for (let y = 1; y <= 3; y++) for (let x = 1; x <= 2; x++) pixel(data, 12, x, y, 10, 20, 30);
      for (let y = 2; y <= 5; y++) for (let x = 8; x <= 10; x++) pixel(data, 12, x, y, 80, 90, 100);
    });
    const result = await service.extractRegions({ sourcePath: 'uploads/source.png', outputPrefix: 'symbol', backgroundColor: '#ffffff', tolerance: 0, minArea: 2, padding: 0 });
    expect(result.regions).toHaveLength(2);
    expect(result.regions.map((region: any) => region.path)).toEqual(['assets/processed/regions/symbol-01.webp', 'assets/processed/regions/symbol-02.webp']);
    expect(result.regions.map((region: any) => region.bounds)).toEqual([{ x: 1, y: 1, width: 2, height: 3 }, { x: 8, y: 2, width: 3, height: 4 }]);
    await expect(stat(join(root, result.regions[0].path))).resolves.toMatchObject({ size: expect.any(Number) });
    const first = await sharp(await readFile(join(root, result.regions[0].path))).ensureAlpha().raw().toBuffer(); expect(first[3]).toBe(255);
  });

  it('rejects unsupported files and paths outside the workspace', async () => {
    const { service } = await fixture(2, 2, () => undefined);
    await expect(service.removeBackground({ sourcePath: '../outside.png', name: 'bad' })).rejects.toThrow(/escapes the project workspace/);
    await expect(service.extractRegions({ sourcePath: 'source.svg', outputPrefix: 'bad' })).rejects.toThrow(/supports PNG, JPEG, and WebP/);
  });
});
