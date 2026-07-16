import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import sharp from 'sharp';
import { mimeFor, safeWorkspacePath } from './WorkspaceFiles.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

const INPUT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_PIXELS = 25_000_000;

interface Color { red: number; green: number; blue: number }

export class ImageProcessingService {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async removeBackground(args: any) {
    const sourcePath = String(args?.sourcePath || '');
    const source = await this.source(sourcePath);
    const mode = args?.mode === 'color' ? 'color' : 'edge';
    const tolerance = boundedInteger(args?.tolerance, 0, 255, 28);
    const padding = boundedInteger(args?.padding, 0, 512, 0);
    const image = sharp(source).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    assertSize(info.width, info.height);
    const target = args?.backgroundColor ? parseColor(args.backgroundColor) : sampleCorners(data, info.width, info.height);
    const removed = mode === 'color'
      ? removeMatchingPixels(data, target, tolerance)
      : removeEdgeConnectedPixels(data, info.width, info.height, target, tolerance);
    if (!removed) throw new Error('No background pixels matched the requested color and tolerance.');

    const crop = args?.crop !== false;
    const bounds = crop ? alphaBounds(data, info.width, info.height, padding) : { left: 0, top: 0, width: info.width, height: info.height };
    if (!bounds) throw new Error('Background removal made the entire image transparent.');
    const destination = await this.destination('backgrounds', args?.name || basename(sourcePath, extname(sourcePath)));
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .extract(bounds).webp({ lossless: true }).toFile(destination.absolute);
    return {
      ok: true, path: destination.relative, width: bounds.width, height: bounds.height, removedPixels: removed,
      mode, backgroundColor: colorHex(target), tolerance,
    };
  }

  async extractRegions(args: any) {
    const sourcePath = String(args?.sourcePath || '');
    const source = await this.source(sourcePath);
    const tolerance = boundedInteger(args?.tolerance, 0, 255, 28);
    const minArea = boundedInteger(args?.minArea, 1, MAX_PIXELS, 64);
    const padding = boundedInteger(args?.padding, 0, 512, 2);
    const connectivity = Number(args?.connectivity) === 4 ? 4 : 8;
    const maxRegions = boundedInteger(args?.maxRegions, 1, 200, 100);
    const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assertSize(info.width, info.height);
    const target = args?.backgroundColor ? parseColor(args.backgroundColor) : sampleCorners(data, info.width, info.height);
    const labels = new Int32Array(info.width * info.height);
    const queue = new Int32Array(info.width * info.height);
    const regions: Array<{ label: number; area: number; left: number; top: number; right: number; bottom: number }> = [];
    const isForeground = (index: number) => data[index * 4 + 3] > 8 && colorDistanceAt(data, index * 4, target) > tolerance;
    let label = 0;

    for (let pixel = 0; pixel < labels.length; pixel++) {
      if (labels[pixel] || !isForeground(pixel)) continue;
      label++; let head = 0; let tail = 0; queue[tail++] = pixel; labels[pixel] = label;
      let area = 0; let left = info.width; let top = info.height; let right = 0; let bottom = 0;
      while (head < tail) {
        const current = queue[head++]; const x = current % info.width; const y = Math.floor(current / info.width);
        area++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const neighbor of neighbors(x, y, info.width, info.height, connectivity)) {
          if (!labels[neighbor] && isForeground(neighbor)) { labels[neighbor] = label; queue[tail++] = neighbor; }
        }
      }
      if (area >= minArea) regions.push({ label, area, left, top, right, bottom });
    }

    regions.sort((a, b) => a.top - b.top || a.left - b.left);
    const selected = regions.slice(0, maxRegions); const output = [];
    const prefix = slug(String(args?.outputPrefix || basename(sourcePath, extname(sourcePath))));
    for (let index = 0; index < selected.length; index++) {
      const region = selected[index];
      const left = Math.max(0, region.left - padding); const top = Math.max(0, region.top - padding);
      const right = Math.min(info.width - 1, region.right + padding); const bottom = Math.min(info.height - 1, region.bottom + padding);
      const width = right - left + 1; const height = bottom - top + 1; const pixels = Buffer.alloc(width * height * 4);
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const sourcePixel = y * info.width + x; if (labels[sourcePixel] !== region.label) continue;
        const sourceOffset = sourcePixel * 4; const targetOffset = ((y - top) * width + x - left) * 4;
        data.copy(pixels, targetOffset, sourceOffset, sourceOffset + 4);
      }
      const destination = await this.destination('regions', `${prefix}-${String(index + 1).padStart(2, '0')}`);
      await sharp(pixels, { raw: { width, height, channels: 4 } }).webp({ lossless: true }).toFile(destination.absolute);
      output.push({ path: destination.relative, bounds: { x: left, y: top, width, height }, pixelArea: region.area });
    }
    return { ok: true, sourcePath, backgroundColor: colorHex(target), tolerance, regions: output, detectedRegions: regions.length, truncated: regions.length > selected.length };
  }

  private async source(path: string) {
    if (!path) throw new Error('A workspace-relative sourcePath is required.');
    if (!INPUT_MIME_TYPES.has(mimeFor(path))) throw new Error('Image processing supports PNG, JPEG, and WebP source files.');
    return safeWorkspacePath(this.registry.active().draftDir, path, true);
  }

  private async destination(kind: 'backgrounds' | 'regions', requested: unknown) {
    const root = this.registry.active().draftDir; const directory = join(root, 'assets', 'processed', kind); await mkdir(directory, { recursive: true });
    const stem = slug(String(requested || kind)); let name = `${stem}.webp`; let index = 2;
    while (await stat(join(directory, name)).then(() => true).catch(() => false)) name = `${stem}-${index++}.webp`;
    const absolute = join(directory, name); return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') };
  }
}

function assertSize(width: number, height: number) { if (!width || !height || width * height > MAX_PIXELS) throw new Error(`Images may contain at most ${MAX_PIXELS.toLocaleString()} pixels.`); }
function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'image'; }
function parseColor(value: unknown): Color {
  const match = String(value).trim().match(/^#?([a-f\d]{6})$/i); if (!match) throw new Error('backgroundColor must be a six-digit hex color such as #00ff00.');
  return { red: parseInt(match[1].slice(0, 2), 16), green: parseInt(match[1].slice(2, 4), 16), blue: parseInt(match[1].slice(4, 6), 16) };
}
function sampleCorners(data: Buffer, width: number, height: number): Color {
  const points = [0, width - 1, (height - 1) * width, height * width - 1];
  const values = points.map((pixel) => ({ red: data[pixel * 4], green: data[pixel * 4 + 1], blue: data[pixel * 4 + 2] }));
  values.sort((a, b) => totalDistance(a, values) - totalDistance(b, values)); return values[0];
}
function totalDistance(color: Color, values: Color[]) { return values.reduce((sum, value) => sum + Math.max(Math.abs(color.red - value.red), Math.abs(color.green - value.green), Math.abs(color.blue - value.blue)), 0); }
function colorDistanceAt(data: Buffer, offset: number, target: Color) { return Math.max(Math.abs(data[offset] - target.red), Math.abs(data[offset + 1] - target.green), Math.abs(data[offset + 2] - target.blue)); }
function colorHex(color: Color) { return `#${[color.red, color.green, color.blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`; }
function removeMatchingPixels(data: Buffer, target: Color, tolerance: number) { let removed = 0; for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3] && colorDistanceAt(data, offset, target) <= tolerance) { data[offset + 3] = 0; removed++; } return removed; }
function removeEdgeConnectedPixels(data: Buffer, width: number, height: number, target: Color, tolerance: number) {
  const seen = new Uint8Array(width * height); const queue = new Int32Array(width * height); let head = 0; let tail = 0; let removed = 0;
  const enqueue = (pixel: number) => { if (!seen[pixel] && data[pixel * 4 + 3] && colorDistanceAt(data, pixel * 4, target) <= tolerance) { seen[pixel] = 1; queue[tail++] = pixel; } };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) { const pixel = queue[head++]; data[pixel * 4 + 3] = 0; removed++; const x = pixel % width; const y = Math.floor(pixel / width); for (const neighbor of neighbors(x, y, width, height, 4)) enqueue(neighbor); }
  return removed;
}
function alphaBounds(data: Buffer, width: number, height: number, padding: number) {
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let pixel = 0; pixel < width * height; pixel++) if (data[pixel * 4 + 3]) { const x = pixel % width; const y = Math.floor(pixel / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  if (right < 0) return undefined;
  left = Math.max(0, left - padding); top = Math.max(0, top - padding); right = Math.min(width - 1, right + padding); bottom = Math.min(height - 1, bottom + padding);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
function neighbors(x: number, y: number, width: number, height: number, connectivity: 4 | 8) {
  const output: number[] = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((!dx && !dy) || (connectivity === 4 && dx && dy)) continue; const nextX = x + dx; const nextY = y + dy;
    if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height) output.push(nextY * width + nextX);
  } return output;
}
