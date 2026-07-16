import type { ActivityHub } from '../activity.js';
import { CodingAgent, type AgentRuntimeProfile } from '../agent/CodingAgent.js';
import { promptFor } from '../agent/TaskManager.js';
import type { WorkspaceManager } from '../workspace/WorkspaceManager.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';
import type { TaskResult, WorkItemSnapshot } from '../../shared/protocol.js';
import type { GitWorktreeService } from './GitWorktreeService.js';

export class ConcurrentCodingRunner {
  private cancelled = new Set<string>();
  constructor(private readonly git: GitWorktreeService, private readonly baseTools: WorkspaceTools, private readonly workspace: WorkspaceManager, private readonly settings: WorkspaceSettingsService, private readonly activity: ActivityHub) {}

  cancel(attemptId: string) { this.cancelled.add(attemptId); }

  async execute(work: WorkItemSnapshot, attemptId: string, referenceWorkspaceIds: string[] = [], approvedPlanContent?: string, agentProfile?: AgentRuntimeProfile): Promise<TaskResult & { commit: string }> {
    const task = await this.git.create(work.workspaceId, attemptId); const tools = this.baseTools.scoped(task.root); const agent = new CodingAgent(tools, this.activity);
    const cancelled = () => this.cancelled.has(attemptId); const settings = this.settings.get(work.workspaceId); const before = await tools.manifest();
    try {
      const phase = agentProfile?.stage === 'media' ? 'media' : 'coding';
      await this.activity.emit(attemptId, 'status', phase, `${phase === 'media' ? 'Producing media' : 'Implementing'} in isolated branch ${task.branch}: ${work.request.objective}`);
      const context = await tools.buildTaskContext(work.request); const canvas = work.request.includeCanvasImage ? await this.workspace.captureCurrentCanvas().catch(() => undefined) : undefined;
      agent.beginTask();
      const performed = await agent.perform(attemptId, promptFor(work.request, settings, context.text, [], approvedPlanContent), cancelled, settings, canvas, referenceWorkspaceIds, { objective: work.request.objective, criteria: work.request.successCriteria, agent: agentProfile });
      if (cancelled()) throw new Error('Task cancelled');
      const committed = await this.git.commitAttempt(task, `cowork worker: ${work.request.objective.slice(0, 64)}\n\nCowork-Task-ID: ${work.id}\nCowork-Attempt-ID: ${attemptId}\nCowork-Spec-Revision: ${work.specRevision}`);
      await this.activity.emit(attemptId, 'status', 'integrating', `Integrating ${committed.changedFiles.length} changed file(s) from ${committed.headCommit.slice(0, 10)}`);
      const integrated = await this.git.integrate(work, task, committed.headCommit, (root, changed) => this.workspace.validate(attemptId, changed, settings.mode, root));
      const after = await tools.manifest().catch(() => before); const changedFiles = committed.changedFiles.length ? committed.changedFiles : tools.changed(before, after);
      await this.git.cleanup(task, true); this.cancelled.delete(attemptId);
      return { taskId: work.id, status: 'completed', summary: performed.summary || `Completed ${work.request.objective}`, changedFiles, checks: integrated.checks, retries: 0, previewVersion: integrated.previewVersion, previewUrl: integrated.previewUrl, commit: integrated.commit };
    } catch (error) {
      const isCancelled = cancelled() || /task cancelled/i.test((error as Error).message); this.cancelled.delete(attemptId);
      return { taskId: work.id, status: isCancelled ? 'cancelled' : 'failed', summary: isCancelled ? 'Task cancelled; its isolated branch was not integrated.' : (error as Error).message, changedFiles: [], checks: [], retries: 0, commit: '' };
    }
  }
}
