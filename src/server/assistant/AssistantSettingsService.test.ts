import { describe, expect, it } from 'vitest';
import { GEMINI_LIVE_VOICES } from '../../shared/protocol.js';
import { DEFAULT_ASSISTANT_SETTINGS, validateAssistantSettings } from './AssistantSettingsService.js';

describe('assistant settings', () => {
  it('accepts defaults and every documented Gemini Live voice', () => {
    expect(validateAssistantSettings(DEFAULT_ASSISTANT_SETTINGS)).toEqual(DEFAULT_ASSISTANT_SETTINGS);
    for (const voice of GEMINI_LIVE_VOICES) expect(validateAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, voice: voice.name }).voice).toBe(voice.name);
  });

  it('trims personality instructions and preserves valid appearance controls', () => {
    const settings = structuredClone(DEFAULT_ASSISTANT_SETTINGS);
    settings.personalityPrompt = '  Talk like an angry pirate.  ';
    settings.appearance.background.mode = 'digital-rain'; settings.appearance.effects.glitch = .7;
    expect(validateAssistantSettings(settings)).toMatchObject({ personalityPrompt: 'Talk like an angry pirate.', appearance: { background: { mode: 'digital-rain' }, effects: { glitch: .7 } } });
  });

  it('rejects unknown voices, malformed colors, and out-of-range controls', () => {
    expect(() => validateAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, voice: 'Unknown' })).toThrow(/voice/i);
    expect(() => validateAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, appearance: { ...DEFAULT_ASSISTANT_SETTINGS.appearance, colors: { ...DEFAULT_ASSISTANT_SETTINGS.appearance.colors, wire: 'cyan' } } })).toThrow(/wire color/i);
    expect(() => validateAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, appearance: { ...DEFAULT_ASSISTANT_SETTINGS.appearance, skinBlend: 2 } })).toThrow(/wire-to-skin/i);
    expect(() => validateAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, personalityPrompt: 'x'.repeat(4001) })).toThrow(/4,000/);
  });
});
