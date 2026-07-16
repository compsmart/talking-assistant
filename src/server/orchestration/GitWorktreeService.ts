import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, FileReference, WorkItemSnapshot } from '../../shared/protocol.js';
import { run } from '../process.js';
import type { WorkspaceManager } from '../workspace/WorkspaceManager.js';
import type { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';

export interface TaskWorktree { workspaceId: string; attemptId: string; root: string; branch: string; baseCommit: string }
export interface IntegratedTask { commit: string; changedFiles: FileReference[]; checks: CheckResult[]; previewVersion: string; previewUrl: string }

export class GitWorktreeService {
  private chains = new Map<string, Promise<unknown>>();
  constructor(private readonly registry: WorkspaceRegistry, private readonly workspace: WorkspaceManager, private readonly lock: WorkspaceMutationLock) {}

  create(workspaceId: string, attemptId: string): Promise<TaskWorktree> {
    return this.serial(workspaceId, () => this.lock.enqueue(`preparing agent branch ${attemptId.slice(0, 8)}`, async () => {
      const context = this.registry.get(workspaceId); await this.prepare(context.gitDir);
      await this.checkpoint(workspaceId, `cowork: checkpoint workspace changes before ${attemptId.slice(0, 8)}`);
      const baseCommit = await this.output(context.gitDir, ['rev-parse', 'refs/heads/main']);
      const branch = `cowork/task/${safe(attemptId)}`; const root = join(context.stateDir, 'agent-worktrees', safe(attemptId));
      await removeTreeWithRetries(root); await mkdir(join(context.stateDir, 'agent-worktrees'), { recursive: true });
      await this.command(context.gitDir, ['branch', '-D', branch], true);
      await this.command(context.gitDir, ['worktree', 'add', '-b', branch, root, baseCommit]);
      return { workspaceId, attemptId, root, branch, baseCommit };
    }));
  }

  async commitAttempt(worktree: TaskWorktree, message: string) {
    await commandAt(worktree.root, ['add', '-A']);
    await commandAt(worktree.root, ['commit', '--allow-empty', '-m', message]);
    const headCommit = await outputAt(worktree.root, ['rev-parse', 'HEAD']);
    const changedFiles = await diffFilesAt(worktree.root, `${worktree.baseCommit}..${headCommit}`);
    return { headCommit, changedFiles };
  }

  integrate(work: WorkItemSnapshot, task: TaskWorktree, headCommit: string, validate: (root: string, changed: FileReference[]) => Promise<CheckResult[]>): Promise<IntegratedTask> {
    return this.serial(work.workspaceId, () => this.lock.enqueue(`integration for ${work.request.objective}`, async () => {
      const context = this.registry.get(work.workspaceId); await this.checkpoint(work.workspaceId, `cowork: checkpoint workspace changes before integrating ${work.id.slice(0, 8)}`);
      const main = await this.output(context.gitDir, ['rev-parse', 'refs/heads/main']);
      const integrationBranch = `cowork/integration/${safe(work.id)}-${work.specRevision}`; const root = join(context.stateDir, 'agent-worktrees', `integration-${safe(work.id)}`);
      await removeTreeWithRetries(root); await this.command(context.gitDir, ['branch', '-D', integrationBranch], true);
      await this.command(context.gitDir, ['worktree', 'add', '-b', integrationBranch, root, main]);
      try {
        const merge = await run('git', ['merge', '--no-ff', '--no-commit', headCommit], { cwd: root, timeout: 120_000 });
        if (merge.code) {
          const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: root });
          throw statusError(`Concurrent task conflict${conflicts.stdout.trim() ? ` in: ${conflicts.stdout.trim().replace(/\r?\n/g, ', ')}` : ''}. The task was kept for conflict resolution.`, 409);
        }
        const changedFiles = await diffFilesAt(root, main);
        const checks = await validate(root, changedFiles); const failed = checks.filter((check) => check.status === 'failed');
        if (failed.length) throw new Error(`Validation failed: ${failed.map((check) => `${check.name}: ${check.details || 'failed'}`).join('; ')}`);
        await commandAt(root, ['add', '-A']); const tree = await outputAt(root, ['write-tree']);
        const subject = `cowork: ${work.request.objective.replace(/\s+/g, ' ').slice(0, 64)}`;
        const commit = await this.output(context.gitDir, ['commit-tree', tree, '-p', main, '-m', subject, '-m', `Cowork-Task-ID: ${work.id}\nCowork-Spec-Revision: ${work.specRevision}\nCowork-Worker-Commit: ${headCommit}`]);
        const current = await this.output(context.gitDir, ['rev-parse', 'refs/heads/main']);
        if (current !== main) throw statusError('Main advanced during validation; the task will be retried against the new version.', 409);
        await this.command(context.gitDir, ['update-ref', 'refs/heads/main', commit, main]);
        try {
          await this.command(context.gitDir, [`--work-tree=${context.draftDir}`, 'reset', '--hard', commit]);
          const published = await this.workspace.publish(work.id, { browserGuard: false });
          return { commit, changedFiles, checks, previewVersion: published.version, previewUrl: published.previewUrl };
        } catch (error) {
          await this.command(context.gitDir, ['update-ref', 'refs/heads/main', main, commit], true);
          await this.command(context.gitDir, [`--work-tree=${context.draftDir}`, 'reset', '--hard', main], true);
          throw error;
        }
      } finally {
        await this.command(context.gitDir, ['worktree', 'remove', '--force', root], true); await removeTreeWithRetries(root); await this.command(context.gitDir, ['worktree', 'prune'], true);
        await this.command(context.gitDir, ['branch', '-D', integrationBranch], true);
      }
    }));
  }

  cleanup(task: TaskWorktree, removeBranch = true) {
    return this.serial(task.workspaceId, async () => {
      const context = this.registry.get(task.workspaceId); await this.command(context.gitDir, ['worktree', 'remove', '--force', task.root], true); await removeTreeWithRetries(task.root); await this.command(context.gitDir, ['worktree', 'prune'], true);
      if (removeBranch) await this.command(context.gitDir, ['branch', '-D', task.branch], true);
    });
  }

  private async checkpoint(workspaceId: string, message: string) {
    const context = this.registry.get(workspaceId); const prefix = [`--work-tree=${context.draftDir}`];
    const status = await this.output(context.gitDir, [...prefix, 'status', '--porcelain']); if (!status.trim()) return;
    await this.command(context.gitDir, [...prefix, 'add', '-A']); await this.command(context.gitDir, [...prefix, 'commit', '-m', message]);
  }
  private async prepare(gitDir: string) {
    await this.command(gitDir, ['config', 'core.bare', 'true']); await this.command(gitDir, ['config', 'core.autocrlf', 'false']); await this.command(gitDir, ['config', 'core.eol', 'lf']);
    const excludePath = join(gitDir, 'info', 'exclude'); const existing = await readFile(excludePath, 'utf8').catch(() => ''); const required = ['node_modules/', 'dist/', 'plans/', '*.log'];
    const missing = required.filter((line) => !existing.split(/\r?\n/).includes(line)); if (missing.length) await writeFile(excludePath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
    await this.command(gitDir, ['worktree', 'prune']);
  }
  private command(gitDir: string, args: string[], ignoreFailure = false) { return gitCommand(gitDir, args, ignoreFailure); }
  private async output(gitDir: string, args: string[]) { return (await gitCommand(gitDir, args)).stdout.trim(); }
  private serial<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workspaceId) || Promise.resolve(); const next = previous.catch(() => undefined).then(operation);
    this.chains.set(workspaceId, next); const cleanup = () => { if (this.chains.get(workspaceId) === next) this.chains.delete(workspaceId); }; void next.then(cleanup, cleanup); return next;
  }
}

async function gitCommand(gitDir: string, args: string[], ignoreFailure = false) { const result = await run('git', [`--git-dir=${gitDir}`, ...args], { timeout: 120_000 }); if (result.code && !ignoreFailure) throw new Error(`Workspace Git failed: ${result.stderr || result.stdout}`); return result; }
async function commandAt(root: string, args: string[]) { const result = await run('git', args, { cwd: root, timeout: 120_000 }); if (result.code) throw new Error(`Task Git failed: ${result.stderr || result.stdout}`); return result; }
async function outputAt(root: string, args: string[]) { return (await commandAt(root, args)).stdout.trim(); }
async function diffFilesAt(root: string, range: string): Promise<FileReference[]> {
  const result = await commandAt(root, ['diff', '--name-status', range]); return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [status, ...parts] = line.split('\t'); return { path: parts.at(-1) || '', action: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified' } as FileReference; });
}
function safe(value: string) { return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }

const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const REMOVE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_200, 1_600, 2_000, 2_500];

export async function removeTreeWithRetries(path: string, remove: typeof rm = rm, wait: (milliseconds: number) => Promise<unknown> = delay) {
  for (let attempt = 0; ; attempt++) {
    try { await remove(path, { recursive: true, force: true }); return; }
    catch (error: any) {
      const retryDelay = REMOVE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !RETRYABLE_REMOVE_ERRORS.has(error?.code)) throw error;
      await wait(retryDelay);
    }
  }
}

function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
