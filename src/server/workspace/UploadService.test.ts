import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultUploadDirectory, isAllowedMedia, parseAccept, shouldNormalizeImage, UploadService, uploadDirectory } from './UploadService.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace media uploads', () => {
  it('accepts broadly detected images while retaining the audio/video allowlist', () => {
    for (const mime of ['image/avif', 'image/heic', 'image/heif', 'image/tiff', 'image/bmp', 'image/jxl', 'image/x-icon']) expect(isAllowedMedia(mime)).toBe(true);
    for (const mime of ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav']) expect(isAllowedMedia(mime)).toBe(true);
    for (const mime of ['application/pdf', 'application/zip', 'text/plain']) expect(isAllowedMedia(mime)).toBe(false);
  });

  it('normalizes raster images but preserves SVG and WebP', () => {
    expect(shouldNormalizeImage('image/avif')).toBe(true);
    expect(shouldNormalizeImage('image/tiff')).toBe(true);
    expect(shouldNormalizeImage('image/gif')).toBe(true);
    expect(shouldNormalizeImage('image/webp')).toBe(false);
    expect(shouldNormalizeImage('image/svg+xml')).toBe(false);
  });

  it('places MP3 audio directly in the workspace uploads directory', async () => {
    const root = await workspace(); const jobs = join(root, '.jobs'); await mkdir(jobs);
    expect(defaultUploadDirectory(root, 'audio/mpeg')).toBe(join(root, 'uploads'));
    const service = new UploadService({ active: () => ({ draftDir: root, mediaJobsDir: jobs }) } as any);
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]);
    const records = await service.receive(multipartRequest([], 'theme.mp3', 'audio/mpeg', mp3));
    expect(records[0]).toMatchObject({ path: 'uploads/theme.mp3', mimeType: 'audio/mpeg' });
    expect(await readFile(join(root, 'uploads', 'theme.mp3'))).toEqual(mp3);
  });

  it('validates the image-only upload contract', () => {
    expect(parseAccept()).toBe('media');
    expect(parseAccept('media')).toBe('media');
    expect(parseAccept('image')).toBe('image');
    expect(parseAccept('file')).toBe('file');
    expect(() => parseAccept('document')).toThrow(/media, image, or file/);
  });

  it('allows only existing, visible workspace directories', async () => {
    const root = await workspace(); await mkdir(join(root, 'public', 'images'), { recursive: true });
    expect(await uploadDirectory(root, 'public/images')).toBe(join(root, 'public', 'images'));
    expect(await uploadDirectory(root, '.')).toBe(root);
    await expect(uploadDirectory(root, '../outside')).rejects.toThrow(/escapes/);
    await expect(uploadDirectory(root, 'node_modules')).rejects.toThrow(/ignored/);
    await expect(uploadDirectory(root, 'missing')).rejects.toThrow();
    await writeFile(join(root, 'file.txt'), 'not a directory');
    await expect(uploadDirectory(root, 'file.txt')).rejects.toThrow(/existing workspace directory/);
  });

  it('stores a preserved image in the exact requested folder and records it', async () => {
    const root = await workspace(); const jobs = join(root, '.jobs'); await mkdir(join(root, 'public', 'art'), { recursive: true }); await mkdir(jobs);
    const service = new UploadService({ active: () => ({ draftDir: root, mediaJobsDir: jobs }) } as any);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><path d="M0 0h4v4H0z"/></svg>';
    const request = multipartRequest([{ name: 'destination', value: 'public/art' }, { name: 'accept', value: 'image' }], 'logo.svg', 'image/svg+xml', Buffer.from(svg));
    const records = await service.receive(request);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ path: 'public/art/logo.svg', originalName: 'logo.svg', mimeType: 'image/svg+xml' });
    expect(await readFile(join(root, 'public', 'art', 'logo.svg'), 'utf8')).toBe(svg);
    expect(JSON.parse(await readFile(join(root, 'uploads', 'manifest.json'), 'utf8'))).toMatchObject([{ path: 'public/art/logo.svg' }]);
  });

  it('stores an arbitrary external file unchanged in the selected File Manager folder', async () => {
    const root = await workspace(); const jobs = join(root, '.jobs'); await mkdir(join(root, 'docs'), { recursive: true }); await mkdir(jobs);
    const service = new UploadService({ active: () => ({ draftDir: root, mediaJobsDir: jobs }) } as any);
    const source = Buffer.from('local notes\n');
    const request = multipartRequest([{ name: 'destination', value: 'docs' }, { name: 'accept', value: 'file' }], 'Notes.TXT', 'text/plain', source);
    const records = await service.receive(request);
    expect(records[0]).toMatchObject({ path: 'docs/notes.txt', originalName: 'Notes.TXT', mimeType: 'text/plain' });
    expect(await readFile(join(root, 'docs', 'notes.txt'))).toEqual(source);
  });
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'cowork-upload-')); temporaryDirectories.push(root); return root;
}

function multipartRequest(fields: Array<{ name: string; value: string }>, filename: string, contentType: string, data: Buffer) {
  const boundary = '----cowork-upload-test'; const chunks: Buffer[] = [];
  for (const field of fields) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks); const request = Readable.from([body]) as IncomingMessage;
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  return request;
}
