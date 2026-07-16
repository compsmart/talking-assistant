import { describe, expect, it, vi } from 'vitest';
import { PlanManager } from './PlanManager.js';
import { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';

describe('PlanManager concurrency', () => {
  it('holds the workspace lock and rejects a second agent run while planning', async () => {
    let finish!: (value: any) => void;
    const planning = new Promise<any>((resolve) => { finish = resolve; });
    const lock = new WorkspaceMutationLock();
    const activity = { update: vi.fn(), emit: vi.fn(async () => undefined), getTask: vi.fn() };
    const manager = new PlanManager(
      { perform: vi.fn(() => planning) } as any,
      { saveGenerated: vi.fn(async (id: string) => ({ id, path: 'plans/plan.md', hash: 'hash' })) } as any,
      { buildTaskContext: vi.fn(async () => ({ text: 'files', fileCount: 1, matchCount: 0, truncated: false })) } as any,
      activity as any, lock, { get: () => ({ mode: 'dom' }) } as any, { resolve: () => [] } as any,
      { active: () => ({ id: 'workspace-1' }), get: () => ({ name: 'Workspace' }) } as any,
    );

    const run = manager.create({ objective: 'Build a complex feature' });
    expect(run.kind).toBe('planning'); expect(lock.busy).toBe(true);
    expect(() => manager.create({ objective: 'Start another plan' })).toThrow(/already working/);
    finish({ status: 'completed', content: '# Plan', interactionCount: 1, segment: 1 });
    await vi.waitFor(() => expect(manager.getActive()).toBeUndefined());
    expect(lock.busy).toBe(false);
  });

  it('pauses with the lock held and resumes only the matching planning run', async () => {
    const continuation = { previousInteractionId: 'interaction-79', input: [{ type: 'function_result' }], interactionCount: 80, segment: 1 };
    const perform = vi.fn()
      .mockResolvedValueOnce({ status: 'paused', reason: 'step_limit', message: 'Continue?', continuation })
      .mockResolvedValueOnce({ status: 'completed', content: '# Resumed plan', interactionCount: 81, segment: 2 });
    const lock = new WorkspaceMutationLock();
    const manager = new PlanManager(
      { perform } as any, { saveGenerated: vi.fn(async (id: string) => ({ id, path: 'plans/resumed.md', hash: 'hash' })) } as any,
      { buildTaskContext: vi.fn(async () => ({ text: 'files', fileCount: 1, matchCount: 0, truncated: false })) } as any,
      { update: vi.fn(), emit: vi.fn(async () => undefined), getTask: vi.fn() } as any, lock, { get: () => ({ mode: 'dom' }) } as any,
      { resolve: () => [] } as any, { active: () => ({ id: 'workspace-1' }), get: () => ({ name: 'Workspace' }) } as any,
    );
    const run = manager.create({ objective: 'Plan a large migration' });
    await vi.waitFor(() => expect(manager.getActive()?.status).toBe('awaiting_continuation'));
    expect(lock.busy).toBe(true); expect(manager.continue('another-run', true)).toBe(false);
    expect(manager.continue(run.id, true)).toBe(true);
    await vi.waitFor(() => expect(manager.getActive()).toBeUndefined());
    expect(perform).toHaveBeenCalledTimes(2);
    expect(perform.mock.calls[1][4]).toEqual(continuation);
    expect(lock.busy).toBe(false);
  });

  it('stops a paused run when the user declines continuation', async () => {
    const continuation = { previousInteractionId: 'interaction-80', input: 'next', interactionCount: 80, segment: 1 };
    const lock = new WorkspaceMutationLock();
    const manager = new PlanManager(
      { perform: vi.fn().mockResolvedValue({ status: 'paused', reason: 'timeout', message: 'Timed out', continuation }) } as any,
      { saveGenerated: vi.fn() } as any, { buildTaskContext: vi.fn(async () => ({ text: '', fileCount: 0, matchCount: 0, truncated: false })) } as any,
      { update: vi.fn(), emit: vi.fn(async () => undefined), getTask: vi.fn() } as any, lock, { get: () => ({ mode: 'dom' }) } as any,
      { resolve: () => [] } as any, { active: () => ({ id: 'workspace-1' }), get: () => ({ name: 'Workspace' }) } as any,
    );
    const run = manager.create({ objective: 'Plan something large' });
    await vi.waitFor(() => expect(manager.getActive()?.status).toBe('awaiting_continuation'));
    expect(manager.continue(run.id, false)).toBe(true);
    await vi.waitFor(() => expect(manager.getActive()).toBeUndefined());
    expect(lock.busy).toBe(false);
  });
});
