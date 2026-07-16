import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssistantIntakeService } from './AssistantIntakeService.js';
import { WorkStore } from './WorkStore.js';

describe('Assistant intake', () => {
  it('executes multiple handoff calls for one user turn exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-assistant-intake-'));
    try {
      const store = new WorkStore(join(root, 'work.sqlite')); let decisions = 0; let submissions = 0;
      const orchestrator = {
        submit: (input: any) => { submissions++; const submitted = store.submit('workspace-1', input); return { disposition: submitted.duplicate ? 'duplicate' : 'accepted', work: submitted.work, message: 'ok' }; },
      };
      const coordinator = { manage: async () => { decisions++; await Promise.resolve(); return { action: 'create', objective: 'Generate space symbols', successCriteria: [], execution: 'media', message: 'Doing it' }; } };
      const service = new AssistantIntakeService(store, orchestrator as any, coordinator as any, {} as any, { active: () => ({ id: 'workspace-1' }) } as any, { get: () => ({ liveAgent: { directFileEdits: true } }) } as any);
      const request = { turnId: 'turn-1', userText: 'Generate space symbols' };
      const [first, second] = await Promise.all([service.handle(request), service.handle({ ...request, liveNote: 'A visual note' })]);
      expect(first).toEqual(second); expect(first.disposition).toBe('created'); expect(decisions).toBe(1); expect(submissions).toBe(1); expect(store.list('workspace-1')).toHaveLength(1);
      store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reuses a semantically matched active task without creating another row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-assistant-reuse-'));
    try {
      const store = new WorkStore(join(root, 'work.sqlite')); const existing = store.submit('workspace-1', { objective: 'Generate space-themed slot symbols' }).work;
      const coordinator = { manage: async () => ({ action: 'reuse', targetId: existing.id, message: 'Already running' }) };
      const service = new AssistantIntakeService(store, {} as any, coordinator as any, {} as any, { active: () => ({ id: 'workspace-1' }) } as any, { get: () => ({ liveAgent: { directFileEdits: true } }) } as any);
      const result = await service.handle({ turnId: 'turn-2', userText: 'Make those cosmic reel icons' });
      expect(result.disposition).toBe('reused'); expect(result.work?.id).toBe(existing.id); expect(store.list('workspace-1')).toHaveLength(1);
      store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
