import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { run } from '../process.js';
import type { ActivityHub } from '../activity.js';
import type { AssetRecord } from '../../shared/protocol.js';
import { mimeFor, safeWorkspacePath } from './WorkspaceFiles.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

const IMAGE_REFERENCES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GREEN_PROMPT = 'Render only the requested subject, isolated and fully visible, against a perfectly flat, evenly lit, pure #00FF00 chroma-key green background. No scenery, gradients, texture, shadows, reflections, text, or green spill. Do not use green in the subject.';
const ANIMATION_STAGE_PROMPT = 'Use a completely locked camera. Keep the subject anchored at the same centered screen position and scale for the entire clip. All action must happen in place with no sideways or forward translation through the frame.';

export class AssetService {
  private client?: GoogleGenAI;
  constructor(private readonly activity: ActivityHub, private readonly registry: WorkspaceRegistry) { if (config.geminiKey) this.client = new GoogleGenAI({ apiKey: config.geminiKey }); }

  async readiness() {
    const ffmpeg = await run(config.ffmpegPath, ['-version'], { timeout: 5_000 });
    return { configured: !!this.client, ffmpegAvailable: ffmpeg.code === 0, imageModel: config.imageModel, videoModel: config.videoModel };
  }

  async generateImage(taskId: string, args: any, cancelled: () => boolean) {
    const client = this.requireClient(); const references = await this.references(args.referenceImages, 14);
    const job = await this.jobDirectory(); const temporary = join(job, 'generated-image');
    try {
      this.ensureActive(cancelled); await this.activity.emit(taskId, 'status', 'media', `Generating image with ${config.imageModel}`);
      const parts: any[] = [{ text: `${String(args.prompt || '').trim()}${args.transparent ? `\n\n${GREEN_PROMPT}` : ''}` }];
      for (const reference of references) parts.push({ inlineData: { data: reference.data.toString('base64'), mimeType: reference.mimeType } });
      const response: any = await (client as any).models.generateContent({
        model: config.imageModel,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: args.aspectRatio || '1:1', imageSize: '1K' } },
      });
      this.ensureActive(cancelled);
      const outputPart = response.parts?.find((part: any) => part.inlineData?.data)
        || response.candidates?.flatMap((candidate: any) => candidate.content?.parts || []).find((part: any) => part.inlineData?.data);
      if (!outputPart?.inlineData?.data) throw new Error('The image model returned no image. It may have been filtered by safety policy.');
      await writeFile(temporary, Buffer.from(outputPart.inlineData.data, 'base64'));
      const destination = await this.destination('image', args.name);
      const sampled = args.transparent ? await sampleBackgroundColor(temporary) : undefined;
      const filters = sampled ? keyFilters(sampled) : [];
      const ffmpegArgs = ['-y', '-i', temporary, ...(filters.length ? ['-vf', filters.join(',')] : []), '-c:v', 'libwebp', '-quality', '86', ...(args.transparent ? ['-pix_fmt', 'yuva420p'] : []), destination.absolute];
      await this.ffmpeg(ffmpegArgs);
      const record = await this.record({ kind: 'image', path: destination.relative, prompt: args.prompt, model: config.imageModel, transparent: !!args.transparent, referenceImages: references.map((item) => item.path), mimeType: 'image/webp' });
      return { ok: true, asset: record };
    } finally { await rm(job, { recursive: true, force: true }); }
  }

  async generateAnimation(taskId: string, args: any, cancelled: () => boolean) {
    const client = this.requireClient(); const references = await this.references(args.referenceImages, 3);
    if (references.length && (args.startFrame || args.endFrame)) throw new Error('referenceImages cannot be combined with startFrame or endFrame. Use frame controls for image-to-video, or references for identity/style guidance.');
    if (args.endFrame && !args.startFrame) throw new Error('endFrame requires startFrame.');
    const startFrame = args.startFrame ? await this.reference(String(args.startFrame)) : undefined;
    const endFrame = args.endFrame ? await this.reference(String(args.endFrame)) : undefined;
    const job = await this.jobDirectory(); const videoPath = join(job, 'source.mp4'); const rawFrames = join(job, 'raw-frames'); const frames = join(job, 'frames'); await mkdir(rawFrames, { recursive: true }); await mkdir(frames, { recursive: true });
    try {
      const duration = references.length || startFrame ? 8 : 4;
      this.ensureActive(cancelled); await this.activity.emit(taskId, 'status', 'media', `Starting ${duration}-second ${config.videoModel} generation`);
      let operation: any = await (client as any).models.generateVideos({
        model: config.videoModel,
        prompt: `${String(args.prompt || '').trim()}\n\n${ANIMATION_STAGE_PROMPT}${args.transparent !== false ? `\n\n${GREEN_PROMPT}` : ''}`,
        ...(startFrame ? { image: videoImage(startFrame) } : {}),
        config: {
          numberOfVideos: 1, durationSeconds: duration, resolution: '720p', aspectRatio: args.aspectRatio || '16:9',
          ...(endFrame ? { lastFrame: videoImage(endFrame) } : {}),
          ...(references.length ? { referenceImages: references.map((item) => ({ image: { imageBytes: item.data.toString('base64'), mimeType: item.mimeType }, referenceType: 'asset' })) } : {}),
        },
      });
      const started = Date.now();
      while (!operation.done) {
        this.ensureActive(cancelled); if (Date.now() - started > config.mediaTimeoutMs) throw new Error('Video generation timed out.');
        await this.activity.emit(taskId, 'status', 'media', 'Veo is rendering the animation');
        await delay(10_000); operation = await (client as any).operations.getVideosOperation({ operation });
      }
      if (operation.error) throw new Error(`Veo generation failed: ${JSON.stringify(operation.error)}`);
      const video = operation.response?.generatedVideos?.[0]?.video; if (!video) throw new Error('Veo returned no video. It may have been filtered by safety policy.');
      if (video.videoBytes) await writeFile(videoPath, Buffer.from(video.videoBytes, 'base64'));
      else await (client as any).files.download({ file: video, downloadPath: videoPath });
      this.ensureActive(cancelled); await this.activity.emit(taskId, 'status', 'media', 'Extracting, thinning, and chroma-keying animation frames');
      const transparent = args.transparent !== false;
      const thinning = duration === 8 && endFrame
        ? ['setpts=0.5*PTS', 'fps=12']
        : ['select=not(mod(n\\,2))', 'setpts=N/(12*TB)'];
      await this.ffmpeg(['-y', '-i', videoPath, '-t', '4', '-vf', thinning.join(','), join(rawFrames, 'frame-%04d.png')]);
      if (transparent) {
        const sampled = await sampleBackgroundColor(join(rawFrames, 'frame-0001.png'));
        await this.activity.emit(taskId, 'status', 'media', `Removing sampled stage color #${sampled.hex}`);
        await this.ffmpeg(['-y', '-framerate', '12', '-i', join(rawFrames, 'frame-%04d.png'), '-vf', keyFilters(sampled).join(','), join(frames, 'frame-%04d.png')]);
      } else {
        await this.ffmpeg(['-y', '-framerate', '12', '-i', join(rawFrames, 'frame-%04d.png'), join(frames, 'frame-%04d.png')]);
      }
      const destination = await this.destination('animation', args.name);
      await this.ffmpeg(['-y', '-framerate', '12', '-i', join(frames, 'frame-%04d.png'), '-c:v', 'libwebp_anim', '-quality', '82', '-loop', '0', '-pix_fmt', transparent ? 'yuva420p' : 'yuv420p', destination.absolute]);
      const record = await this.record({ kind: 'animation', path: destination.relative, prompt: args.prompt, model: config.videoModel, transparent, referenceImages: references.map((item) => item.path), startFrame: startFrame?.path, endFrame: endFrame?.path, durationSeconds: 4, fps: 12, mimeType: 'image/webp' });
      return { ok: true, asset: record };
    } finally { await rm(job, { recursive: true, force: true }); }
  }

  async registerUpload(path: string, originalName: string, mimeType: string) {
    return this.record({ kind: 'upload', path, originalName, mimeType });
  }

  private requireClient() { if (!this.client) throw new Error('GEMINI_API_KEY is required for media generation.'); return this.client; }
  private ensureActive(cancelled: () => boolean) { if (cancelled()) throw new Error('Task cancelled'); }
  private async references(paths: unknown, maximum: number) {
    const values = Array.isArray(paths) ? paths.map(String) : []; if (values.length > maximum) throw new Error(`This tool accepts at most ${maximum} reference images.`);
    return Promise.all(values.map((path) => this.reference(path)));
  }
  private async reference(path: string) { const root = this.registry.active().draftDir; const absolute = await safeWorkspacePath(root, path, true); const mimeType = mimeFor(path); if (!IMAGE_REFERENCES.has(mimeType)) throw new Error(`Unsupported reference image type: ${path}`); return { path, mimeType, data: await readFile(absolute) }; }
  private async jobDirectory() { const path = join(this.registry.active().mediaJobsDir, randomUUID()); await mkdir(path, { recursive: true }); return path; }
  private async destination(kind: 'image' | 'animation', requested: unknown) {
    const root = this.registry.active().draftDir; const stem = slug(String(requested || kind)); const directory = join(root, 'assets', 'generated', kind === 'image' ? 'images' : 'animations'); await mkdir(directory, { recursive: true });
    let name = `${stem}.webp`; let index = 2; while (await exists(join(directory, name))) name = `${stem}-${index++}.webp`;
    const absolute = join(directory, name); return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') };
  }
  private async record(input: Omit<AssetRecord, 'id' | 'size' | 'createdAt'>) {
    const root = this.registry.active().draftDir; const absolute = await safeWorkspacePath(root, input.path, true); const record: AssetRecord = { id: randomUUID(), ...input, size: (await stat(absolute)).size, createdAt: new Date().toISOString() };
    const manifestPath = join(root, 'assets', 'generated', 'manifest.json'); await mkdir(dirname(manifestPath), { recursive: true });
    const records: AssetRecord[] = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => []); records.push(record);
    const temporary = `${manifestPath}.tmp`; await writeFile(temporary, JSON.stringify(records, null, 2) + '\n', 'utf8'); await rename(temporary, manifestPath); return record;
  }
  private async ffmpeg(args: string[]) { const result = await run(config.ffmpegPath, args, { timeout: config.mediaTimeoutMs }); if (result.code) throw new Error(`FFmpeg failed: ${result.stderr || result.stdout}`); }
}

function slug(value: string) { return basename(value, extname(value)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'asset'; }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function exists(path: string) { return stat(path).then(() => true).catch(() => false); }
function videoImage(image: { data: Buffer; mimeType: string }) { return { imageBytes: image.data.toString('base64'), mimeType: image.mimeType }; }

interface SampledColor { hex: string; red: number; green: number; blue: number }
function sampleBackgroundColor(path: string): Promise<SampledColor> {
  return new Promise((resolve, reject) => execFile(config.ffmpegPath, ['-v', 'error', '-i', path, '-vf', 'crop=32:32:0:0,scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error || !Buffer.isBuffer(stdout) || stdout.length < 3) { reject(new Error(`Could not sample the generated background: ${String(stderr || error?.message || '')}`)); return; }
    const [red, green, blue] = stdout; resolve({ red, green, blue, hex: [red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('') });
  }));
}
function keyFilters(color: SampledColor) {
  const greenStage = color.green > color.red * 1.25 && color.green > color.blue * 1.25;
  return [`colorkey=0x${color.hex}:0.18:0.08`, ...(greenStage ? ['despill=type=green:mix=0.5'] : []), 'format=rgba'];
}
