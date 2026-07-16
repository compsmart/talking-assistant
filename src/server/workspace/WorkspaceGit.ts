import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../process.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

export class WorkspaceGit {
  constructor(private readonly registry: WorkspaceRegistry) {}
  async initialize(workspaceId = this.registry.active().id) {
    const context = this.registry.get(workspaceId);
    if (!await exists(join(context.gitDir, 'HEAD'))) {
      await mkdir(context.gitDir, { recursive: true });
      await this.command(['init', '--bare', context.gitDir], workspaceId);
      await this.command(['symbolic-ref', 'HEAD', 'refs/heads/main'], workspaceId);
      await this.command(['config', 'core.bare', 'false'], workspaceId);
      await this.command(['config', 'core.autocrlf', 'false'], workspaceId);
      await this.command(['config', 'core.eol', 'lf'], workspaceId);
      await this.command(['config', 'user.name', 'Cowork'], workspaceId);
      await this.command(['config', 'user.email', 'cowork@localhost'], workspaceId);
      await mkdir(join(context.gitDir, 'info'), { recursive: true });
      await writeFile(join(context.gitDir, 'info', 'exclude'), 'node_modules/\ndist/\n*.log\n', 'utf8');
      await this.command(['add', '-A'], workspaceId);
      await this.command(['commit', '--allow-empty', '-m', 'chore: initialize workspace'], workspaceId);
    }
    // Workspace writers use LF on every platform. Override machine-wide
    // autocrlf settings so staging is stable and warning-free on Windows.
    await this.command(['config', 'core.autocrlf', 'false'], workspaceId);
    await this.command(['config', 'core.eol', 'lf'], workspaceId);
  }

  async status(workspaceId = this.registry.active().id) {
    const result = await this.command(['status', '--porcelain=v1'], workspaceId);
    const changes = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
    return { dirty: changes.length > 0, changes, fingerprint: await this.fingerprint(workspaceId) };
  }

  async commit(workspaceId = this.registry.active().id) {
    await this.command(['add', '-A'], workspaceId); const current = await this.status(workspaceId);
    if (!current.dirty) return { committed: false, message: 'Workspace is already clean.' };
    await this.command(['commit', '-m', 'chore: save workspace changes'], workspaceId);
    const hash = (await this.command(['rev-parse', '--short', 'HEAD'], workspaceId)).stdout.trim();
    return { committed: true, hash, files: current.changes.length, message: 'chore: save workspace changes' };
  }

  private async command(args: string[], workspaceId: string) {
    const context = this.registry.get(workspaceId);
    const commandArgs = args[0] === 'init' ? args : [`--git-dir=${context.gitDir}`, `--work-tree=${context.draftDir}`, ...args];
    const result = await run('git', commandArgs, { timeout: 120_000 });
    if (result.code) throw new Error(`Workspace Git failed: ${result.stderr || result.stdout}`);
    return result;
  }

  private async fingerprint(workspaceId: string) {
    const context = this.registry.get(workspaceId);
    const [diff, untracked] = await Promise.all([
      this.command(['diff', '--no-ext-diff', '--binary', 'HEAD'], workspaceId),
      this.command(['ls-files', '--others', '--exclude-standard', '-z'], workspaceId),
    ]);
    const hash = createHash('sha256').update(diff.stdout);
    for (const path of untracked.stdout.split('\0').filter(Boolean).sort()) {
      hash.update('\0').update(path).update('\0');
      hash.update(await readFile(join(context.draftDir, path)));
    }
    return hash.digest('hex');
  }
}

async function exists(path: string) { return stat(path).then(() => true).catch(() => false); }
