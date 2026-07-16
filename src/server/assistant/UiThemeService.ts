import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { UiTheme, UiThemeProfile, UiThemeProfileResponse } from '../../shared/protocol.js';
import { BUILTIN_UI_THEMES, DEFAULT_UI_THEME_PROFILE, UI_ACCENTS, UI_SURFACES, UI_TEXTS, allUiThemes, isCompatibleText } from '../../shared/uiThemes.js';

const SCALES = new Set(['small', 'standard', 'large']);
const DENSITIES = new Set(['compact', 'comfortable', 'spacious']);
const CORNERS = new Set(['sharp', 'soft', 'rounded']);

export class UiThemeService {
  private readonly path = join(config.stateDir, 'ui-themes.json');
  private profile: UiThemeProfile = structuredClone(DEFAULT_UI_THEME_PROFILE);

  async initialize() {
    const stored = await readFile(this.path, 'utf8').then(JSON.parse).catch(() => undefined);
    this.profile = stored ? validateUiThemeProfile(stored) : structuredClone(DEFAULT_UI_THEME_PROFILE);
    if (!stored) await this.save(this.profile);
  }

  get(): UiThemeProfileResponse { return { ...structuredClone(this.profile), themes: allUiThemes(this.profile) }; }
  async update(input: unknown) { const next = validateUiThemeProfile(input); await this.save(next); this.profile = next; return this.get(); }

  private async save(profile: UiThemeProfile) {
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(profile, null, 2) + '\n', 'utf8'); await rename(temporary, this.path);
  }
}

export function validateUiThemeProfile(input: any): UiThemeProfile {
  if (!input || typeof input !== 'object') throw invalid('UI theme profile must be an object.');
  if (!Array.isArray(input.customThemes) || input.customThemes.length > 32) throw invalid('UI theme profile can contain at most 32 custom themes.');
  const customThemes = input.customThemes.map(validateTheme);
  const ids = new Set(BUILTIN_UI_THEMES.map((theme) => theme.id)); const names = new Set(BUILTIN_UI_THEMES.map((theme) => theme.name.toLowerCase()));
  for (const theme of customThemes) {
    if (ids.has(theme.id)) throw invalid(`Duplicate UI theme id: ${theme.id}`); ids.add(theme.id);
    if (names.has(theme.name.toLowerCase())) throw invalid(`Duplicate UI theme name: ${theme.name}`); names.add(theme.name.toLowerCase());
  }
  const activeThemeId = String(input.activeThemeId || ''); if (!ids.has(activeThemeId)) throw invalid('The active UI theme does not exist.');
  return { activeThemeId, customThemes };
}

function validateTheme(input: any): UiTheme {
  if (!input || typeof input !== 'object') throw invalid('Custom UI themes must be objects.');
  const id = String(input.id || '').trim(); const name = String(input.name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw invalid('Custom UI theme ids must contain 3–64 lowercase letters, numbers, or hyphens.');
  if (!name || name.length > 40) throw invalid('Custom UI theme names must contain 1–40 characters.');
  const surface = member(input.surface, UI_SURFACES, 'surface'); const text = member(input.text, UI_TEXTS, 'text color');
  const primaryAccent = member(input.primaryAccent, UI_ACCENTS, 'primary accent'); const secondaryAccent = member(input.secondaryAccent, UI_ACCENTS, 'secondary accent');
  if (!isCompatibleText(surface as UiTheme['surface'], text as UiTheme['text'])) throw invalid('The selected text color is not compatible with the theme surface.');
  if (!SCALES.has(input.scale) || !DENSITIES.has(input.density) || !CORNERS.has(input.corners)) throw invalid('Invalid UI theme sizing option.');
  const effects = input.effects;
  return { id, name, surface: surface as UiTheme['surface'], text: text as UiTheme['text'], primaryAccent: primaryAccent as UiTheme['primaryAccent'], secondaryAccent: secondaryAccent as UiTheme['secondaryAccent'], scale: input.scale, density: input.density, corners: input.corners, effects: {
    opacity: number(effects?.opacity, .82, 1, 'panel opacity'), blur: number(effects?.blur, 0, 28, 'background blur'), shadow: number(effects?.shadow, 0, 1, 'shadow'), glow: number(effects?.glow, 0, 1, 'glow'), lighting: number(effects?.lighting, 0, 1, 'lighting'),
  } };
}

function member(value: unknown, entries: readonly { id: string }[], label: string) { if (!entries.some((entry) => entry.id === value)) throw invalid(`Invalid UI theme ${label}.`); return String(value); }
function number(value: unknown, min: number, max: number, label: string) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`Invalid UI theme ${label}.`); return value; }
function invalid(message: string) { return Object.assign(new Error(message), { status: 400 }); }
