import type { AssistantSettings } from '../../shared/protocol';

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  voice: 'Puck',
  personalityPrompt: '',
  appearance: {
    skinBlend: 1,
    colors: { wire: '#0dd9ff', rim: '#5999ff', background: '#01020a', backgroundAccent: '#123c54' },
    background: { mode: 'none', intensity: .65, speed: 1, particles: 0 },
    effects: { glow: 1, bloom: .85, meshPulse: 0, scanlines: .045, glitch: 0, chromaticSplit: .035, vignette: .45 },
  },
};
