import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaAgent } from './MediaAgent.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('MediaAgent image generation', () => {
  it('generates transparent images on a green stage and preserves white subject pixels', async () => {
    const jobDir = await mkdtemp(join(tmpdir(), 'cowork-media-agent-')); temporary.push(jobDir);
    const width = 12; const height = 12; const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index++) rgba.set([0, 255, 0, 255], index * 4);
    for (let y = 2; y <= 9; y++) for (let x = 2; x <= 9; x++) rgba.set([255, 255, 255, 255], (y * width + x) * 4);
    rgba.set([0, 255, 0, 255], (3 * width + 3) * 4);
    rgba.set([0, 250, 0, 255], (7 * width + 7) * 4);
    const generated = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const generateContent = vi.fn().mockResolvedValue({ parts: [{ inlineData: { data: generated.toString('base64'), mimeType: 'image/png' } }] });
    const agent = new MediaAgent(); (agent as any).client = { models: { generateContent } };

    const result = await agent.generateAsset({ draftDir: jobDir } as any, { kind: 'image', prompt: 'A white chess knight', name: 'knight', transparent: true }, jobDir, () => false, vi.fn());

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(prompt).toContain('pure, perfectly flat #00FF00');
    expect(prompt).toContain('including white and near-white details');
    expect(result.artifacts.map((artifact) => artifact.label)).toEqual(['Generated green stage', 'Transparent image']);
    const { data, info } = await sharp(await readFile(result.output)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0);
    const enclosedGreen = (3 * width + 3) * 4;
    expect(data[enclosedGreen + 3]).toBe(0);
    const nearGreenSubject = (7 * width + 7) * 4;
    expect(data[nearGreenSubject + 3]).toBe(255);
    const subject = (5 * width + 5) * 4;
    expect([...data.subarray(subject, subject + 4)]).toEqual([255, 255, 255, 255]);
  });

  it('does not add the green-stage prompt for opaque images', async () => {
    const jobDir = await mkdtemp(join(tmpdir(), 'cowork-media-agent-')); temporary.push(jobDir);
    const generated = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    const generateContent = vi.fn().mockResolvedValue({ parts: [{ inlineData: { data: generated.toString('base64'), mimeType: 'image/png' } }] });
    const agent = new MediaAgent(); (agent as any).client = { models: { generateContent } };

    await agent.generateAsset({ draftDir: jobDir } as any, { kind: 'image', prompt: 'A landscape', name: 'landscape' }, jobDir, () => false, vi.fn());

    expect(generateContent.mock.calls[0][0].contents[0].parts[0].text).toBe('A landscape');
  });
});
