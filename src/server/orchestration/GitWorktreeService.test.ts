import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../process.js';
import { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import { GitWorktreeService } from './GitWorktreeService.js';
import type { WorkItemSnapshot } from '../../shared/protocol.js';

describe('Git worktree integration', () => {
  it('isolates a worker and promotes one audited task commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-git-worktree-')); const gitDir = join(root, 'git'); const draftDir = join(root, 'draft'); const stateDir = join(root, 'state');
    try {
      await Promise.all([mkdir(draftDir), mkdir(stateDir)]); await writeFile(join(draftDir, 'app.txt'), 'base\n');
      await ok('git', ['init', '--bare', gitDir]);
      await ok('git', [`--git-dir=${gitDir}`, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      for (const [key, value] of [['core.bare', 'false'], ['user.name', 'Cowork Test'], ['user.email', 'test@example.com']]) await ok('git', [`--git-dir=${gitDir}`, 'config', key, value]);
      await ok('git', [`--git-dir=${gitDir}`, `--work-tree=${draftDir}`, 'add', '-A']); await ok('git', [`--git-dir=${gitDir}`, `--work-tree=${draftDir}`, 'commit', '-m', 'initial']);
      const registry = { get: () => ({ id: 'workspace-1', gitDir, draftDir, stateDir }) } as any;
      const workspace = { publish: vi.fn(async () => ({ version: 'v2', previewUrl: '/preview' })) } as any;
      const service = new GitWorktreeService(registry, workspace, new WorkspaceMutationLock()); const task = await service.create('workspace-1', 'attempt-1');
      await writeFile(join(task.root, 'app.txt'), 'changed\n'); const committed = await service.commitAttempt(task, 'worker commit');
      const work = { id: 'work-1', workspaceId: 'workspace-1', specRevision: 1, request: { objective: 'Change app text' } } as WorkItemSnapshot;
      const integrated = await service.integrate(work, task, committed.headCommit, async () => [{ name: 'test', status: 'passed' }]);
      expect(await readFile(join(draftDir, 'app.txt'), 'utf8')).toBe('changed\n'); expect(integrated.commit).toMatch(/^[a-f0-9]{40}$/); expect(workspace.publish).toHaveBeenCalled();
      const message = (await ok('git', [`--git-dir=${gitDir}`, 'log', '-1', '--pretty=%B'])).stdout; expect(message).toContain('Cowork-Task-ID: work-1');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

async function ok(executable: string, args: string[]) { const result = await run(executable, args, { timeout: 20_000 }); if (result.code) throw new Error(result.stderr || result.stdout); return result; }
