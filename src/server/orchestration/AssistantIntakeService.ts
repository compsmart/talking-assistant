import { createHash } from 'node:crypto';
import type { AssistantIntakeRequest, AssistantIntakeResult, WorkDispatchKind, WorkItemSnapshot } from '../../shared/protocol.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { AssistantCoordinator, AssistantManagementDecision } from './AssistantCoordinator.js';
import { AssistantDirectExecutor } from './AssistantDirectExecutor.js';
import type { WorkOrchestrator } from './WorkOrchestrator.js';
import type { WorkStore } from './WorkStore.js';

export class AssistantIntakeService {
  private readonly pending = new Map<string, { signature: string; promise: Promise<AssistantIntakeResult> }>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: WorkStore,
    private readonly orchestrator: WorkOrchestrator,
    private readonly coordinator: AssistantCoordinator,
    private readonly direct: AssistantDirectExecutor,
    private readonly registry: WorkspaceRegistry,
    private readonly settings: WorkspaceSettingsService,
  ) {}

  handle(input: AssistantIntakeRequest): Promise<AssistantIntakeResult> {
    const request = normalizeRequest(input); const workspaceId = this.registry.active().id;
    const signatureValue = authoritativeSignature(request); const signature = digest(signatureValue); const key = `${workspaceId}:${request.turnId}`;
    const saved = this.store.assistantResult<AssistantIntakeResult>(workspaceId, request.turnId, signatureValue); if (saved) return Promise.resolve(saved);
    const existing = this.pending.get(key);
    if (existing) return existing.signature === signature ? existing.promise : Promise.reject(statusError('Assistant turn ID was replayed with different user input.', 409));
    const prior = this.chains.get(workspaceId) || Promise.resolve();
    const promise = prior.then(() => this.process(workspaceId, request)).then((result) => this.store.saveAssistantResult(workspaceId, request.turnId, signatureValue, result));
    this.chains.set(workspaceId, promise.then(() => undefined, () => undefined)); this.pending.set(key, { signature, promise });
    void promise.finally(() => this.pending.delete(key)).catch(() => undefined);
    return promise;
  }

  private async process(workspaceId: string, request: AssistantIntakeRequest): Promise<AssistantIntakeResult> {
    const history = this.store.list(workspaceId); const decision = await this.coordinator.manage(request, history);
    switch (decision.action) {
      case 'ignore': return { disposition: 'ignored', message: decision.message };
      case 'reject': return { disposition: 'rejected', message: decision.message };
      case 'clarify': return { disposition: 'needs_clarification', message: decision.message };
      case 'status': return statusResult(this.store.list(workspaceId), decision.message);
      case 'reuse': {
        const work = requiredTarget(decision, history); return { disposition: 'reused', message: 'I already have that task in progress.', work, workIds: [work.id] };
      }
      case 'update': {
        const work = requiredTarget(decision, history); const result = this.orchestrator.update(work.id, { text: decision.objective || request.userText, successCriteria: decision.successCriteria }, decision.updateMode || 'append', work.specRevision);
        return { disposition: 'updated', message: 'I updated the existing task with that direction.', work: result.work, workIds: [result.work.id] };
      }
      case 'cancel': {
        const work = requiredTarget(decision, history); const result = this.orchestrator.cancel(work.id);
        return { disposition: 'cancelled', message: result.message, work: result.work, workIds: [result.work.id] };
      }
      case 'answer': {
        const work = requiredTarget(decision, history); const open = work.questions.filter((question) => !question.answeredAt);
        const question = decision.questionId ? open.find((item) => item.id === decision.questionId) : open.length === 1 ? open[0] : undefined;
        if (!question) return { disposition: 'needs_clarification', message: 'I need to know which open task question you are answering.' };
        const result = this.orchestrator.answer(work.id, question.id, request.userText);
        return { disposition: 'answered', message: 'I applied that answer to the waiting task.', work: result.work, workIds: [result.work.id] };
      }
      case 'approve': {
        const work = requiredTarget(decision, history);
        if (!work.plan || work.status !== 'awaiting_approval') return { disposition: 'needs_clarification', message: 'That task does not have a plan waiting for approval.' };
        const result = await this.orchestrator.approvePlan(work.id, work.plan.path, work.plan.hash);
        return { disposition: 'approved', message: 'I approved the reviewed plan and queued its implementation.', work: result.work, workIds: [result.work.id] };
      }
      case 'create': return this.create(request, decision);
    }
  }

  private async create(request: AssistantIntakeRequest, decision: AssistantManagementDecision): Promise<AssistantIntakeResult> {
    const objective = decision.objective || request.userText;
    if (decision.execution === 'fast' && this.settings.get().liveAgent.directFileEdits) {
      try {
        const edited = await this.direct.execute(request, objective);
        return { disposition: 'fast_edit', message: edited.value.summary || 'I made that focused change.', changedFiles: edited.changedFiles, previewVersion: edited.version };
      } catch { /* rollback is complete; use durable work below */ }
    }
    const dispatch: WorkDispatchKind = decision.execution === 'media' ? 'media' : decision.execution === 'plan' ? 'plan' : 'code';
    const planOnly = dispatch === 'plan' && /\b(?:plan only|just (?:make|create|write) (?:a )?plan|do not implement|without implementing)\b/i.test(request.userText);
    const submitted = this.orchestrator.submit({
      objective, successCriteria: decision.successCriteria || [], selectedElement: request.selectedElement, selectedFiles: request.selectedFiles,
      referenceGrantId: request.referenceGrantId, clientRequestId: `assistant:${request.turnId}`,
      strategy: dispatch === 'plan' ? (planOnly ? 'plan_only' : 'plan_first') : 'auto', dispatch: { kind: dispatch, reason: 'Selected by the authoritative Assistant intake.' },
    });
    return { disposition: submitted.disposition === 'duplicate' ? 'reused' : 'created', message: submitted.disposition === 'duplicate' ? 'I already have that task in progress.' : 'I queued that work.', work: submitted.work, workIds: [submitted.work.id] };
  }
}

function normalizeRequest(input: AssistantIntakeRequest): AssistantIntakeRequest {
  const turnId = String(input?.turnId || '').trim(); const userText = String(input?.userText || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(turnId)) throw statusError('A valid Assistant turn ID is required.', 400);
  if (!userText || userText.length > 12_000) throw statusError('Assistant user text must contain 1 to 12,000 characters.', 400);
  return { turnId, userText, liveNote: input.liveNote ? String(input.liveNote).trim().slice(0, 2000) : undefined, selectedElement: input.selectedElement, selectedFiles: Array.isArray(input.selectedFiles) ? [...new Set(input.selectedFiles.map(String))].slice(0, 50) : [], referenceGrantId: input.referenceGrantId, workspaceVersion: input.workspaceVersion };
}

function authoritativeSignature(request: AssistantIntakeRequest) {
  return { userText: request.userText, selectedElement: request.selectedElement?.identifier, selectedFiles: request.selectedFiles, referenceGrantId: request.referenceGrantId, workspaceVersion: request.workspaceVersion };
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function requiredTarget(decision: AssistantManagementDecision, history: WorkItemSnapshot[]) {
  const work = history.find((item) => item.id === decision.targetId); if (!work) throw statusError('The Assistant selected an unknown task.', 409); return work;
}
function statusResult(history: WorkItemSnapshot[], fallback: string): AssistantIntakeResult {
  const active = history.filter((item) => !['completed', 'failed', 'cancelled', 'superseded'].includes(item.status));
  const message = active.length ? `I have ${active.length} active task${active.length === 1 ? '' : 's'}: ${active.slice(0, 4).map((item) => `${item.request.objective} (${item.status.replaceAll('_', ' ')})`).join('; ')}.` : fallback || 'I do not have any active tasks.';
  return { disposition: 'reported', message, workIds: active.map((item) => item.id) };
}
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
