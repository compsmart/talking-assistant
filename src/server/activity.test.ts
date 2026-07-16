import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityHub } from './activity.js';

describe('activity journal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('filters workspace records and tracks unresolved failures', () => {
    const hub = new ActivityHub();
    hub.register({ id: 'one', workspaceId: 'a', source: 'direct-edit', title: 'Edit index', message: 'started' });
    hub.register({ id: 'two', workspaceId: 'b', source: 'http', title: 'POST edit', message: 'conflict', status: 'failed', severity: 'error' });
    hub.recordFailure({ id: 'three', workspaceId: 'a', source: 'http', title: 'POST edit', message: 'busy', httpStatus: 409 });
    expect(hub.list({ workspaceId: 'a' })).toMatchObject({ unresolved: 1 });
    expect(hub.list({ workspaceId: 'a' }).items.map((item) => item.id)).toEqual(['three', 'one']);
    expect(hub.list({ workspaceId: 'a', all: true }).items).toHaveLength(3);
  });

  it('persists resolution state in the in-memory feed', () => {
    const hub = new ActivityHub(); hub.recordFailure({ id: 'failure', workspaceId: 'a', source: 'system', title: 'Failure', message: 'broken' });
    expect(hub.list({ workspaceId: 'a' }).unresolved).toBe(1);
    expect(hub.resolve('failure', 'Recovered')?.resolution).toBe('Recovered');
    expect(hub.list({ workspaceId: 'a' }).unresolved).toBe(0);
  });

  it('clears only records belonging to the requested workspace', async () => {
    const hub = new ActivityHub();
    hub.register({ id: 'clear-a', workspaceId: 'a', source: 'system', title: 'A', message: 'remove' });
    hub.register({ id: 'keep-b', workspaceId: 'b', source: 'system', title: 'B', message: 'keep' });
    await expect(hub.clearWorkspace('a', false)).resolves.toMatchObject({ cleared: 1, workspaceId: 'a' });
    expect(hub.list({ workspaceId: 'a' }).items).toHaveLength(0);
    expect(hub.list({ workspaceId: 'b' }).items.map((item) => item.id)).toEqual(['keep-b']);
  });
});
