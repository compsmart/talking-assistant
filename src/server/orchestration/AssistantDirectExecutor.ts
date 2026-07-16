import { CodingAgent, type AgentRuntimeProfile } from '../agent/CodingAgent.js';
import type { ActivityHub } from '../activity.js';
import type { AssistantIntakeRequest, FileReference } from '../../shared/protocol.js';
import type { WorkspaceChangeService } from '../workspace/WorkspaceChangeService.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';

const FAST_AGENT: AgentRuntimeProfile = {
  id: 'assistant-fast-edit',
  name: 'Assistant Fast Edit',
  revision: 1,
  stage: 'coder',
  enabledToolIds: ['locate_code', 'read_files', 'apply_edits'],
  instructions: `Perform only one focused edit to one existing workspace file.
Read or locate the exact target before editing. Use apply_edits once and change exactly one existing code, text, style, or configuration file.
Do not create, delete, rename, copy, or touch dependencies. If the request is ambiguous, needs more than one file, or cannot be completed with one atomic edit, make no change and say FAST_PATH_NOT_APPLICABLE.`,
};

export class AssistantDirectExecutor {
  constructor(
    private readonly tools: WorkspaceTools,
    private readonly changes: WorkspaceChangeService,
    private readonly settings: WorkspaceSettingsService,
    private readonly activity: ActivityHub,
  ) {}

  async execute(request: AssistantIntakeRequest, objective: string) {
    const operationId = `assistant-fast:${request.turnId}`;
    return this.changes.assistantEdit(operationId, objective, async (taskId) => {
      const before = await this.tools.manifest(); const dependencyBefore = await this.tools.dependencyFingerprint();
      const agent = new CodingAgent(this.tools, this.activity); agent.beginTask();
      const context = await this.tools.buildTaskContext({ objective, selectedElement: request.selectedElement, selectedFiles: request.selectedFiles });
      const performed = await agent.perform(taskId, `Make this single focused workspace edit:\n\n${objective}\n\n${context.text}\n\nIf it cannot be completed by atomically editing exactly one existing file, do not mutate anything and finish with FAST_PATH_NOT_APPLICABLE.`, () => false, this.settings.get(), undefined, [], { objective, criteria: [], agent: FAST_AGENT });
      const after = await this.tools.manifest(); const changed = this.tools.changed(before, after);
      if (performed.summary.includes('FAST_PATH_NOT_APPLICABLE') || changed.length !== 1 || changed[0].action !== 'modified' || dependencyBefore !== await this.tools.dependencyFingerprint()) {
        throw new FastPathNotApplicable('The request requires the durable workspace pipeline.');
      }
      return { summary: performed.summary, changedFiles: changed as FileReference[] };
    });
  }
}

export class FastPathNotApplicable extends Error {}
