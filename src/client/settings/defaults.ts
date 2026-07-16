import type { WorkspaceSettings } from '../../shared/protocol';

export const DEFAULT_CLIENT_SETTINGS: WorkspaceSettings = {
  mode: 'mixed', vision: { frameRate: 1, quality: 'balanced' },
  liveAgent: { directFileEdits: true },
  codingAgent: { dependencies: 'allow', mediaGeneration: true, validation: 'standard', reasoningProfile: 'adaptive' },
  git: { commitOnFileManagerClose: 'ask' },
};
