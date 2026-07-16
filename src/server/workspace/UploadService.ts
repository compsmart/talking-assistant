import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, extname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { fileTypeFromFile } from 'file-type';
import { config } from '../config.js';
import { run } from '../process.js';
import type { AssetRecord } from '../../shared/protocol.js';
import { safeWorkspacePath, statusError } from './WorkspaceFiles.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

const MAX_FILES = 20;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const ALLOWED_AUDIO_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/ogg']);
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

interface PendingUpload { temporary: string; originalName: string; mimeType?: string }
type UploadAccept = 'media' | 'image' | 'file';

export class UploadService {
  constructor(private readonly registry: WorkspaceRegistry) {}
  async receive(request: IncomingMessage) {
    const context = this.registry.active(); const job = join(context.mediaJobsDir, `upload-${randomUUID()}`); await mkdir(job, { recursive: true });
    const pending: PendingUpload[] = [];
    let destinationInput: string | undefined;
    let acceptInput: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let count = 0; const writes: Promise<void>[] = [];
        const parser = Busboy({ headers: request.headers, limits: { files: MAX_FILES, fields: 2, fieldSize: 2048, fileSize: MAX_FILE_SIZE, parts: MAX_FILES + 2 } });
        parser.on('field', (name, value) => {
          if (name === 'destination') destinationInput = value;
          if (name === 'accept') acceptInput = value;
        });
        parser.on('file', (_field, stream, info) => {
          count++; if (count > MAX_FILES) { stream.resume(); return; }
          const temporary = join(job, `${count}.upload`); pending.push({ temporary, originalName: info.filename || `upload-${count}`, mimeType: info.mimeType });
          let truncated = false; stream.on('limit', () => { truncated = true; });
          writes.push(pipeline(stream, createWriteStream(temporary)).then(() => { if (truncated) throw statusError(`${info.filename} exceeds the 100 MB upload limit.`, 413); }));
        });
        parser.on('filesLimit', () => reject(statusError(`A drop can contain at most ${MAX_FILES} files.`, 413)));
        parser.on('fieldsLimit', () => reject(statusError('An upload can include only destination and accept fields.', 413)));
        parser.on('partsLimit', () => reject(statusError(`A drop can contain at most ${MAX_FILES} files.`, 413)));
        parser.on('error', reject); parser.on('finish', () => Promise.all(writes).then(() => resolve(), reject)); request.pipe(parser);
      });
      if (!pending.length) throw statusError('No media files were included in the upload.', 400);
      const accept = parseAccept(acceptInput);
      for (const item of pending) {
        item.mimeType = await detectMimeType(item);
        if (accept !== 'file' && (!isAllowedMedia(item.mimeType) || (accept === 'image' && !item.mimeType.startsWith('image/')))) {
          throw statusError(accept === 'image'
            ? `${item.originalName} is not a supported image file.`
            : `${item.originalName} is not a supported image, video, or audio file.`, 415);
        }
      }
      const requestedDirectory = destinationInput === undefined ? undefined : await uploadDirectory(context.draftDir, destinationInput);
      const records: AssetRecord[] = [];
      for (const item of pending) records.push(await this.process(item, context.draftDir, requestedDirectory, accept === 'file'));
      await this.updateManifest(records, context.draftDir);
      return records;
    } finally { await rm(job, { recursive: true, force: true }); }
  }

  private async process(item: PendingUpload, draftDir: string, requestedDirectory?: string, preserveOriginal = false): Promise<AssetRecord> {
    let mimeType = item.mimeType!;
    const raster = !preserveOriginal && shouldNormalizeImage(mimeType);
    const directory = requestedDirectory || defaultUploadDirectory(draftDir, mimeType); await mkdir(directory, { recursive: true });
    const extension = raster ? '.webp' : preserveOriginal ? extname(item.originalName).toLowerCase() : normalizedExtension(mimeType, item.originalName); const stem = slug(item.originalName);
    let filename = `${stem}${extension}`; let index = 2; while (await exists(join(directory, filename))) filename = `${stem}-${index++}${extension}`;
    const destination = join(directory, filename);
    if (raster) {
      const animated = mimeType === 'image/gif'; const args = ['-y', '-i', item.temporary, '-c:v', animated ? 'libwebp_anim' : 'libwebp', '-quality', animated ? '82' : '86', ...(animated ? ['-loop', '0'] : ['-frames:v', '1']), destination];
      const result = await run(config.ffmpegPath, args, { timeout: config.mediaTimeoutMs }); if (result.code) throw new Error(`Could not convert ${item.originalName}: ${result.stderr || result.stdout}`);
      mimeType = 'image/webp';
    } else await rename(item.temporary, destination);
    const path = relative(draftDir, destination).replaceAll('\\', '/');
    return { id: randomUUID(), kind: 'upload', path, originalName: item.originalName, mimeType, size: (await stat(destination)).size, createdAt: new Date().toISOString() };
  }

  private async updateManifest(records: AssetRecord[], draftDir: string) {
    const path = join(draftDir, 'uploads', 'manifest.json'); await mkdir(join(draftDir, 'uploads'), { recursive: true });
    const current: AssetRecord[] = await readFile(path, 'utf8').then(JSON.parse).catch(() => []);
    await writeFile(path, JSON.stringify([...current, ...records], null, 2) + '\n', 'utf8');
  }
}

async function detectMimeType(item: PendingUpload) {
  const detected = await fileTypeFromFile(item.temporary).catch(() => undefined); let mimeType = detected?.mime || '';
  if (!mimeType && extname(item.originalName).toLowerCase() === '.svg') {
    const prefix = (await readFile(item.temporary, 'utf8')).slice(0, 2000).toLowerCase(); if (prefix.includes('<svg')) mimeType = 'image/svg+xml';
  }
  return mimeType || item.mimeType || 'application/octet-stream';
}

export function isAllowedMedia(mimeType: string) { return mimeType.startsWith('image/') || ALLOWED_AUDIO_VIDEO.has(mimeType); }
export function shouldNormalizeImage(mimeType: string) { return mimeType.startsWith('image/') && !['image/webp', 'image/svg+xml'].includes(mimeType); }
export function defaultUploadDirectory(draftDir: string, mimeType: string) {
  if (mimeType.startsWith('image/')) return join(draftDir, 'uploads', 'images');
  if (mimeType.startsWith('audio/')) return join(draftDir, 'uploads');
  return join(draftDir, 'uploads', 'media');
}
export function parseAccept(value?: string): UploadAccept {
  if (value === undefined || value === '' || value === 'media') return 'media';
  if (value === 'image') return 'image';
  if (value === 'file') return 'file';
  throw statusError('Upload accept must be media, image, or file.', 400);
}
export async function uploadDirectory(draftDir: string, input: string) {
  const path = input.trim() || '.';
  if (path.split(/[\\/]/).some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) throw statusError('Uploads cannot target an ignored workspace directory.', 403);
  const directory = await safeWorkspacePath(draftDir, path, true); const info = await stat(directory);
  if (!info.isDirectory()) throw statusError('The upload destination must be an existing workspace directory.', 400);
  return directory;
}

function slug(value: string) { return basename(value, extname(value)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'upload'; }
function normalizedExtension(mime: string, original: string) {
  const map: Record<string, string> = { 'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg' };
  return map[mime] || extname(original).toLowerCase();
}
async function exists(path: string) { return stat(path).then(() => true).catch(() => false); }
