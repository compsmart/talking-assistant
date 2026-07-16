import { describe, expect, it } from 'vitest';
import { UI_SURFACES, UI_TEXTS, activeUiTheme, compatibleTexts } from './uiThemes.js';

describe('UI theme catalog', () => {
  it('only exposes text palettes with readable primary and muted contrast', () => {
    for (const surface of UI_SURFACES) for (const text of compatibleTexts(surface.id)) {
      expect(contrast(surface.panel, text.primary), `${surface.id}/${text.id} primary`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(surface.panel, text.muted), `${surface.id}/${text.id} muted`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('falls back to Dark when an active theme is unavailable', () => {
    expect(activeUiTheme({ activeThemeId: 'missing', customThemes: [] }).id).toBe('dark');
  });
});

function contrast(first: string, second: string) { const values = [luminance(first), luminance(second)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); }
function luminance(hex: string) { const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]; }
