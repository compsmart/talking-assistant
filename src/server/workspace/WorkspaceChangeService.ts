import { createHash, randomUUID } from 'node:crypto';
import type { WorkspaceEdit } from '../../shared/protocol.js';
import type { WorkspaceManager } from './WorkspaceManager.js';
import type { WorkspaceTools } from './WorkspaceTools.js';
import type { WorkspaceFiles } from './WorkspaceFiles.js';
import type { WorkspaceMutationLock } from './WorkspaceMutationLock.js';
import type { WorkspaceSettingsService } from './WorkspaceSettingsService.js';
import type { ActivityHub } from '../activity.js';

export class WorkspaceChangeService {
  private readonly editRequests = new Map<string, { signature: string; promise: Promise<unknown> }>();
  constructor(private readonly workspace: WorkspaceManager, private readonly tools: WorkspaceTools, private readonly files: WorkspaceFiles, private readonly lock: WorkspaceMutationLock, private readonly settings: WorkspaceSettingsService, private readonly activity?: ActivityHub) {}

  async edit(edits: WorkspaceEdit[], owner = 'a direct file edit', operationId?: string) {
    const paths = Array.isArray(edits) ? edits.map((edit) => String(edit?.path || '')).filter(Boolean).slice(0, 50) : [];
    const execute = () => this.transaction(owner, () => this.files.apply(edits), { skipValidation: true, source: 'direct-edit', paths, operationId });
    if (!operationId) return execute();
    const signature = createHash('sha256').update(JSON.stringify(edits)).digest('hex'); const existing = this.editRequests.get(operationId);
    if (existing) {
      if (existing.signature !== signature) throw Object.assign(new Error('The direct-edit operation ID was reused with different edits.'), { status: 409 });
      return existing.promise;
    }
    const promise = execute(); this.editRequests.set(operationId, { signature, promise });
    if (this.editRequests.size > 250) this.editRequests.delete(this.editRequests.keys().next().value!);
    return promise;
  }

  async remove(paths: string[]) {
    return this.transaction('a direct file deletion', () => this.files.remove(paths), { previewOnly: true });
  }

  async createFile(directory: string, name: string) {
    return this.transaction('a direct file creation', () => this.files.createFile(directory, name), { previewOnly: true, paths: [directory] });
  }

  async renameFile(path: string, newName: string) {
    return this.transaction('a direct file rename', () => this.files.renameFile(path, newName), { previewOnly: true, paths: [path] });
  }

  async copyFile(sourcePath: string, destinationDirectory: string) {
    return this.transaction('a direct file copy', () => this.files.copyFile(sourcePath, destinationDirectory), { previewOnly: true, paths: [sourcePath, destinationDirectory] });
  }

  async transaction<T>(owner: string, change: () => Promise<T>, options: { previewOnly?: boolean; skipValidation?: boolean; source?: 'direct-edit' | 'workspace'; paths?: string[]; operationId?: string } = {}) {
    const taskId = `manual-${randomUUID()}`;
    this.activity?.register({ id: taskId, operationId: options.operationId, workspaceId: this.workspace.workspaceId, source: options.source || 'workspace', title: owner, message: `Started ${owner}`, paths: options.paths });
    try { return await this.lock.run(owner, async () => {
      const before = await this.tools.manifest();
      try {
        const value = await change(); const after = await this.tools.manifest(); const changedFiles = this.tools.changed(before, after);
        const settings = this.settings.get(); const mode = settings.mode;
        const checks = options.skipValidation
          ? [{ name: 'independent validation', status: 'skipped' as const, details: 'Direct file edits do not run the coding-agent test pipeline.' }]
          : options.previewOnly
            ? [{ name: 'independent validation', status: 'skipped' as const, details: 'Direct file operations are verified by the publish build and browser health check.' }]
          : settings.codingAgent.validation === 'standard'
            ? await this.workspace.validate(taskId, changedFiles, mode)
            : [{ name: 'independent validation', status: 'skipped' as const, details: `${settings.codingAgent.validation} validation mode was selected.` }];
        const failed = checks.filter((check) => check.status === 'failed');
        if (failed.length) throw new Error(`Workspace validation failed: ${failed.map((check) => `${check.name}: ${check.details}`).join('\n')}`);
        const published = await this.workspace.publish(taskId, { mode, browserGuard: options.previewOnly || settings.codingAgent.validation === 'fast' });
        this.activity?.finish(taskId, 'succeeded', `Published ${changedFiles.length} changed file(s).`, { paths: changedFiles.map((file) => file.path) });
        return { value, changedFiles, checks, ...published };
      } catch (error) { await this.workspace.restoreDraft(); throw error; }
    }); } catch (error) {
      await this.activity?.emit(taskId, 'error', 'failed', (error as Error).message);
      this.activity?.finish(taskId, 'failed', (error as Error).message, { severity: 'error', paths: options.paths });
      throw error;
    }
  }
}
