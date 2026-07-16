import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { config } from '../config.js';
import { run } from '../process.js';
import { safeWorkspacePath, mimeFor } from '../workspace/WorkspaceFiles.js';
import type { WorkspaceContext } from '../workspace/WorkspaceRegistry.js';
import type { AnimationMediaJobRequest, AnimationEncodingSettings, AnimationMatteSettings, ImageMediaJobRequest, MediaJobRequest, MediaStageName, VideoMediaJobRequest } from '../../shared/protocol.js';
import { encodeAnimation, extractFourSecondFrames, mapVideoFrameToReference, normalizeEndpoint, removeEdgeConnectedBackground } from './AnimationPipeline.js';

export const MEDIA_AGENT_SYSTEM = `You are the dedicated Media Agent. Reason about composition, identity, motion, alpha, timing, and audio before generating. Use explicit first and last frames for endpoint-controlled animation. Inspect generated outputs and prefer deterministic reprocessing over additional paid generation when geometry, alpha, timing, or encoding can be corrected locally.`;

const TRANSPARENT_IMAGE_STAGE_PROMPT = `Render the requested subject isolated on a pure, perfectly flat #00FF00 chroma-key green background. The green must extend to every image edge and corner. Do not add scenery, a floor, a horizon, shadows, reflections, gradients, texture, glow, or green spill. Keep all requested subject colors unchanged, including white and near-white details.`;
const TRANSPARENT_IMAGE_MATTE: AnimationMatteSettings = { backgroundColor: '#00ff00', tolerance: 3, feather: 1, despill: 1, edgeConnected: false };

export interface MediaAgentProgress { stage: MediaStageName; progress: number; message: string }
export interface AnimationAgentResult { output: string; audio?: string; artifacts: Array<{ stage: MediaStageName; path: string; label: string; mimeType: string; type: 'image' | 'video' | 'audio' | 'contact-sheet' | 'mask' | 'animation' }> }

export class MediaAgent {
  private client?: GoogleGenAI;
  constructor() { if (config.geminiKey) this.client = new GoogleGenAI({ apiKey: config.geminiKey }); }

  async generateAsset(context: WorkspaceContext, request: Exclude<MediaJobRequest, AnimationMediaJobRequest>, jobDir: string, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    if (request.kind === 'image') return this.generateImage(context, request, jobDir, cancelled, progress);
    if (request.kind === 'video') return this.generateVideo(context, request, jobDir, cancelled, progress);
    if (request.kind === 'sound-effect') return this.generateSoundEffect(request, jobDir, cancelled, progress);
    return this.generateMusic(request, jobDir, cancelled, progress);
  }

  private async generateImage(context: WorkspaceContext, request: ImageMediaJobRequest, jobDir: string, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const client = this.requireClient(); await progress({ stage: 'generate', progress: 20, message: `Generating image with ${config.imageModel}` }); const parts: any[] = [{ text: `${request.prompt.trim()}${request.transparent ? `\n\n${TRANSPARENT_IMAGE_STAGE_PROMPT}` : ''}` }];
    for (const path of request.referenceImages || []) { const absolute = await safeWorkspacePath(context.draftDir, path, true); parts.push({ inlineData: { data: (await readFile(absolute)).toString('base64'), mimeType: mimeFor(path) } }); }
    const response: any = await (client as any).models.generateContent({ model: config.imageModel, contents: [{ role: 'user', parts }], config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: request.aspectRatio || '1:1', imageSize: '1K' } } }); this.check(cancelled);
    const part = response.parts?.find((item: any) => item.inlineData?.data) || response.candidates?.flatMap((item: any) => item.content?.parts || []).find((item: any) => item.inlineData?.data); if (!part) throw new Error('The image model returned no image.');
    const sourceDir = join(jobDir, 'source'); const outputDir = join(jobDir, 'outputs', 'v1'); await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
    const generated = Buffer.from(part.inlineData.data, 'base64'); const output = join(outputDir, 'image.webp');
    if (request.transparent) {
      const greenStage = join(sourceDir, 'image-green-stage.png'); await sharp(generated).png().toFile(greenStage); this.check(cancelled);
      await progress({ stage: 'matte', progress: 78, message: 'Removing all pixels matching the green stage while preserving other subject colors' });
      const transparent = join(outputDir, 'image-transparent.png'); await removeEdgeConnectedBackground(greenStage, transparent, TRANSPARENT_IMAGE_MATTE); this.check(cancelled);
      await sharp(transparent).webp({ lossless: true }).toFile(output);
      await progress({ stage: 'encode', progress: 95, message: 'Transparent image is ready to publish' });
      return { output, artifacts: [
        { stage: 'generate', path: greenStage, label: 'Generated green stage', mimeType: 'image/png', type: 'image' },
        { stage: 'encode', path: output, label: 'Transparent image', mimeType: 'image/webp', type: 'image' },
      ] };
    }
    await sharp(generated).webp({ quality: 90 }).toFile(output); await progress({ stage: 'encode', progress: 95, message: 'Image is ready to publish' });
    return { output, artifacts: [{ stage: 'encode', path: output, label: 'Generated image', mimeType: 'image/webp', type: 'image' }] };
  }

  private async generateVideo(context: WorkspaceContext, request: VideoMediaJobRequest, jobDir: string, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const client = this.requireClient(); const aspect = request.aspectRatio || '16:9'; const configInput: any = { numberOfVideos: 1, durationSeconds: 8, resolution: '720p', aspectRatio: aspect, ...(request.soundEffects ? { generateAudio: true } : {}) }; let image: any;
    if (request.startFrame) { const start = await safeWorkspacePath(context.draftDir, request.startFrame, true); image = { imageBytes: (await readFile(start)).toString('base64'), mimeType: mimeFor(request.startFrame) }; }
    if (request.endFrame) { const end = await safeWorkspacePath(context.draftDir, request.endFrame, true); configInput.lastFrame = { imageBytes: (await readFile(end)).toString('base64'), mimeType: mimeFor(request.endFrame) }; }
    await progress({ stage: 'generate', progress: 20, message: `Generating video with ${config.videoModel}` }); let operation: any = await (client as any).models.generateVideos({ model: config.videoModel, prompt: `${request.prompt}${request.soundEffects ? `\nSound effects: ${request.soundEffects}` : ''}`, ...(image ? { image } : {}), config: configInput }); const started = Date.now();
    while (!operation.done) { this.check(cancelled); if (Date.now() - started > config.mediaTimeoutMs) throw new Error('Video generation timed out.'); await delay(10_000); operation = await (client as any).operations.getVideosOperation({ operation }); }
    const video = operation.response?.generatedVideos?.[0]?.video; if (!video) throw new Error('Veo returned no video.'); const outputDir = join(jobDir, 'outputs', 'v1'); await mkdir(outputDir, { recursive: true }); const output = join(outputDir, 'video.mp4'); if (video.videoBytes) await writeFile(output, Buffer.from(video.videoBytes, 'base64')); else await (client as any).files.download({ file: video, downloadPath: output }); await progress({ stage: 'encode', progress: 95, message: 'Video is ready to publish' });
    return { output, artifacts: [{ stage: 'encode', path: output, label: 'Generated video', mimeType: 'video/mp4', type: 'video' }] };
  }

  private async generateSoundEffect(request: any, jobDir: string, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const video = await this.generateVideo({ draftDir: '' } as WorkspaceContext, { ...request, kind: 'video', soundEffects: request.prompt } as VideoMediaJobRequest, jobDir, cancelled, progress); const output = join(jobDir, 'outputs', 'v1', 'audio.mp3'); const converted = await run(config.ffmpegPath, ['-y', '-i', video.output, '-vn', '-t', String(request.durationSeconds || 8), '-c:a', 'libmp3lame', '-q:a', '2', output], { timeout: 120_000 }); if (converted.code) throw new Error('Veo returned no usable sound-effect audio.'); return { output, artifacts: [...video.artifacts, { stage: 'encode', path: output, label: 'Generated sound effect', mimeType: 'audio/mpeg', type: 'audio' }] };
  }

  private async generateMusic(request: any, jobDir: string, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const client = this.requireClient(); await progress({ stage: 'generate', progress: 20, message: `Generating music with ${config.musicModel}` }); const response: any = await (client as any).models.generateContent({ model: config.musicModel, contents: request.prompt, config: { responseModalities: ['AUDIO'] } }); this.check(cancelled); const part = response.parts?.find((item: any) => item.inlineData?.data) || response.candidates?.flatMap((item: any) => item.content?.parts || []).find((item: any) => item.inlineData?.data); if (!part) throw new Error('Lyria returned no audio.'); const outputDir = join(jobDir, 'outputs', 'v1'); await mkdir(outputDir, { recursive: true }); const source = join(outputDir, 'music-source'); await writeFile(source, Buffer.from(part.inlineData.data, 'base64')); const output = join(outputDir, 'music.mp3'); const converted = await run(config.ffmpegPath, ['-y', '-i', source, '-t', String(request.durationSeconds || 30), '-c:a', 'libmp3lame', '-q:a', '2', output], { timeout: 120_000 }); if (converted.code) throw new Error('Could not encode the generated music.'); return { output, artifacts: [{ stage: 'encode', path: output, label: 'Generated music', mimeType: 'audio/mpeg', type: 'audio' }] };
  }

  async generateAnimation(context: WorkspaceContext, request: AnimationMediaJobRequest, jobDir: string, matte: AnimationMatteSettings, encoding: AnimationEncodingSettings, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const client = this.requireClient(); if (!request.startFrame) throw new Error('Endpoint-controlled animation requires startFrame.');
    const startSource = await safeWorkspacePath(context.draftDir, request.startFrame, true);
    const endSource = await safeWorkspacePath(context.draftDir, request.endFrame || request.startFrame, true);
    const aspect = request.aspectRatio || '16:9'; const [videoWidth, videoHeight] = aspect === '9:16' ? [720, 1280] : [1280, 720];
    const inputs = join(jobDir, 'inputs'); const normalized = join(jobDir, 'normalized'); const sourceDir = join(jobDir, 'source'); const rawDir = join(jobDir, 'attempts', 'raw-v1'); const mappedDir = join(jobDir, 'attempts', 'mapped-v1'); const keyedDir = join(jobDir, 'attempts', 'keyed-v1'); const outputDir = join(jobDir, 'outputs', 'v1');
    await Promise.all([inputs, normalized, sourceDir, rawDir, mappedDir, keyedDir, outputDir].map((path) => mkdir(path, { recursive: true })));
    await copyFile(startSource, join(inputs, `start${extensionFor(request.startFrame)}`)); await copyFile(endSource, join(inputs, `end${extensionFor(request.endFrame || request.startFrame)}`));
    this.check(cancelled); await progress({ stage: 'normalize', progress: 10, message: 'Normalizing explicit animation endpoints' });
    const endpoint = join(normalized, 'endpoint.png'); const startGreen = join(normalized, 'start-green.png');
    const geometry = await normalizeEndpoint(startSource, join(normalized, 'start-transparent.png'), startGreen, videoWidth, videoHeight);
    await sharp(startSource).autoOrient().ensureAlpha().png().toFile(endpoint);
    const endGreen = join(normalized, 'end-green.png');
    if (startSource === endSource) { await copyFile(startGreen, endGreen); await copyFile(join(normalized, 'start-transparent.png'), join(normalized, 'end-transparent.png')); }
    else await normalizeEndpoint(endSource, join(normalized, 'end-transparent.png'), endGreen, videoWidth, videoHeight);
    this.check(cancelled); await progress({ stage: 'generate', progress: 20, message: `Generating endpoint-controlled animation with ${config.videoModel}` });
    const sourceVideo = join(sourceDir, 'video.mp4'); const first = await imagePart(startGreen); const last = await imagePart(endGreen);
    let operation: any = await (client as any).models.generateVideos({
      model: config.videoModel,
      prompt: `${request.prompt.trim()}\n\nLocked camera. Keep the subject centered, anchored, and at exactly the same scale. Pure flat #00FF00 background. No shadows or scenery.${request.soundEffects ? `\n\nSound effects: ${request.soundEffects}` : ''}`,
      image: first,
      config: { numberOfVideos: 1, durationSeconds: 8, resolution: '720p', aspectRatio: aspect, lastFrame: last, ...(request.soundEffects ? { generateAudio: true } : {}) },
    });
    const started = Date.now();
    while (!operation.done) { this.check(cancelled); if (Date.now() - started > config.mediaTimeoutMs) throw new Error('Veo generation timed out.'); await delay(10_000); operation = await (client as any).operations.getVideosOperation({ operation }); await progress({ stage: 'generate', progress: Math.min(58, 25 + Math.floor((Date.now() - started) / 20_000)), message: 'Veo is rendering video and audio' }); }
    if (operation.error) throw new Error(`Veo generation failed: ${JSON.stringify(operation.error)}`);
    const video = operation.response?.generatedVideos?.[0]?.video; if (!video) throw new Error('Veo returned no video.');
    if (video.videoBytes) await writeFile(sourceVideo, Buffer.from(video.videoBytes, 'base64')); else await (client as any).files.download({ file: video, downloadPath: sourceVideo });
    let audio: string | undefined; if (request.soundEffects) { audio = join(outputDir, 'audio.mp3'); const result = await run(config.ffmpegPath, ['-y', '-i', sourceVideo, '-vn', '-filter:a', 'atempo=2.0', '-t', '4', '-c:a', 'libmp3lame', '-q:a', '2', audio], { timeout: 120_000 }); if (result.code) audio = undefined; }
    this.check(cancelled); await progress({ stage: 'extract', progress: 62, message: 'Compressing the source to exactly 48 frames at 12 FPS' });
    const rawFrames = await extractFourSecondFrames(sourceVideo, rawDir);
    for (let index = 0; index < rawFrames.length; index++) { const destination = join(mappedDir, `frame-${String(index + 1).padStart(4, '0')}.png`); await mapVideoFrameToReference(rawFrames[index], destination, geometry); }
    this.check(cancelled); await progress({ stage: 'matte', progress: 72, message: 'Removing only edge-connected stage pixels' });
    for (let index = 0; index < 48; index++) {
      const destination = join(keyedDir, `frame-${String(index + 1).padStart(4, '0')}.png`);
      if (index === 0 || index === 47) await copyFile(endpoint, destination);
      else await removeEdgeConnectedBackground(join(mappedDir, `frame-${String(index + 1).padStart(4, '0')}.png`), destination, matte);
    }
    const contactSheet = join(outputDir, 'contact-sheet.jpg');
    await makeContactSheet(keyedDir, contactSheet);
    this.check(cancelled); await progress({ stage: 'encode', progress: 88, message: 'Encoding and validating lossless animated WebP' });
    const output = join(outputDir, 'animation.webp'); await encodeAnimation(keyedDir, output, encoding);
    await progress({ stage: 'publish', progress: 96, message: 'Animation is ready to publish' });
    return { output, audio, artifacts: [
      { stage: 'normalize', path: join(normalized, 'start-transparent.png'), label: 'Normalized start', mimeType: 'image/png', type: 'image' },
      { stage: 'normalize', path: startGreen, label: 'Green stage', mimeType: 'image/png', type: 'image' },
      { stage: 'generate', path: sourceVideo, label: 'Generated video', mimeType: 'video/mp4', type: 'video' },
      { stage: 'extract', path: contactSheet, label: 'Frame contact sheet', mimeType: 'image/jpeg', type: 'contact-sheet' },
      { stage: 'encode', path: output, label: 'Final animation', mimeType: 'image/webp', type: 'animation' },
      ...(audio ? [{ stage: 'encode' as const, path: audio, label: 'Synchronized audio', mimeType: 'audio/mpeg', type: 'audio' as const }] : []),
    ] };
  }

  async reprocessAnimation(jobDir: string, revision: number, matte: AnimationMatteSettings, encoding: AnimationEncodingSettings, cancelled: () => boolean, progress: (event: MediaAgentProgress) => Promise<void>): Promise<AnimationAgentResult> {
    const mappedDir = join(jobDir, 'attempts', 'mapped-v1'); const endpoint = join(jobDir, 'normalized', 'endpoint.png'); const keyedDir = join(jobDir, 'attempts', `keyed-v${revision}`); const outputDir = join(jobDir, 'outputs', `v${revision}`); await Promise.all([mkdir(keyedDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
    await progress({ stage: 'matte', progress: 35, message: 'Reprocessing the retained frames with updated matte settings' });
    for (let index = 0; index < 48; index++) { this.check(cancelled); const destination = join(keyedDir, `frame-${String(index + 1).padStart(4, '0')}.png`); if (index === 0 || index === 47) await copyFile(endpoint, destination); else await removeEdgeConnectedBackground(join(mappedDir, `frame-${String(index + 1).padStart(4, '0')}.png`), destination, matte); }
    const contactSheet = join(outputDir, 'contact-sheet.jpg'); await makeContactSheet(keyedDir, contactSheet); await progress({ stage: 'encode', progress: 80, message: 'Encoding the deterministic media revision' });
    const output = join(outputDir, 'animation.webp'); await encodeAnimation(keyedDir, output, encoding); const previousAudio = join(jobDir, 'outputs', 'v1', 'audio.mp3'); const audio = await readFile(previousAudio).then(() => previousAudio).catch(() => undefined);
    return { output, audio, artifacts: [{ stage: 'matte', path: contactSheet, label: `Matte revision ${revision}`, mimeType: 'image/jpeg', type: 'contact-sheet' }, { stage: 'encode', path: output, label: `Animation revision ${revision}`, mimeType: 'image/webp', type: 'animation' }, ...(audio ? [{ stage: 'encode' as const, path: audio, label: 'Synchronized audio', mimeType: 'audio/mpeg', type: 'audio' as const }] : [])] };
  }

  private requireClient() { if (!this.client) throw new Error('GEMINI_API_KEY is required for media generation.'); return this.client; }
  private check(cancelled: () => boolean) { if (cancelled()) throw new Error('Media job cancelled'); }
}

async function imagePart(path: string) { return { imageBytes: (await readFile(path)).toString('base64'), mimeType: 'image/png' }; }
function extensionFor(path: string) { const match = path.match(/\.[a-z0-9]+$/i); return match?.[0] || `.${mimeFor(path).split('/')[1] || 'bin'}`; }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function makeContactSheet(frames: string, output: string) {
  const tile = 240; const composites = [];
  for (let index = 0; index < 12; index++) { const frame = join(frames, `frame-${String(index * 4 + 1).padStart(4, '0')}.png`); const input = await sharp(frame).resize(tile, tile, { fit: 'contain' }).flatten({ background: '#e4e7eb' }).jpeg({ quality: 88 }).toBuffer(); composites.push({ input, left: (index % 4) * tile, top: Math.floor(index / 4) * tile }); }
  await sharp({ create: { width: tile * 4, height: tile * 3, channels: 3, background: '#e4e7eb' } }).composite(composites).jpeg({ quality: 88 }).toFile(output);
}
