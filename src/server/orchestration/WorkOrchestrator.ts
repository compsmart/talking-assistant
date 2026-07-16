import type { WebSocket } from 'ws';
import type { ActivityHub } from '../activity.js';
import type { PlanManager } from '../agent/PlanManager.js';
import type { PlanStore } from '../agent/PlanStore.js';
import type { TaskManager } from '../agent/TaskManager.js';
import type { WorkspaceReferenceGrants } from '../workspace/WorkspaceReferenceGrants.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { PlanResult, TaskResult, WorkCommandResult, WorkEvent, WorkItemSnapshot, WorkRequest, WorkUpdateMode } from '../../shared/protocol.js';
import { fingerprintFor, WorkStore } from './WorkStore.js';
import type { ConcurrentCodingRunner } from './ConcurrentCodingRunner.js';
import type { AssistantCoordinator } from './AssistantCoordinator.js';
import { randomUUID } from 'node:crypto';

interface ActiveRun { kind: 'planning' | 'coding' | 'concurrent'; runId: string }

export class WorkOrchestrator {
  private active = new Map<string, ActiveRun>();
  private draining = false;
  private sockets = new Set<{ socket: WebSocket; workspaceId: string }>();
  private continuedSegments = new Set<string>();
  private deferredUntil = new Map<string, number>();

  constructor(
    private readonly store: WorkStore, private readonly tasks: TaskManager, private readonly plans: PlanManager,
    private readonly planStore: PlanStore, private readonly activity: ActivityHub, private readonly grants: WorkspaceReferenceGrants,
    private readonly registry: WorkspaceRegistry, private readonly settings: WorkspaceSettingsService, private readonly runner: ConcurrentCodingRunner, private readonly assistant: AssistantCoordinator,
  ) {
    this.store.subscribe((event) => this.broadcast(event));
    this.activity.subscribeEvents((event) => {
      const match = [...this.active].find(([, active]) => active.runId === event.taskId); if (!match) return;
      const work = this.store.get(match[0]); if (work) this.store.emit(work.workspaceId, work.id, { type: 'activity_event', workId: work.id, attemptId: event.taskId, event });
    });
  }

  initialize() { this.store.recover(); void this.drain(); }

  submit(input: WorkRequest): WorkCommandResult {
    const workspaceId = this.registry.active().id;
    const submitted = input.clientRequestId ? this.store.operation(`submit:${workspaceId}:${input.clientRequestId}`, input, () => this.store.submit(workspaceId, input)) : this.store.submit(workspaceId, input);
    if (!submitted.duplicate) { this.notice(submitted.work, 'accepted', 'I queued that work.'); void this.drain(); }
    else this.notice(submitted.work, 'duplicate', 'That work is already in progress.');
    return { disposition: submitted.duplicate ? 'duplicate' : 'accepted', work: submitted.work, message: submitted.duplicate ? 'This task is already in progress.' : 'Work accepted and queued.' };
  }

  list(workspaceId = this.registry.active().id) { return this.store.list(workspaceId); }
  get(id: string) { return this.store.get(id); }

  update(id: string, change: { objective?: string; successCriteria?: string[]; text?: string }, mode: WorkUpdateMode, expectedRevision?: number): WorkCommandResult {
    const current = this.required(id); if (expectedRevision && current.specRevision !== expectedRevision) throw statusError('The task changed; refresh its status before updating it.', 409);
    if (isTerminal(current)) throw statusError('Completed work cannot be updated.', 409);
    const active = this.active.get(id); if (active) this.cancelLegacy(active);
    const work = this.store.update(id, (item) => {
      const text = String(change.objective || change.text || '').trim(); const criteria = Array.isArray(change.successCriteria) ? change.successCriteria.map(String) : [];
      const objective = mode === 'replace' && text ? text : text ? `${item.request.objective}\n\n${mode === 'correct' ? 'Correction' : 'Additional requirement'}: ${text}` : item.request.objective;
      const request = { ...item.request, objective, successCriteria: [...(mode === 'replace' ? [] : item.request.successCriteria || []), ...criteria] };
      return { ...item, request, specRevision: item.specRevision + 1, fingerprint: fingerprintFor(item.workspaceId, item.strategy, request), status: 'queued', startedAt: undefined, completedAt: undefined, result: undefined, subtasks: [], attempts: item.attempts.map((attempt) => ['queued', 'running', 'paused', 'cancelling'].includes(attempt.status) ? { ...attempt, status: 'superseded', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt) };
    });
    this.active.delete(id); this.deferredUntil.delete(id); this.notice(work, 'updated', 'I updated the running task with the new direction.'); void this.drain();
    return { disposition: 'updated', work, message: 'Work updated.' };
  }

  cancel(id: string): WorkCommandResult {
    const current = this.required(id); if (isTerminal(current)) throw statusError('That work has already finished.', 409);
    this.deferredUntil.delete(id);
    const active = this.active.get(id); if (active) this.cancelLegacy(active);
    const work = this.store.update(id, (item) => ({ ...item, status: active ? 'cancelling' : 'cancelled', completedAt: active ? undefined : new Date().toISOString(), result: active ? undefined : { status: 'cancelled', summary: 'Work cancelled before it started.', changedFiles: [], checks: [] } }));
    if (!active) this.notice(work, 'cancelled', 'I cancelled that task.');
    return { disposition: 'cancelling', work, message: active ? 'Cancellation requested.' : 'Work cancelled.' };
  }

  async approvePlan(id: string, path: string, hash?: string): Promise<WorkCommandResult> {
    const current = this.required(id); if (current.status !== 'awaiting_approval') throw statusError('That work is not waiting for plan approval.', 409);
    const record = await this.planStore.getByPath(path, current.workspaceId); const plan = await this.planStore.read(path, current.workspaceId);
    if (hash && hash !== plan.hash) throw statusError('The plan changed after review. Reload it before approval.', 409);
    if (record) await this.planStore.markExecuting(record, plan.hash);
    const work = this.store.update(id, (item) => ({ ...item, strategy: 'direct', status: 'queued', plan: { path, hash: plan.hash }, request: { ...(record?.request || item.request), referenceGrantId: undefined, approvedPlan: { id: record?.id || item.id, path, hash: plan.hash } } }));
    void this.drain(); return { disposition: 'approved', work, message: 'Plan approved and queued for implementation.' };
  }

  answer(id: string, questionId: string, answer: string): WorkCommandResult {
    const active = this.active.get(id); const proceed = !/^(no|stop|cancel|false)$/i.test(answer.trim());
    const work = this.store.update(id, (item) => ({ ...item, status: active?.kind === 'planning' ? 'planning' : 'queued', request: questionId.startsWith('agent-selection:') ? { ...item.request, preferredAgentId: answer.trim() } : item.request, questions: item.questions.map((question) => question.id === questionId ? { ...question, answer: answer.trim(), answeredAt: new Date().toISOString() } : question) }));
    this.deferredUntil.delete(id); if (active?.kind === 'planning') this.plans.continue(active.runId, proceed); else void this.drain(); return { disposition: 'answered', work, message: 'Answer recorded.' };
  }

  attach(socket: WebSocket, workspaceId: string) {
    const entry = { socket, workspaceId }; this.sockets.add(entry);
    const history = this.store.events(workspaceId); socket.send(JSON.stringify({ type: 'work_initial', works: this.store.list(workspaceId), events: history.map((item) => item.event).filter((event) => event.type === 'activity_event'), cursor: history.at(-1)?.seq || 0 }));
    socket.on('close', () => this.sockets.delete(entry));
  }

  kick() { void this.drain(); }

  private async drain() {
    if (this.draining) return; this.draining = true;
    try {
      while (this.active.size < this.settings.get().codingAgent.maxParallelAgents) {
        const time = Date.now(); const work = this.store.list(this.registry.active().id, false).find((item) => item.status === 'queued' && (this.deferredUntil.get(item.id) || 0) <= time && (!isPlanningWork(item) || !this.plans.getActive())); if (!work) break;
        await this.launch(work).catch((error) => this.fail(work.id, (error as Error).message));
      }
    } finally { this.draining = false; }
  }

  private async launch(work: WorkItemSnapshot) {
    this.store.update(work.id, (item) => ({ ...item, status: 'coordinating' }));
    const decision = work.dispatch
      ? { action: work.dispatch.kind, writeScope: work.dispatch.kind === 'code' ? ['**/*'] : work.dispatch.kind === 'media' ? ['assets/generated/**', 'assets/processed/**'] : [], reason: work.dispatch.reason } as const
      : await this.assistant.coordinate(work, this.store.list(work.workspaceId, false));
    if (decision.action === 'duplicate' && decision.duplicateOf) {
      const duplicate = this.store.update(work.id, (item) => ({ ...item, status: 'superseded', duplicateOf: decision.duplicateOf, completedAt: new Date().toISOString() }));
      this.notice(duplicate, 'duplicate', `I already have that in progress as task ${decision.duplicateOf}.`); return;
    }
    if (decision.action === 'plan' && this.plans.getActive()) { this.store.update(work.id, (item) => ({ ...item, strategy: 'plan_first', status: 'queued' })); return; }
    const planning = decision.action === 'plan';
    const executionRole = planning ? 'planner' : decision.action === 'media' ? 'media' : work.attempts.some((attempt) => attempt.status === 'failed' && ['coder', 'resolver'].includes(attempt.role)) ? 'resolver' : 'coder';
    const selection = await this.assistant.selectAgent(work, executionRole, this.store.list(work.workspaceId));
    if (selection.status !== 'selected') {
      if (selection.status === 'no_eligible' && /concurrency limit/i.test(selection.reason)) {
        this.store.update(work.id, (item) => ({ ...item, status: 'queued' })); this.deferredUntil.set(work.id, Date.now() + 1_000);
        setTimeout(() => void this.drain(), 1_050).unref?.(); return;
      }
      const questionId = `agent-selection:${work.specRevision}`;
      const prompt = selection.status === 'tie' ? `${selection.reason} Choose the agent for this task.` : `${selection.reason} Update the agent configuration, then choose an eligible agent.`;
      const waiting = this.store.update(work.id, (item) => ({ ...item, status: 'needs_input', questions: item.questions.some((question) => question.id === questionId) ? item.questions : [...item.questions, { id: questionId, prompt, ...(selection.candidates.length ? { options: selection.candidates.map((candidate) => candidate.id) } : {}), askedAt: new Date().toISOString() }] }));
      this.notice(waiting, 'needs_input', prompt); return;
    }
    const grant = work.request.referenceGrantId ? this.grants.resolve(work.request.referenceGrantId) : [];
    if (planning && !work.plan) {
      const run = this.plans.create(work.request, selection.agent); this.active.set(work.id, { kind: 'planning', runId: run.id });
      this.store.update(work.id, (item) => ({ ...item, status: 'planning', startedAt: item.startedAt || new Date().toISOString(), subtasks: [{ id: `${item.id}:plan`, workId: item.id, role: 'planner', objective: item.request.objective, status: 'running', dependencies: [], writeScope: [], attemptIds: [run.id] }], attempts: [{ id: run.id, workId: item.id, subtaskId: `${item.id}:plan`, role: 'planner', status: 'running', specRevision: item.specRevision, agentId: selection.agent.id, agentName: selection.agent.name, profileRevision: selection.agent.revision, routingReason: selection.reason, changedFiles: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
      void this.watch(work.id, 'planning', run.id); return;
    }
    let approvedPlanContent: string | undefined; let referenceWorkspaceIds = grant;
    if (work.plan) { const plan = await this.planStore.read(work.plan.path, work.workspaceId); approvedPlanContent = plan.content; const record = await this.planStore.getByPath(work.plan.path, work.workspaceId); referenceWorkspaceIds = record?.referenceWorkspaceIds || []; }
    const attemptId = randomUUID(); this.active.set(work.id, { kind: 'concurrent', runId: attemptId });
    const subtaskId = `${work.id}:${executionRole}`;
    const running = this.store.update(work.id, (item) => ({ ...item, status: 'running', startedAt: item.startedAt || new Date().toISOString(), subtasks: [{ id: subtaskId, workId: item.id, role: executionRole, objective: item.request.objective, status: 'running', dependencies: [], writeScope: decision.writeScope, attemptIds: [attemptId] }], attempts: [...item.attempts, { id: attemptId, workId: item.id, subtaskId, role: executionRole, status: 'running', specRevision: item.specRevision, agentId: selection.agent.id, agentName: selection.agent.name, profileRevision: selection.agent.revision, routingReason: selection.reason, changedFiles: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }));
    void this.runner.execute(running, attemptId, referenceWorkspaceIds, approvedPlanContent, selection.agent).then((result) => this.finishCoding(work.id, attemptId, result)).finally(() => { if (this.active.get(work.id)?.runId === attemptId) this.active.delete(work.id); void this.drain(); });
  }

  private async watch(workId: string, kind: 'planning' | 'coding', runId: string) {
    try {
      while (true) {
        await delay(150); const run = kind === 'planning' ? this.plans.get(runId) : this.tasks.get(runId);
        if (kind === 'planning' && run?.kind === 'planning' && run.status === 'awaiting_continuation' && run.continuation) {
          const key = `${runId}:${run.continuation.segment}`;
          if (!this.continuedSegments.has(key)) {
            this.continuedSegments.add(key);
            if (run.continuation.segment < 3) { this.plans.continue(runId, true); await this.activity.emit(runId, 'status', 'coordination', `Automatically continuing planning segment ${run.continuation.segment + 1} within the orchestration budget`); }
            else {
              const questionId = `planning-continuation:${run.continuation.segment}`;
              const work = this.store.update(workId, (item) => ({ ...item, status: 'needs_input', questions: item.questions.some((question) => question.id === questionId) ? item.questions : [...item.questions, { id: questionId, prompt: 'Planning reached its automatic continuation budget. Continue this planning run?', options: ['Continue', 'Stop'], askedAt: new Date().toISOString() }] }));
              this.notice(work, 'needs_input', 'I need your confirmation to continue the extended planning run.');
            }
          }
        }
        if (!run?.result) continue;
        const current = this.store.get(workId); if (!current || current.attempts.find((item) => item.id === runId)?.status === 'superseded') break;
        if (kind === 'planning') {
          const result = run.result as PlanResult;
          if (result.status === 'completed' && result.path && result.hash) {
            const status = current.strategy === 'plan_only' ? 'completed' : 'awaiting_approval';
            const work = this.store.update(workId, (item) => ({ ...item, status, completedAt: status === 'completed' ? new Date().toISOString() : undefined, plan: { path: result.path!, hash: result.hash! }, attempts: item.attempts.map((attempt) => attempt.id === runId ? { ...attempt, status: 'succeeded', summary: result.summary, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt), subtasks: item.subtasks.map((subtask) => subtask.attemptIds.includes(runId) ? { ...subtask, status: 'completed' } : subtask), result: status === 'completed' ? { status: 'completed', summary: result.summary, changedFiles: [], checks: [] } : undefined }));
            this.notice(work, status === 'completed' ? 'completed' : 'updated', status === 'completed' ? `I completed the plan at ${result.path}.` : `I prepared ${result.path} for review.`);
          } else this.finishFailure(workId, runId, result.summary, result.status === 'cancelled');
        } else {
          const result = run.result as TaskResult;
          if (result.status === 'completed') {
            const work = this.store.update(workId, (item) => ({ ...item, status: 'completed', completedAt: new Date().toISOString(), attempts: item.attempts.map((attempt) => attempt.id === runId ? { ...attempt, status: 'succeeded', summary: result.summary, changedFiles: result.changedFiles, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt), subtasks: item.subtasks.map((subtask) => subtask.attemptIds.includes(runId) ? { ...subtask, status: 'completed' } : subtask), result: { status: 'completed', summary: result.summary, changedFiles: result.changedFiles, checks: result.checks, previewVersion: result.previewVersion, previewUrl: result.previewUrl } }));
            this.notice(work, 'completed', `I finished: ${result.summary}`);
          } else this.finishFailure(workId, runId, result.summary, result.status === 'cancelled');
        }
        break;
      }
    } finally { if (this.active.get(workId)?.runId === runId) this.active.delete(workId); void this.drain(); }
  }

  private finishCoding(workId: string, runId: string, result: TaskResult & { commit?: string }) {
    const current = this.store.get(workId); if (!current || current.attempts.find((item) => item.id === runId)?.status === 'superseded') return;
    if (result.status === 'completed') {
      const work = this.store.update(workId, (item) => ({ ...item, status: 'completed', completedAt: new Date().toISOString(), attempts: item.attempts.map((attempt) => attempt.id === runId ? { ...attempt, status: 'succeeded', summary: result.summary, changedFiles: result.changedFiles, headCommit: result.commit, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt), subtasks: item.subtasks.map((subtask) => subtask.attemptIds.includes(runId) ? { ...subtask, status: 'completed' } : subtask), result: { status: 'completed', summary: result.summary, changedFiles: result.changedFiles, checks: result.checks, previewVersion: result.previewVersion, previewUrl: result.previewUrl, commit: result.commit } }));
      this.notice(work, 'completed', `I finished: ${result.summary}`);
    } else if (result.status !== 'cancelled' && retryable(result.summary) && current.attempts.filter((attempt) => ['coder', 'resolver'].includes(attempt.role) && attempt.status === 'failed').length < 2) {
      const work = this.store.update(workId, (item) => ({ ...item, status: 'queued', attempts: item.attempts.map((attempt) => attempt.id === runId ? { ...attempt, status: 'failed', error: result.summary, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt), subtasks: item.subtasks.map((subtask) => subtask.attemptIds.includes(runId) ? { ...subtask, status: 'ready' } : subtask) }));
      this.notice(work, 'updated', `I encountered an integration issue and am retrying against the latest workspace state: ${result.summary}`);
    } else this.finishFailure(workId, runId, result.summary, result.status === 'cancelled');
  }

  private finishFailure(workId: string, runId: string, summary: string, cancelled: boolean) {
    const work = this.store.update(workId, (item) => ({ ...item, status: cancelled ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), attempts: item.attempts.map((attempt) => attempt.id === runId ? { ...attempt, status: cancelled ? 'cancelled' : 'failed', error: summary, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : attempt), result: { status: cancelled ? 'cancelled' : 'failed', summary, changedFiles: [], checks: [] } }));
    this.notice(work, cancelled ? 'cancelled' : 'failed', cancelled ? 'I cancelled that task.' : `I could not complete that task: ${summary}`);
  }
  private fail(id: string, message: string) { if (this.store.get(id)) this.finishFailure(id, '', message, false); }
  private required(id: string) { const work = this.store.get(id); if (!work || work.workspaceId !== this.registry.active().id) throw statusError('Work item not found.', 404); return work; }
  private cancelLegacy(active: ActiveRun) { if (active.kind === 'planning') this.plans.cancel(active.runId); else if (active.kind === 'concurrent') this.runner.cancel(active.runId); else this.tasks.cancel(active.runId); }
  private notice(work: WorkItemSnapshot, kind: Extract<WorkEvent, { type: 'work_notice' }>['kind'], message: string) { this.store.emit(work.workspaceId, work.id, { type: 'work_notice', workId: work.id, kind, message, at: new Date().toISOString() }); }
  private broadcast(event: WorkEvent) { const message = JSON.stringify(event); for (const entry of this.sockets) if (entry.workspaceId === ('work' in event ? event.work.workspaceId : this.store.get(event.workId)?.workspaceId) && entry.socket.readyState === entry.socket.OPEN) entry.socket.send(message); }
}

function isTerminal(work: WorkItemSnapshot) { return ['completed', 'failed', 'cancelled', 'superseded'].includes(work.status); }
function shouldPlan(objective: string) { return /\b(architect|migration|migrate|redesign|refactor|debug|unknown|broad|multiple files?|dependency|orchestrat|concurren)\b/i.test(objective); }
function isPlanningWork(work: WorkItemSnapshot) { return !work.plan && (work.strategy === 'plan_first' || work.strategy === 'plan_only' || (work.strategy === 'auto' && shouldPlan(work.request.objective))); }
function retryable(message: string) { return /conflict|main advanced|validation failed|timed? ?out|interrupted|temporar/i.test(message); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
