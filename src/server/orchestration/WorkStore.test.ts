import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { WorkStore } from './WorkStore.js';

describe('durable work store', () => {
  it('deduplicates active work, revisions updates, and recovers interrupted runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-store-'));
    try {
      const store = new WorkStore(join(root, 'work.sqlite'));
      const first = store.submit('workspace-1', { objective: 'Change the heading', clientRequestId: 'call-1' });
      expect(first.duplicate).toBe(false);
      expect(store.submit('workspace-1', { objective: '  change   the heading ' }).duplicate).toBe(true);
      store.update(first.work.id, (work) => ({ ...work, status: 'running' }));
      expect(store.recover()).toBe(1); expect(store.get(first.work.id)?.status).toBe('queued');
      expect(store.events('workspace-1').some(({ event }) => event.type === 'work_snapshot')).toBe(true); store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('makes operation IDs idempotent and rejects changed replays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-operation-'));
    try {
      const store = new WorkStore(join(root, 'work.sqlite')); let calls = 0;
      expect(store.operation('same', { value: 1 }, () => ++calls)).toBe(1);
      expect(store.operation('same', { value: 1 }, () => ++calls)).toBe(1); expect(calls).toBe(1);
      expect(() => store.operation('same', { value: 2 }, () => 3)).toThrow(/different arguments/i); store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('persists one Assistant result per authoritative user turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-assistant-turn-'));
    try {
      const store = new WorkStore(join(root, 'work.sqlite')); const signature = { userText: 'Generate space symbols' };
      expect(store.assistantResult('workspace-1', 'turn-1', signature)).toBeUndefined();
      store.saveAssistantResult('workspace-1', 'turn-1', signature, { disposition: 'created', message: 'Queued' });
      expect(store.assistantResult('workspace-1', 'turn-1', signature)).toEqual({ disposition: 'created', message: 'Queued' });
      expect(() => store.assistantResult('workspace-1', 'turn-1', { userText: 'Different' })).toThrow(/different user input/i);
      store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
