import type { UiAccentId, UiSurfaceId, UiTextId, UiTheme, UiThemeProfile } from './protocol.js';

export interface UiSurfacePalette {
  id: UiSurfaceId; name: string; tone: 'light' | 'dark';
  shell: string; panel: string; raised: string; control: string; border: string;
}
export interface UiTextPalette { id: UiTextId; name: string; tone: 'light' | 'dark'; primary: string; muted: string }
export interface UiAccentPalette { id: UiAccentId; name: string; light: string; dark: string; onLight: string; onDark: string }

export const UI_SURFACES: readonly UiSurfacePalette[] = [
  { id: 'cloud', name: 'Cloud', tone: 'light', shell: '#e9eef4', panel: '#f8fafc', raised: '#ffffff', control: '#eef2f7', border: '#c5ced8' },
  { id: 'paper', name: 'Paper', tone: 'light', shell: '#f2ede5', panel: '#fffdf8', raised: '#ffffff', control: '#f4efe7', border: '#d4c9bb' },
  { id: 'mist', name: 'Mist', tone: 'light', shell: '#dde6ed', panel: '#edf3f7', raised: '#f8fbfd', control: '#e4ecf2', border: '#b9c8d2' },
  { id: 'ice', name: 'Ice', tone: 'light', shell: '#ddecea', panel: '#eff8f6', raised: '#f9fcfb', control: '#e3f1ee', border: '#b4cec9' },
  { id: 'graphite', name: 'Graphite', tone: 'dark', shell: '#07090d', panel: '#11161e', raised: '#18202b', control: '#121923', border: '#303b49' },
  { id: 'midnight', name: 'Midnight', tone: 'dark', shell: '#050914', panel: '#0a1020', raised: '#10192d', control: '#0d1627', border: '#293752' },
  { id: 'slate', name: 'Slate', tone: 'dark', shell: '#101820', panel: '#18232d', raised: '#202e39', control: '#1a2833', border: '#394b59' },
  { id: 'aubergine', name: 'Aubergine', tone: 'dark', shell: '#130d18', panel: '#201526', raised: '#2a1d31', control: '#24192b', border: '#49334f' },
] as const;

export const UI_TEXTS: readonly UiTextPalette[] = [
  { id: 'ink', name: 'Ink', tone: 'light', primary: '#17212b', muted: '#5e6a78' },
  { id: 'navy', name: 'Navy', tone: 'light', primary: '#13243a', muted: '#566a82' },
  { id: 'warm-charcoal', name: 'Warm charcoal', tone: 'light', primary: '#29231f', muted: '#70645b' },
  { id: 'cool-light', name: 'Cool light', tone: 'dark', primary: '#e6edf5', muted: '#8b98a8' },
  { id: 'warm-light', name: 'Warm light', tone: 'dark', primary: '#f4eee7', muted: '#a2968b' },
  { id: 'blue-light', name: 'Blue light', tone: 'dark', primary: '#e3f0ff', muted: '#91a5bb' },
] as const;

export const UI_ACCENTS: readonly UiAccentPalette[] = [
  { id: 'mint', name: 'Mint', light: '#087f68', dark: '#7cf3ce', onLight: '#ffffff', onDark: '#05130f' },
  { id: 'blue', name: 'Blue', light: '#2f68c5', dark: '#6ea8ff', onLight: '#ffffff', onDark: '#07101d' },
  { id: 'violet', name: 'Violet', light: '#7048bd', dark: '#b49aff', onLight: '#ffffff', onDark: '#120b22' },
  { id: 'amber', name: 'Amber', light: '#a45b00', dark: '#ffc968', onLight: '#ffffff', onDark: '#241500' },
  { id: 'rose', name: 'Rose', light: '#b63c59', dark: '#ff8fa5', onLight: '#ffffff', onDark: '#260811' },
  { id: 'cyan', name: 'Cyan', light: '#087994', dark: '#63dcf4', onLight: '#ffffff', onDark: '#04171d' },
] as const;

export const BUILTIN_UI_THEMES: readonly UiTheme[] = [
  { id: 'dark', name: 'Dark', surface: 'graphite', text: 'cool-light', primaryAccent: 'mint', secondaryAccent: 'blue', scale: 'standard', density: 'comfortable', corners: 'soft', effects: { opacity: .9, blur: 20, shadow: .75, glow: .45, lighting: .25 } },
  { id: 'light', name: 'Light', surface: 'cloud', text: 'ink', primaryAccent: 'mint', secondaryAccent: 'blue', scale: 'standard', density: 'comfortable', corners: 'soft', effects: { opacity: .96, blur: 18, shadow: .42, glow: .18, lighting: .16 } },
] as const;

export const DEFAULT_UI_THEME_PROFILE: UiThemeProfile = { activeThemeId: 'dark', customThemes: [] };
export const surfaceFor = (id: UiSurfaceId) => UI_SURFACES.find((item) => item.id === id)!;
export const textFor = (id: UiTextId) => UI_TEXTS.find((item) => item.id === id)!;
export const accentFor = (id: UiAccentId) => UI_ACCENTS.find((item) => item.id === id)!;
export const compatibleTexts = (surface: UiSurfaceId) => UI_TEXTS.filter((text) => text.tone === surfaceFor(surface).tone);
export const isCompatibleText = (surface: UiSurfaceId, text: UiTextId) => surfaceFor(surface).tone === textFor(text).tone;

export function allUiThemes(profile: UiThemeProfile) { return [...BUILTIN_UI_THEMES.map(cloneTheme), ...profile.customThemes.map(cloneTheme)]; }
export function activeUiTheme(profile: UiThemeProfile) { return allUiThemes(profile).find((theme) => theme.id === profile.activeThemeId) || cloneTheme(BUILTIN_UI_THEMES[0]); }
export function cloneTheme(theme: UiTheme): UiTheme { return structuredClone(theme); }
