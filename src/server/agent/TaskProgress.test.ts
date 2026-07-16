import { describe, expect, it, vi } from 'vitest';
import { promptFor, TodoController } from './TaskManager.js';

function task() {
  return {
    kind: 'coding' as const, id: 'task-1', workspaceId: 'workspace-1', status: 'running' as const,
    request: { objective: 'Execute the plan' }, createdAt: '', updatedAt: '', todos: [], cancelled: false, referenceWorkspaceIds: [],
  };
}

describe('coding task progress', () => {
  it('creates stable todo IDs and applies atomic progress transitions', async () => {
    const value = task(); const publish = vi.fn(); const emit = vi.fn(async () => undefined);
    const controller = new TodoController(value as any, { emit } as any, publish);
    await controller.execute('create_todo_list', { items: ['Inspect state', 'Implement API', 'Wire UI'] });
    expect(value.todos).toMatchObject([{ id: '1', status: 'in_progress' }, { id: '2', status: 'pending' }, { id: '3', status: 'pending' }]);
    await controller.execute('update_todo_list', { updates: [{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress', note: 'Editing routes' }] });
    expect(value.todos[1]).toMatchObject({ id: '2', status: 'in_progress', note: 'Editing routes' });
    expect(publish).toHaveBeenCalledTimes(2); expect(emit).toHaveBeenCalledTimes(2);
  });

  it('rejects multiple in-progress todos', async () => {
    const value = task(); const controller = new TodoController(value as any, { emit: vi.fn() } as any, vi.fn());
    await controller.execute('create_todo_list', { items: ['One', 'Two'] });
    await expect(controller.execute('update_todo_list', { updates: [{ id: '2', status: 'in_progress' }] })).rejects.toThrow(/Only one todo/);
  });

  it('injects the reviewed plan and todo requirement into the coding prompt', () => {
    const settings = { mode: 'dom', codingAgent: {} } as any;
    const prompt = promptFor({ objective: 'Build settings', approvedPlan: { id: 'p1', path: 'plans/settings.md', hash: 'abc' } }, settings, '', [], '# Steps\n1. Add API');
    expect(prompt).toContain('authoritative task specification');
    expect(prompt).toContain('create a visible todo list');
    expect(prompt).toContain('plans/settings.md');
    expect(prompt).toContain('1. Add API');
  });
});
