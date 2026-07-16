import { describe, expect, it } from 'vitest';
import { deriveMediaAgentProgress } from './mediaProgress';

describe('Media Agent progress', () => {
  it('shows durable Media Agent work before a nested media job exists', () => {
    const value = deriveMediaAgentProgress([{ id: 'work', status: 'running', updatedAt: '2026-01-01T00:00:00Z', request: { objective: 'Extract the selected sprite sheet' }, subtasks: [{ role: 'media' }], attempts: [] } as any], []);
    expect(value).toMatchObject({ workId: 'work', stage: 'Running', progress: 5, detail: 'Extract the selected sprite sheet' });
  });

  it('reports the current persistent media-job stage and percentage', () => {
    const value = deriveMediaAgentProgress([], [{ id: 'job', status: 'running', updatedAt: '2026-01-01T00:00:00Z', request: { kind: 'image', name: 'space-symbols' }, stages: [{ name: 'generate', status: 'running', progress: 42 }] }] as any);
    expect(value).toMatchObject({ jobId: 'job', stage: 'Generate', progress: 42, detail: 'Image · space-symbols' });
  });

  it('hides completed media work', () => {
    expect(deriveMediaAgentProgress([{ id: 'work', status: 'completed', subtasks: [{ role: 'media' }], attempts: [] } as any], [{ id: 'job', status: 'completed', stages: [] } as any])).toBeUndefined();
  });
});
