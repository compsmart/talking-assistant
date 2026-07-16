import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceSettings } from '../../shared/protocol.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  mode: 'mixed',
  vision: { frameRate: 1, quality: 'balanced' },
  liveAgent: { directFileEdits: true },
  codingAgent: { dependencies: 'allow', mediaGeneration: true, validation: 'standard', reasoningProfile: 'adaptive' },
  git: { commitOnFileManagerClose: 'ask' },
};

export class WorkspaceSettingsService {
  private values = new Map<string, WorkspaceSettings>();
  constructor(private readonly registry: WorkspaceRegistry) {}

  async initialize(id?: string) {
    const contexts = id ? [this.registry.get(id)] : this.registry.records().map((item) => this.registry.get(item.id));
    for (const context of contexts) {
      const stored = await readFile(context.settingsPath, 'utf8').then(JSON.parse).catch(() => undefined);
      const value = stored ? validateWorkspaceSettings(stored) : structuredClone(DEFAULT_WORKSPACE_SETTINGS);
      this.values.set(context.id, value); if (!stored) await this.save(context.id, value);
    }
  }

  get(id = this.registry.active().id) { const value = this.values.get(id); if (!value) throw new Error(`Workspace settings are not initialized: ${id}`); return structuredClone(value); }

  async update(input: unknown, id = this.registry.active().id) {
    const next = validateWorkspaceSettings(input);
    await this.save(id, next); this.values.set(id, next); await this.registry.touch(id); return this.get(id);
  }

  forget(id: string) { this.values.delete(id); }

  private async save(id: string, value: WorkspaceSettings) {
    const path = this.registry.get(id).settingsPath;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }
}

export function validateWorkspaceSettings(input: any): WorkspaceSettings {
  if (!input || typeof input !== 'object') throw invalid('Settings must be an object.');
  const mode = oneOf<WorkspaceSettings['mode']>(input.mode, ['canvas', 'dom', 'mixed'], 'workspace mode');
  const frameRate = oneOf<WorkspaceSettings['vision']['frameRate']>(input.vision?.frameRate, [0.5, 1, 2], 'vision frame rate');
  const quality = oneOf<WorkspaceSettings['vision']['quality']>(input.vision?.quality, ['low', 'balanced', 'high'], 'vision quality');
  const dependencies = oneOf<WorkspaceSettings['codingAgent']['dependencies']>(input.codingAgent?.dependencies, ['allow', 'existing-only'], 'dependency policy');
  const validation = oneOf<WorkspaceSettings['codingAgent']['validation']>(input.codingAgent?.validation, ['standard', 'fast', 'unchecked'], 'validation profile');
  const reasoningProfile = oneOf<WorkspaceSettings['codingAgent']['reasoningProfile']>(input.codingAgent?.reasoningProfile ?? 'adaptive', ['adaptive', 'balanced', 'fast'], 'reasoning profile');
  const commit = oneOf<WorkspaceSettings['git']['commitOnFileManagerClose']>(input.git?.commitOnFileManagerClose, ['ask', 'always', 'never'], 'commit behavior');
  if (typeof input.liveAgent?.directFileEdits !== 'boolean') throw invalid('Live direct-edit access must be a boolean.');
  if (typeof input.codingAgent?.mediaGeneration !== 'boolean') throw invalid('Media-generation access must be a boolean.');
  return {
    mode, vision: { frameRate, quality },
    liveAgent: { directFileEdits: input.liveAgent.directFileEdits },
    codingAgent: { dependencies, mediaGeneration: input.codingAgent.mediaGeneration, validation, reasoningProfile },
    git: { commitOnFileManagerClose: commit },
  };
}

function oneOf<T>(value: unknown, choices: readonly T[], label: string): T {
  if (!choices.includes(value as T)) throw invalid(`Invalid ${label}.`); return value as T;
}
function invalid(message: string) { const error = new Error(message) as Error & { status?: number }; error.status = 400; return error; }
