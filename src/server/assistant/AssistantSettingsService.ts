import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import { fileTypeFromFile } from 'file-type';
import { config } from '../config.js';
import { run } from '../process.js';
import { GEMINI_LIVE_VOICES, type AssistantProfile, type AssistantSettings } from '../../shared/protocol.js';

const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BACKGROUNDS = ['none', 'grid', 'digital-rain', 'starfield'] as const;

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  voice: 'Puck', personalityPrompt: '',
  appearance: {
    skinBlend: 1,
    colors: { wire: '#0dd9ff', rim: '#5999ff', background: '#01020a', backgroundAccent: '#123c54' },
    background: { mode: 'none', intensity: .65, speed: 1, particles: 0 },
    effects: { glow: 1, bloom: .85, meshPulse: 0, scanlines: .045, glitch: 0, chromaticSplit: .035, vignette: .45 },
  },
};

export class AssistantSettingsService {
  private readonly settingsPath = join(config.stateDir, 'assistant-settings.json');
  private readonly photoPath = join(config.stateDir, 'assistant', 'face.webp');
  private value: AssistantSettings = structuredClone(DEFAULT_ASSISTANT_SETTINGS);

  async initialize() {
    const stored = await readFile(this.settingsPath, 'utf8').then(JSON.parse).catch(() => undefined);
    this.value = stored ? validateAssistantSettings(mergeDefaults(stored)) : structuredClone(DEFAULT_ASSISTANT_SETTINGS);
    if (!stored) await this.saveSettings(this.value);
  }

  async getProfile(): Promise<AssistantProfile> {
    const info = await stat(this.photoPath).catch(() => undefined);
    return { settings: structuredClone(this.value), hasPhoto: !!info, ...(info ? { photoVersion: String(Math.round(info.mtimeMs)) } : {}) };
  }

  async getPhoto() { return readFile(this.photoPath); }

  async updateProfile(request: IncomingMessage) {
    const job = join(config.mediaJobsDir, `assistant-${randomUUID()}`);
    await mkdir(job, { recursive: true });
    const uploadPath = join(job, 'portrait.upload');
    const normalizedPath = join(job, 'face.webp');
    let settingsText = ''; let photoAction = 'keep'; let fileSeen = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const writes: Promise<void>[] = [];
        const parser = Busboy({ headers: request.headers, limits: { files: 1, fileSize: MAX_PHOTO_SIZE, fields: 2, parts: 3 } });
        parser.on('field', (name, value) => { if (name === 'settings') settingsText = value; if (name === 'photoAction') photoAction = value; });
        parser.on('file', (_name, stream) => {
          fileSeen = true; let truncated = false; stream.on('limit', () => { truncated = true; });
          writes.push(pipeline(stream, createWriteStream(uploadPath)).then(() => { if (truncated) throw invalid('Portrait images must be 10 MiB or smaller.', 413); }));
        });
        parser.on('filesLimit', () => reject(invalid('Only one portrait image may be uploaded.', 413)));
        parser.on('error', reject);
        parser.on('finish', () => Promise.all(writes).then(() => resolve(), reject));
        request.pipe(parser);
      });
      if (!['keep', 'replace', 'remove'].includes(photoAction)) throw invalid('Invalid portrait action.');
      if (photoAction === 'replace' && !fileSeen) throw invalid('A replacement portrait is required.');
      if (photoAction !== 'replace' && fileSeen) throw invalid('A portrait may only be sent with the replace action.');
      let parsed: unknown;
      try { parsed = JSON.parse(settingsText); } catch { throw invalid('Assistant settings must be valid JSON.'); }
      const next = validateAssistantSettings(parsed);
      if (photoAction === 'replace') {
        const detected = await fileTypeFromFile(uploadPath);
        if (!detected || !PHOTO_TYPES.has(detected.mime)) throw invalid('Portraits must be JPEG, PNG, or WebP images.', 415);
        const result = await run(config.ffmpegPath, ['-y', '-i', uploadPath, '-frames:v', '1', '-vf', "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", '-c:v', 'libwebp', '-quality', '90', normalizedPath], { timeout: 60_000 });
        if (result.code) throw invalid(`Could not normalize the portrait: ${result.stderr || result.stdout}`);
      }
      await this.saveSettings(next);
      if (photoAction === 'replace') { await mkdir(dirname(this.photoPath), { recursive: true }); await rename(normalizedPath, this.photoPath); }
      if (photoAction === 'remove') await rm(this.photoPath, { force: true });
      this.value = next;
      return this.getProfile();
    } finally { await rm(job, { recursive: true, force: true }); }
  }

  private async saveSettings(value: AssistantSettings) {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temporary, this.settingsPath);
  }
}

export function validateAssistantSettings(input: any): AssistantSettings {
  if (!input || typeof input !== 'object') throw invalid('Assistant settings must be an object.');
  const voice = String(input.voice || '');
  if (!GEMINI_LIVE_VOICES.some((item) => item.name === voice)) throw invalid('Invalid Gemini Live voice.');
  if (typeof input.personalityPrompt !== 'string' || input.personalityPrompt.trim().length > 4000) throw invalid('Personality instructions must be at most 4,000 characters.');
  const appearance = input.appearance;
  if (!appearance || typeof appearance !== 'object') throw invalid('Appearance settings are required.');
  const colors = appearance.colors;
  const color = (name: string) => { const value = colors?.[name]; if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw invalid(`Invalid ${name} color.`); return value.toLowerCase(); };
  const number = (value: unknown, min: number, max: number, label: string) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`Invalid ${label}.`); return value; };
  if (!BACKGROUNDS.includes(appearance.background?.mode)) throw invalid('Invalid digital background.');
  return {
    voice: voice as AssistantSettings['voice'], personalityPrompt: input.personalityPrompt.trim(),
    appearance: {
      skinBlend: number(appearance.skinBlend, 0, 1, 'wire-to-skin level'),
      colors: { wire: color('wire'), rim: color('rim'), background: color('background'), backgroundAccent: color('backgroundAccent') },
      background: {
        mode: appearance.background.mode,
        intensity: number(appearance.background.intensity, 0, 1, 'background intensity'),
        speed: number(appearance.background.speed, 0, 2, 'background speed'),
        particles: number(appearance.background.particles, 0, 1, 'particle intensity'),
      },
      effects: {
        glow: number(appearance.effects?.glow, 0, 2, 'glow'), bloom: number(appearance.effects?.bloom, 0, 2, 'bloom'),
        meshPulse: number(appearance.effects?.meshPulse, 0, 1, 'mesh pulse'),
        scanlines: number(appearance.effects?.scanlines, 0, .12, 'scanlines'), glitch: number(appearance.effects?.glitch, 0, 1, 'glitch'),
        chromaticSplit: number(appearance.effects?.chromaticSplit, 0, .1, 'chromatic split'), vignette: number(appearance.effects?.vignette, 0, 1, 'vignette'),
      },
    },
  };
}

function mergeDefaults(value: any): AssistantSettings {
  const defaults = DEFAULT_ASSISTANT_SETTINGS;
  return { ...defaults, ...value, appearance: { ...defaults.appearance, ...value?.appearance, colors: { ...defaults.appearance.colors, ...value?.appearance?.colors }, background: { ...defaults.appearance.background, ...value?.appearance?.background }, effects: { ...defaults.appearance.effects, ...value?.appearance?.effects } } };
}
function invalid(message: string, status = 400) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
