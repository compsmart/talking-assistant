import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_SETTINGS, validateWorkspaceSettings } from './WorkspaceSettingsService.js';
import { selectionBridge } from './selectionBridge.js';

describe('workspace settings', () => {
  it('accepts every supported policy value', () => {
    expect(validateWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS)).toEqual(DEFAULT_WORKSPACE_SETTINGS);
    expect(validateWorkspaceSettings({
      mode: 'canvas', vision: { frameRate: 2, quality: 'high' }, liveAgent: { directFileEdits: false },
      codingAgent: { dependencies: 'existing-only', mediaGeneration: false, validation: 'unchecked', reasoningProfile: 'fast' },
      git: { commitOnFileManagerClose: 'never' },
    })).toMatchObject({ mode: 'canvas', codingAgent: { validation: 'unchecked' } });
  });

  it('rejects incomplete and invalid settings', () => {
    expect(() => validateWorkspaceSettings({})).toThrow(/workspace mode/);
    expect(() => validateWorkspaceSettings({ ...DEFAULT_WORKSPACE_SETTINGS, mode: 'webgl' })).toThrow(/workspace mode/);
  });
});

describe('selection bridge contract', () => {
  it('supports DOM pointer overrides and semantic canvas adapters', () => {
    expect(selectionBridge).toContain('pointer-events:auto!important');
    expect(selectionBridge).toContain('window.coworkCanvas');
    expect(selectionBridge).toContain("kind: 'canvas'");
    expect(selectionBridge).toContain('cowork:canvas-status');
  });
});
