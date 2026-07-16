import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfigService } from './AgentConfigService.js';
import { SecretVault, type SecretStore } from './SecretVault.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function service(vault?: SecretVault) {
  const root = await mkdtemp(join(tmpdir(), 'agent-config-')); roots.push(root);
  const value = new AgentConfigService(root, vault); await value.initialize(); return { root, value };
}

describe('agent configuration', () => {
  it('seeds protected built-in profiles and persists custom profiles atomically', async () => {
    const { root, value } = await service(); const initial = value.get();
    expect(initial.profiles.map((item) => item.id)).toContain('builtin-coder');
    const updated = await value.saveProfile({
      name: 'Accessibility specialist', description: 'Reviews accessible UI', enabled: true, stages: ['reviewer'],
      capabilities: ['accessibility'], model: 'gemini-test', instructions: 'Audit WCAG concerns.', toolIds: ['read_files'],
      skillIds: [], contextIds: [], secretGrantIds: [], priority: 10, maxConcurrency: 1, routingRules: [],
    }, initial.revision);
    expect(updated.revision).toBe(initial.revision + 1);
    expect(updated.profiles.at(-1)).toMatchObject({ kind: 'custom', name: 'Accessibility specialist', revision: 1 });
    const stored = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    expect(stored.profiles.at(-1).name).toBe('Accessibility specialist');
  });

  it('rejects stale writes and deleting built-ins', async () => {
    const { value } = await service(); const initial = value.get();
    await value.saveSkill({ name: 'Docs', description: '', instructions: 'Check docs.', capabilities: [], requiredToolIds: [], requiredSecretKinds: [], contextIds: [], enabled: true }, initial.revision);
    await expect(value.saveSkill({ name: 'Stale', description: '', instructions: '', capabilities: [], requiredToolIds: [], requiredSecretKinds: [], contextIds: [], enabled: true }, initial.revision)).rejects.toMatchObject({ status: 409 });
    await expect(value.deleteProfile('builtin-coder', value.get().revision)).rejects.toMatchObject({ status: 400 });
  });

  it('bounds inline context and requires a workspace for workspace-scoped context', async () => {
    const { value } = await service();
    await expect(value.saveContext({ name: 'Bad', description: '', scope: 'workspace', content: 'hello', enabled: true }, value.get().revision)).rejects.toThrow('workspace ID');
    await expect(value.saveContext({ name: 'Large', description: '', scope: 'global', content: 'x'.repeat(32_769), enabled: true }, value.get().revision)).rejects.toThrow('32768');
  });

  it('stores only secret metadata in configuration', async () => {
    const memory = new MemorySecretStore(); const vault = new SecretVault(memory); const { root, value } = await service(vault);
    const secretValue = 'sentinel-private-value';
    const updated = await value.createSecret({ name: 'API key', kind: 'api-key', scope: 'global', exposure: 'tool_only', toolIds: ['delegate_media_task'], agentIds: ['builtin-media'] }, secretValue, value.get().revision);
    expect(updated.secrets[0]).not.toHaveProperty('value');
    expect(await vault.read(updated.secrets[0].id)).toBe(secretValue);
    expect(await readFile(join(root, 'config.json'), 'utf8')).not.toContain(secretValue);
  });

  it('migrates the legacy broad media grant to independently configurable capabilities', async () => {
    const { root, value } = await service(); const stored = value.get();
    for (const profile of stored.profiles.filter((item) => ['coder', 'media'].some((stage) => item.stages.includes(stage as any)))) {
      profile.toolIds = profile.toolIds.filter((id) => !id.startsWith('media.generate_')).concat('delegate_media_task');
    }
    await writeFile(join(root, 'config.json'), `${JSON.stringify(stored, null, 2)}\n`);
    const reloaded = new AgentConfigService(root); const migrated = await reloaded.initialize();
    const coder = migrated.profiles.find((item) => item.id === 'builtin-coder')!;
    expect(coder.toolIds).toEqual(expect.arrayContaining(['media.generate_image', 'media.generate_video', 'media.generate_animation', 'media.generate_music', 'media.generate_sound_effect']));
    expect(coder.toolIds).not.toContain('delegate_media_task');
  });

  it('broadens only built-ins during the versioned catalog migration', async () => {
    const { root, value } = await service(); const stored: any = value.get(); stored.schemaVersion = 1;
    const custom = { ...structuredClone(stored.profiles[0]), id: 'custom-agent', kind: 'custom', toolIds: ['read_files'] };
    stored.profiles.push(custom); stored.overrides.push({ agentId: 'builtin-planner', workspaceId: 'workspace-one', toolIds: ['read_files'], revision: 1, updatedAt: new Date().toISOString() });
    stored.profiles.find((profile: any) => profile.id === 'builtin-planner').toolIds = ['read_files'];
    await writeFile(join(root, 'config.json'), `${JSON.stringify(stored, null, 2)}\n`);
    const migrated = await new AgentConfigService(root).initialize();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.profiles.find((profile) => profile.id === 'builtin-planner')?.toolIds).toContain('web.search');
    expect(migrated.profiles.find((profile) => profile.id === 'custom-agent')?.toolIds).toEqual(['read_files']);
    expect(migrated.overrides[0].toolIds).toEqual(['read_files']);
  });
});

class MemorySecretStore implements SecretStore {
  values = new Map<string, string>();
  async get(service: string, account: string) { return this.values.get(`${service}:${account}`) ?? null; }
  async set(service: string, account: string, value: string) { this.values.set(`${service}:${account}`, value); }
  async delete(service: string, account: string) { return this.values.delete(`${service}:${account}`); }
}
