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
  private readonly pendingDeletionPublications = new Map<string, string[]>();
  private deletionPublishTimer?: NodeJS.Timeout;
  private deletionPublishRunning = false;
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

  async assistantEdit<T>(operationId: string, objective: string, change: (taskId: string) => Promise<T>) {
    return this.transaction(`Assistant fast edit: ${objective.slice(0, 120)}`, change, { skipValidation: true, source: 'direct-edit', operationId });
  }

  async remove(paths: string[]) {
    const taskId = `manual-${randomUUID()}`;
    this.activity?.register({
      id: taskId,
      workspaceId: this.workspace.workspaceId,
      source: 'workspace',
      title: 'a direct file deletion',
      message: 'Deleting workspace files.',
      paths,
      publicationPending: true,
    });
    try {
      return await this.lock.run('a direct file deletion', async () => {
        const value = await this.files.remove(paths);
        this.pendingDeletionPublications.set(taskId, value);
        await this.activity?.emit(taskId, 'status', 'mutation', `Deleted ${value.length} file(s). Preview publication is queued.`, { paths: value, publicationPending: true });
        this.scheduleDeletionPublication();
        return {
          value,
          changedFiles: value.map((path) => ({ path, action: 'deleted' as const })),
          checks: [{ name: 'preview publication', status: 'skipped' as const, details: 'Queued in the background so the file operation can return immediately.' }],
          publicationId: taskId,
          publicationPending: true as const,
        };
      });
    } catch (error) {
      await this.activity?.emit(taskId, 'error', 'failed', (error as Error).message);
      this.activity?.finish(taskId, 'failed', (error as Error).message, { severity: 'error', paths, publicationPending: false });
      throw error;
    }
  }

  private scheduleDeletionPublication() {
    if (this.deletionPublishTimer || this.deletionPublishRunning) return;
    this.deletionPublishTimer = setTimeout(() => {
      this.deletionPublishTimer = undefined;
      void this.publishPendingDeletions();
    }, 200);
    this.deletionPublishTimer.unref?.();
  }

  private async publishPendingDeletions() {
    if (this.deletionPublishRunning || !this.pendingDeletionPublications.size) return;
    this.deletionPublishRunning = true;
    const batch = [...this.pendingDeletionPublications.entries()];
    this.pendingDeletionPublications.clear();
    const [publicationId] = batch[0];
    const paths = [...new Set(batch.flatMap(([, changedPaths]) => changedPaths))];
    try {
      for (const [taskId] of batch) await this.activity?.emit(taskId, 'status', 'publishing', `Publishing ${paths.length} deleted file(s) in one preview build.`, { paths });
      const published = await this.lock.enqueue('background deletion preview publication', () => {
        const mode = this.settings.get().mode;
        return this.workspace.publish(publicationId, { mode, browserGuard: true });
      });
      for (const [taskId, taskPaths] of batch) {
        await this.activity?.emit(taskId, 'complete', 'published', 'The updated preview is healthy and live.', { previewVersion: published.version, paths: taskPaths });
        this.activity?.finish(taskId, 'succeeded', `Deleted ${taskPaths.length} file(s) and published the updated preview.`, { paths: taskPaths, previewVersion: published.version, publicationPending: false });
      }
    } catch (error) {
      const message = `The files were deleted, but the replacement preview could not be published: ${(error as Error).message}. The previous immutable preview remains live and available for rollback.`;
      for (const [taskId, taskPaths] of batch) {
        await this.activity?.emit(taskId, 'error', 'publishing', message, { paths: taskPaths });
        this.activity?.finish(taskId, 'failed', message, { severity: 'error', paths: taskPaths, publicationPending: false });
      }
    } finally {
      this.deletionPublishRunning = false;
      if (this.pendingDeletionPublications.size) this.scheduleDeletionPublication();
    }
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

  async transaction<T>(owner: string, change: (taskId: string) => Promise<T>, options: { previewOnly?: boolean; skipValidation?: boolean; source?: 'direct-edit' | 'workspace'; paths?: string[]; operationId?: string } = {}) {
    const taskId = `manual-${randomUUID()}`;
    this.activity?.register({ id: taskId, operationId: options.operationId, workspaceId: this.workspace.workspaceId, source: options.source || 'workspace', title: owner, message: `Started ${owner}`, paths: options.paths });
    try { return await this.lock.run(owner, async () => {
      const before = await this.tools.manifest();
      try {
        const value = await change(taskId); const after = await this.tools.manifest(); const changedFiles = this.tools.changed(before, after);
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
      } catch (error) { await this.workspace.restoreDraft(taskId); throw error; }
    }); } catch (error) {
      await this.activity?.emit(taskId, 'error', 'failed', (error as Error).message);
      this.activity?.finish(taskId, 'failed', (error as Error).message, { severity: 'error', paths: options.paths });
      throw error;
    }
  }
}
