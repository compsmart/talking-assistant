import type { UiTheme, UiThemeProfile, UiThemeProfileResponse } from '../../shared/protocol';
import { accentFor, surfaceFor, textFor } from '../../shared/uiThemes';

export async function getUiThemeProfile() { return request<UiThemeProfileResponse>('/api/ui/profile'); }
export async function saveUiThemeProfile(profile: UiThemeProfile) { return request<UiThemeProfileResponse>('/api/ui/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profile) }); }

async function request<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...init }); const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `UI theme request failed (${response.status})`); return body as T;
}

const CACHE_KEY = 'cowork.ui-theme.v1';
export function bootstrapCachedUiTheme() { try { const value = JSON.parse(localStorage.getItem(CACHE_KEY) || '') as UiTheme; if (value?.id) applyUiTheme(value, false); } catch { /* Use CSS defaults. */ } }

export function applyUiTheme(theme: UiTheme, cache = false) {
  const surface = surfaceFor(theme.surface); const text = textFor(theme.text); const primary = accentFor(theme.primaryAccent); const secondary = accentFor(theme.secondaryAccent);
  const dark = surface.tone === 'dark'; const accent = dark ? primary.dark : primary.light; const accent2 = dark ? secondary.dark : secondary.light; const onAccent = dark ? primary.onDark : primary.onLight;
  const scale = { small: .9, standard: 1, large: 1.1 }[theme.scale]; const density = { compact: .86, comfortable: 1, spacious: 1.14 }[theme.density]; const radius = { sharp: 5, soft: 14, rounded: 22 }[theme.corners];
  const root = document.documentElement; root.dataset.uiTheme = theme.id; root.dataset.uiTone = surface.tone; root.style.colorScheme = surface.tone;
  const tokens: Record<string, string> = {
    '--bg': surface.shell, '--panel': rgba(surface.panel, theme.effects.opacity), '--panel-solid': surface.panel, '--line': surface.border, '--muted': text.muted, '--text': text.primary, '--accent': accent, '--accent-2': accent2, '--danger': dark ? '#ff6b7c' : '#c93f55',
    '--ui-shell': surface.shell, '--ui-panel': rgba(surface.panel, theme.effects.opacity), '--ui-panel-solid': surface.panel, '--ui-raised': surface.raised, '--ui-control': surface.control, '--ui-border': surface.border, '--ui-text': text.primary, '--ui-muted': text.muted, '--ui-accent': accent, '--ui-accent-2': accent2, '--ui-on-accent': onAccent,
    '--ui-hover': rgba(text.primary, dark ? .075 : .065), '--ui-selected': rgba(accent, dark ? .14 : .11), '--ui-overlay': rgba(surface.shell, dark ? .82 : .76), '--ui-warning': dark ? '#ffc968' : '#986000', '--ui-success': dark ? '#70e89d' : '#187b4b', '--ui-danger': dark ? '#ff6b7c' : '#c93f55',
    '--ui-font-scale': String(scale), '--ui-density': String(density), '--ui-radius': `${radius}px`, '--ui-radius-small': `${Math.max(3, radius - 6)}px`, '--ui-blur': `${theme.effects.blur}px`, '--ui-panel-opacity': String(theme.effects.opacity),
    '--ui-shadow-alpha': String((dark ? .5 : .2) * theme.effects.shadow), '--ui-glow': rgba(accent, .42 * theme.effects.glow), '--ui-light': rgba(accent, .32 * theme.effects.lighting), '--ui-edge-light': rgba(dark ? '#ffffff' : accent, .2 * theme.effects.lighting),
  };
  Object.entries(tokens).forEach(([name, value]) => root.style.setProperty(name, value)); if (cache) localStorage.setItem(CACHE_KEY, JSON.stringify(theme));
}

function rgba(hex: string, alpha: number) { const value = hex.replace('#', ''); const number = Number.parseInt(value, 16); return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`; }
