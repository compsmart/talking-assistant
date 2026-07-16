import { describe, expect, it, vi } from 'vitest';
import { removeTreeWithRetries } from './GitWorktreeService.js';

describe('agent worktree removal', () => {
  it('retries transient Windows file-lock errors with bounded backoff', async () => {
    const remove = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('permission race'), { code: 'EPERM' }))
      .mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await removeTreeWithRetries('C:\\workspace\\agent-worktree', remove as any, wait);

    expect(remove).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 200]);
    expect(remove).toHaveBeenLastCalledWith('C:\\workspace\\agent-worktree', { recursive: true, force: true });
  });

  it('does not retry non-transient removal failures', async () => {
    const failure = Object.assign(new Error('invalid path'), { code: 'EINVAL' });
    const remove = vi.fn().mockRejectedValue(failure); const wait = vi.fn();

    await expect(removeTreeWithRetries('invalid', remove as any, wait)).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  });
});
