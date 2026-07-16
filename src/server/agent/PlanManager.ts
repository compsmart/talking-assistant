import { randomUUID } from 'node:crypto';
import type { ActivityHub } from '../activity.js';
import type { PlanRequest, PlanResult, PlanningRunSnapshot, PlanningStatus, WorkspaceSettings } from '../../shared/protocol.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';
import type { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { WorkspaceReferenceGrants } from '../workspace/WorkspaceReferenceGrants.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import type { PlanningAgent } from './PlanningAgent.js';
import type { PlanStore } from './PlanStore.js';
import type { PlanningContinuationState } from './PlanningAgent.js';
import type { AgentRuntimeProfile } from './CodingAgent.js';

interface InternalPlan extends PlanningRunSnapshot {
  cancelled: boolean;
  referenceWorkspaceIds: string[];
  continuationState?: PlanningContinuationState;
  continuationDecision?: (proceed: boolean) => void;
  agentProfile?: AgentRuntimeProfile;
}

export class PlanManager {
  private active?: InternalPlan;
  constructor(
    private readonly agent: PlanningAgent, private readonly store: PlanStore, private readonly tools: WorkspaceTools,
    private readonly activity: ActivityHub, private readonly lock: WorkspaceMutationLock, private readonly settings: WorkspaceSettingsService,
    private readonly grants: WorkspaceReferenceGrants, private readonly registry: WorkspaceRegistry,
  ) {}

  create(request: PlanRequest, agentProfile?: AgentRuntimeProfile) {
    if (!request.objective?.trim()) throw statusError('Planning objective is required.', 400);
    if (this.active) throw statusError('A planning run is already active.', 409);
    const now = new Date().toISOString(); const referenceWorkspaceIds = this.grants.resolve(request.referenceGrantId);
    const plan: InternalPlan = {
      kind: 'planning', id: randomUUID(), workspaceId: this.registry.active().id, status: 'queued',
      request: normalizeRequest(request), createdAt: now, updatedAt: now, cancelled: false, referenceWorkspaceIds, agentProfile,
    };
    this.active = plan; this.activity.update(publicPlan(plan)); void this.activity.emit(plan.id, 'status', 'queue', 'Planning task queued'); void this.run(plan);
    return publicPlan(plan);
  }

  getActive() { return this.active ? publicPlan(this.active) : undefined; }
  get(id: string) { const run = this.activity.getTask(id); return run?.kind === 'planning' ? run : undefined; }
  cancel(id: string) { if (!this.active || this.active.id !== id) return false; this.active.cancelled = true; this.active.continuationDecision?.(false); return true; }
  continue(id: string, proceed: boolean) {
    const plan = this.active;
    if (!plan || plan.id !== id || plan.status !== 'awaiting_continuation' || !plan.continuationDecision) return false;
    plan.continuationDecision(proceed); plan.continuationDecision = undefined; return true;
  }

  private async run(plan: InternalPlan) {
    try {
      await (async () => {
        this.setStatus(plan, 'planning'); await this.activity.emit(plan.id, 'status', 'planning', `Planning: ${plan.request.objective}`);
        const context = await this.tools.buildTaskContext(plan.request);
        await this.activity.emit(plan.id, 'status', 'context', `Preloaded ${context.fileCount} source paths and ${context.matchCount} ranked match(es)${context.truncated ? ' within the 24 KB cap' : ''}`);
        const settings = this.settings.get(); const referenceNames = plan.referenceWorkspaceIds.map((id) => this.registry.get(id).name);
        const prompt = promptFor(plan.request, settings, context.text, referenceNames);
        while (true) {
          const outcome = await this.agent.perform(plan.id, prompt, () => plan.cancelled, plan.referenceWorkspaceIds, plan.continuationState, plan.agentProfile);
          if (plan.cancelled) throw new Error('Planning cancelled');
          if (outcome.status === 'completed') {
            const record = await this.store.saveGenerated(plan.id, plan.request, plan.referenceWorkspaceIds, outcome.content);
            const result: PlanResult = { planId: plan.id, status: 'completed', summary: `Plan ready for review: ${record.path}`, path: record.path, hash: record.hash };
            plan.result = result; plan.continuation = undefined; plan.continuationState = undefined; this.setStatus(plan, 'completed'); await this.activity.emit(plan.id, 'complete', 'complete', result.summary, result); break;
          }
          plan.continuationState = outcome.continuation;
          plan.continuation = { reason: outcome.reason, interactionCount: outcome.continuation.interactionCount, segment: outcome.continuation.segment, message: outcome.message };
          const decision = new Promise<boolean>((resolve) => { plan.continuationDecision = resolve; });
          this.setStatus(plan, 'awaiting_continuation');
          await this.activity.emit(plan.id, 'continuation_required', 'planning', `${outcome.message} Continue this same planning run?`, plan.continuation);
          const proceed = await decision; plan.continuationDecision = undefined;
          if (!proceed || plan.cancelled) { plan.cancelled = true; throw new Error('Planning cancelled'); }
          plan.continuation = undefined; this.setStatus(plan, 'planning');
          await this.activity.emit(plan.id, 'status', 'planning', `Resuming planning segment ${outcome.continuation.segment + 1} with the preserved interaction context`);
        }
      })();
    } catch (error) {
      const cancelled = plan.cancelled || (error as Error).message === 'Planning cancelled';
      const result: PlanResult = { planId: plan.id, status: cancelled ? 'cancelled' : 'failed', summary: cancelled ? 'Planning cancelled.' : (error as Error).message };
      plan.result = result; this.setStatus(plan, result.status); await this.activity.emit(plan.id, cancelled ? 'complete' : 'error', result.status, result.summary, result);
    } finally { if (this.active?.id === plan.id) this.active = undefined; }
  }

  private setStatus(plan: InternalPlan, status: PlanningStatus) { plan.status = status; plan.updatedAt = new Date().toISOString(); this.activity.update(publicPlan(plan)); }
}

function normalizeRequest(request: PlanRequest): PlanRequest {
  return {
    objective: request.objective.trim(), successCriteria: request.successCriteria?.slice(0, 30) || [], selectedElement: request.selectedElement,
    selectedFiles: request.selectedFiles?.slice(0, 50), includeCanvasImage: request.includeCanvasImage, referenceGrantId: request.referenceGrantId,
  };
}

function promptFor(request: PlanRequest, settings: WorkspaceSettings, context: string, referenceNames: string[]) {
  const selection = request.selectedElement ? `\nSelected rendered context:\n${JSON.stringify(request.selectedElement, null, 2)}` : '';
  const files = request.selectedFiles?.length ? `\nSelected workspace files:\n${request.selectedFiles.map((path) => `- ${path}`).join('\n')}` : '';
  const references = referenceNames.length ? `\nAuthorized read-only source workspaces: ${referenceNames.join(', ')}` : '';
  return `${context ? `Preloaded project context:\n\n${context}\n\n--- END PRELOADED CONTEXT ---\n\n` : ''}Create a decision-complete implementation plan for this ${settings.mode.toUpperCase()} workspace request:\n\n${request.objective}${request.successCriteria?.length ? `\n\nSuccess criteria:\n${request.successCriteria.map((item) => `- ${item}`).join('\n')}` : ''}${selection}${files}${references}\n\nInspect the current project with read-only tools before finalizing the plan. Preserve existing conventions and make every numbered implementation step suitable for a coding-agent todo.`;
}

function publicPlan(plan: InternalPlan): PlanningRunSnapshot { const { cancelled: _cancelled, referenceWorkspaceIds: _references, continuationState: _state, continuationDecision: _decision, agentProfile: _profile, ...value } = plan; return value; }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
