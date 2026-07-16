import { randomUUID } from 'node:crypto';
import type { ActivityHub } from '../activity.js';
import type { CheckResult, TaskRequest, TaskResult, TaskSnapshot, TaskStatus, TaskTodo, WorkspaceSettings } from '../../shared/protocol.js';
import type { WorkspaceManager } from '../workspace/WorkspaceManager.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';
import type { CodingAgent } from './CodingAgent.js';
import type { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import type { WorkspaceSettingsService } from '../workspace/WorkspaceSettingsService.js';
import type { WorkspaceReferenceGrants } from '../workspace/WorkspaceReferenceGrants.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import type { PlanStore } from './PlanStore.js';

interface InternalTask extends TaskSnapshot { cancelled: boolean; referenceWorkspaceIds: string[]; approvedPlanContent?: string }
interface CreateOptions { referenceWorkspaceIds?: string[]; approvedPlanContent?: string }

export class TaskManager {
  private queue: InternalTask[] = [];
  private working = false;
  private active?: InternalTask;
  constructor(private readonly agent: CodingAgent, private readonly tools: WorkspaceTools, private readonly workspace: WorkspaceManager, private readonly activity: ActivityHub, private readonly lock: WorkspaceMutationLock, private readonly settings: WorkspaceSettingsService, private readonly grants: WorkspaceReferenceGrants, private readonly registry: WorkspaceRegistry, private readonly plans: PlanStore) {}

  create(request: TaskRequest, options: CreateOptions = {}) {
    if (!request.objective?.trim()) throw new Error('Task objective is required.');
    if (this.working || this.queue.length || this.lock.busy) {
      const error = new Error(`The coding agent is already working${this.active ? ` on: ${this.active.request.objective}` : ''}. The new request was not queued.`) as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const referenceWorkspaceIds = options.referenceWorkspaceIds ?? this.grants.resolve(request.referenceGrantId);
    const task: InternalTask = { kind: 'coding', id: randomUUID(), workspaceId: this.registry.active().id, status: 'queued', request: { objective: request.objective.trim(), successCriteria: request.successCriteria || [], selectedElement: request.selectedElement, selectedFiles: request.selectedFiles?.slice(0, 50), includeCanvasImage: request.includeCanvasImage, approvedPlan: options.approvedPlanContent ? request.approvedPlan : undefined }, createdAt: now, updatedAt: now, todos: [], cancelled: false, referenceWorkspaceIds, approvedPlanContent: options.approvedPlanContent };
    this.queue.push(task); this.activity.update(publicTask(task)); void this.activity.emit(task.id, 'status', 'queue', 'Task queued for the single coding agent'); void this.drain();
    return publicTask(task);
  }

  get(id: string) { const task = this.activity.getTask(id); return task?.kind === 'coding' ? task : undefined; }
  getActive() { const task = this.active || this.queue[0]; return task ? publicTask(task) : undefined; }
  cancel(id: string) { const task = this.queue.find((item) => item.id === id) || (this.active?.id === id ? this.active : undefined); if (!task) return false; task.cancelled = true; return true; }

  private async drain() {
    if (this.working) return; this.working = true;
    while (this.queue.length) {
      const task = this.queue.shift()!;
      this.active = task;
      if (task.cancelled) { await this.finishCancelled(task); continue; }
      await this.lock.run('the coding agent', () => this.execute(task));
      this.active = undefined;
    }
    this.active = undefined; this.working = false;
  }

  private async execute(task: InternalTask) {
    const taskStarted = Date.now(); const phases: Record<string, number> = {}; let phaseStarted = taskStarted;
    const markPhase = (name: string) => { phases[name] = (phases[name] || 0) + Date.now() - phaseStarted; phaseStarted = Date.now(); };
    const before = await this.tools.manifest(); const dependencyBefore = await this.tools.dependencyFingerprint(); const settings = this.settings.get(); let retries = 0; let summary = ''; let checks: CheckResult[] = [];
    const todo = new TodoController(task, this.activity, () => this.activity.update(publicTask(task)));
    const aggregate = { interactionCount: 0, toolCount: 0, callsByTool: {} as Record<string, number>, firstMutationMs: undefined as number | undefined, tokens: { input: 0, output: 0, thought: 0, cached: 0 } };
    const mergePerformance = (value: Omit<typeof aggregate, 'firstMutationMs'> & { firstMutationMs?: number; modelMs: number; toolMs: number }, offset = 0) => { aggregate.interactionCount += value.interactionCount; aggregate.toolCount += value.toolCount; if (aggregate.firstMutationMs === undefined && value.firstMutationMs !== undefined) aggregate.firstMutationMs = offset + value.firstMutationMs; for (const [name, count] of Object.entries(value.callsByTool)) aggregate.callsByTool[name] = (aggregate.callsByTool[name] || 0) + count; for (const key of Object.keys(aggregate.tokens) as Array<keyof typeof aggregate.tokens>) aggregate.tokens[key] += value.tokens[key]; phases.model = (phases.model || 0) + value.modelMs; phases.tool = (phases.tool || 0) + value.toolMs; };
    try {
      this.setStatus(task, 'running'); await this.activity.emit(task.id, 'status', 'coding', `Implementing: ${task.request.objective}`);
      this.agent.beginTask();
      const taskContext = await this.tools.buildTaskContext(task.request);
      await this.activity.emit(task.id, 'status', 'context', `Preloaded ${taskContext.fileCount} source paths and ${taskContext.matchCount} ranked match(es)${taskContext.truncated ? ' within the 24 KB cap' : ''}`);
      const canvasImage = task.request.includeCanvasImage ? await this.workspace.captureCurrentCanvas().catch(async (error) => {
        await this.activity.emit(task.id, 'error', 'context', `Could not attach the optional canvas image: ${(error as Error).message}`); return undefined;
      }) : undefined;
      if (canvasImage) await this.activity.emit(task.id, 'status', 'context', 'Attached a current workspace screenshot for the coding agent');
      const referenceNames = task.referenceWorkspaceIds.map((id) => this.registry.get(id).name);
      markPhase('context');
      const initialOffset = Date.now() - taskStarted; const initial = await this.agent.perform(task.id, promptFor(task.request, settings, taskContext.text, referenceNames, task.approvedPlanContent), () => task.cancelled, settings, canvasImage, task.referenceWorkspaceIds, { objective: task.request.objective, criteria: task.request.successCriteria, todo: (name, args) => todo.execute(name, args), requireTodos: !!task.request.approvedPlan, hasTodos: () => task.todos.length > 0 });
      summary = initial.summary; mergePerformance(initial.performance, initialOffset); phaseStarted = Date.now();
      if (task.request.approvedPlan) {
        let unfinished = task.todos.filter((item) => item.status !== 'completed');
        if (!task.todos.length || unfinished.length) {
          const reconcileOffset = Date.now() - taskStarted;
          const reconcile = await this.agent.perform(task.id, `Your implementation turn ended before the approved-plan checklist was complete. ${!task.todos.length ? 'Create the todo list from the approved plan now. ' : ''}Inspect the current workspace and checklist, finish any remaining implementation work, and update every completed step. If a step truly cannot be completed, mark it blocked with a concise reason. Do not run routine validation; the independent validator follows this turn.`, () => task.cancelled, settings, undefined, task.referenceWorkspaceIds, { objective: task.request.objective, criteria: task.request.successCriteria, todo: (name, args) => todo.execute(name, args), requireTodos: true, hasTodos: () => task.todos.length > 0 });
          summary = reconcile.summary || summary; mergePerformance(reconcile.performance, reconcileOffset); phaseStarted = Date.now(); unfinished = task.todos.filter((item) => item.status !== 'completed');
        }
        if (!task.todos.length) throw new Error('The coding agent finished without creating the approved plan todo list.');
        if (unfinished.length) throw new Error(`The coding agent finished with unresolved plan steps: ${unfinished.map((item) => `${item.id}. ${item.text} (${item.status})`).join(', ')}`);
      }
      if (settings.codingAgent.dependencies === 'existing-only' && dependencyBefore !== await this.tools.dependencyFingerprint()) throw new Error('The task changed package dependencies, but Workspace Settings allows existing packages only.');
      while (settings.codingAgent.validation === 'standard') {
        if (task.cancelled) throw new Error('Task cancelled');
        this.setStatus(task, retries ? 'repairing' : 'validating');
        const current = await this.tools.manifest();
        checks = await this.workspace.validate(task.id, this.tools.changed(before, current), settings.mode);
        const failed = checks.filter((check) => check.status === 'failed');
        if (!failed.length) break;
        if (retries >= 3) throw new Error(`Validation still failed after three repair passes: ${failed.map((check) => `${check.name}: ${check.details}`).join('\n')}`);
        retries++; await this.activity.emit(task.id, 'error', 'repairing', `Validation failed; starting automatic repair ${retries}/3\n${failed.map((check) => `${check.name}: ${check.details}`).join('\n')}`);
        const repairOffset = Date.now() - taskStarted; const repair = await this.agent.perform(task.id, `The independent validator found these failures after your implementation:\n${failed.map((check) => `${check.name}: ${check.details}`).join('\n')}\nInspect and repair the workspace. Update the todo list if a completed step must be reopened or a blocker is found. Do not rerun routine checks; the independent validator will do that. Finish with an updated summary.`, () => task.cancelled, settings, undefined, task.referenceWorkspaceIds, { objective: task.request.objective, criteria: task.request.successCriteria, repair: true, todo: (name, args) => todo.execute(name, args), requireTodos: !!task.request.approvedPlan, hasTodos: () => task.todos.length > 0 });
        summary = repair.summary; mergePerformance(repair.performance, repairOffset); markPhase('repair');
      }
      if (settings.codingAgent.validation === 'standard') markPhase('validation');
      if (settings.codingAgent.validation !== 'standard') checks = [{ name: 'independent validation', status: 'skipped', details: `${settings.codingAgent.validation} validation mode was selected.` }];
      this.setStatus(task, 'publishing'); const published = await this.workspace.publish(task.id, { browserGuard: settings.codingAgent.validation === 'fast', mode: settings.mode }); markPhase('publication');
      if (task.request.approvedPlan) await this.plans.removeCompleted(task.request.approvedPlan.id, task.request.approvedPlan.path, task.workspaceId, published.version);
      const after = await this.tools.manifest(); const changedFiles = this.tools.changed(before, after);
      const result: TaskResult = { taskId: task.id, status: 'completed', summary: summary || `Completed ${task.request.objective}`, changedFiles, checks, retries, previewVersion: published.version, previewUrl: published.previewUrl, performance: { phases, ...aggregate } };
      task.result = result; this.setStatus(task, 'completed'); await this.activity.emit(task.id, 'complete', 'complete', `${result.summary}\nPublished ${changedFiles.length} changed file(s) to ${published.previewUrl}`, result);
    } catch (error) {
      const cancelled = task.cancelled || (error as Error).message === 'Task cancelled';
      await this.workspace.preserveFailed(task.id).catch(() => undefined); await this.workspace.restoreDraft(task.id).catch(() => undefined);
      const after = await this.tools.manifest().catch(() => new Map<string, string>()); const changedFiles = this.tools.changed(before, after);
      const result: TaskResult = { taskId: task.id, status: cancelled ? 'cancelled' : 'failed', summary: cancelled ? 'Coding task cancelled; the visible workspace was not changed.' : (error as Error).message, changedFiles, checks, retries };
      task.result = result; this.setStatus(task, result.status); await this.activity.emit(task.id, cancelled ? 'complete' : 'error', result.status, result.summary, result);
    }
  }

  private async finishCancelled(task: InternalTask) { task.result = { taskId: task.id, status: 'cancelled', summary: 'Coding task cancelled before it started.', changedFiles: [], checks: [], retries: 0 }; this.setStatus(task, 'cancelled'); await this.activity.emit(task.id, 'complete', 'cancelled', task.result.summary, task.result); }
  private setStatus(task: InternalTask, status: TaskStatus) { task.status = status; task.updatedAt = new Date().toISOString(); this.activity.update(publicTask(task)); }
}

export function promptFor(request: TaskRequest, settings: WorkspaceSettings, taskContext = '', referenceNames: string[] = [], approvedPlanContent?: string) {
  const selection = request.selectedElement;
  const target = selection?.kind === 'dom' ? `\n\nThe user selected this exact rendered DOM element:\n- Stable identifier: ${selection.identifier}\n- Unique selector: ${selection.selector}\n- Tag: ${selection.tagName}\n- Visible text: ${JSON.stringify(selection.text)}\n- Attributes: ${JSON.stringify(selection.attributes)}\n- Bounds: ${JSON.stringify(selection.rect)}\n- Parent text: ${JSON.stringify(selection.parentText)}\n- Nearby rendered HTML:\n${selection.outerHTML}\n\nUse the selected text, attributes, and selector to search the source directly.`
    : selection?.kind === 'canvas' ? `\n\nThe user selected this semantic canvas layer:\n- Stable identifier: ${selection.identifier}\n- Canvas: ${selection.canvasId}\n- Layer: ${selection.layerId}\n- Label/type: ${selection.label} / ${selection.layerType}\n- Properties: ${JSON.stringify(selection.properties)}\n- Bounds: ${JSON.stringify(selection.rect)}\n\nSearch for the stable layer ID first and preserve its registration with window.coworkCanvas.` : '';
  const selectedFiles = request.selectedFiles?.length ? `\n\nThe user selected these workspace files as explicit context. Read the relevant ones first and use selected images as referenceImages when generating related media:\n${request.selectedFiles.map((path) => `- ${path}`).join('\n')}` : '';
  const references = referenceNames.length ? `\n\nThe user explicitly authorized read-only access to these source workspaces for this task: ${referenceNames.join(', ')}. Use reference tools to inspect them and copy only required files into the active workspace; never attempt to modify a source workspace.` : '';
  const context = taskContext ? `Preloaded workspace context (use this before calling discovery tools):\n\n${taskContext}\n\n--- END PRELOADED CONTEXT ---\n\n` : '';
  const approvedPlan = request.approvedPlan && approvedPlanContent ? `\n\nExecute this user-reviewed implementation plan. It is the authoritative task specification. Read the current versions of every relevant file before changing it, create a visible todo list from the numbered implementation steps before the first mutation, and keep the todos updated throughout execution.\n\nApproved plan: ${request.approvedPlan.path}\nPlan hash: ${request.approvedPlan.hash}\n\n--- APPROVED PLAN ---\n${approvedPlanContent}\n--- END APPROVED PLAN ---` : '';
  return `${context}Implement this workspace task autonomously in ${settings.mode.toUpperCase()} workspace mode:\n\n${request.objective}${request.successCriteria?.length ? `\n\nSuccess criteria:\n${request.successCriteria.map((item) => `- ${item}`).join('\n')}` : ''}${target}${selectedFiles}${references}${approvedPlan}\n\nMake the smallest correct change and provide a concise completion summary with file references.`;
}
function publicTask(task: InternalTask): TaskSnapshot { const { cancelled: _cancelled, referenceWorkspaceIds: _references, approvedPlanContent: _plan, ...value } = task; return value; }

export class TodoController {
  constructor(private readonly task: InternalTask, private readonly activity: ActivityHub, private readonly publish: () => void) {}
  async execute(name: string, args: any) {
    if (name === 'create_todo_list') {
      if (this.task.todos.length) throw new Error('The todo list already exists; update it instead of recreating it.');
      const items = Array.isArray(args?.items) ? args.items.map((item: unknown) => String(item).trim()).filter(Boolean) : [];
      if (!items.length || items.length > 30) throw new Error('create_todo_list requires 1 to 30 non-empty items.');
      if (new Set(items.map((item: string) => item.toLocaleLowerCase())).size !== items.length) throw new Error('Todo items must be unique.');
      if (items.some((item: string) => item.length > 240)) throw new Error('Todo items cannot exceed 240 characters.');
      this.task.todos = items.map((text: string, index: number): TaskTodo => ({ id: String(index + 1), text, status: index === 0 ? 'in_progress' : 'pending' }));
    } else if (name === 'update_todo_list') {
      if (!this.task.todos.length) throw new Error('Create the todo list before updating it.');
      const updates = Array.isArray(args?.updates) ? args.updates : [];
      if (!updates.length || updates.length > 30) throw new Error('update_todo_list requires 1 to 30 updates.');
      const next = this.task.todos.map((item) => ({ ...item }));
      for (const update of updates) {
        const item = next.find((candidate) => candidate.id === String(update?.id)); if (!item) throw new Error(`Unknown todo ID: ${update?.id}`);
        if (!['pending', 'in_progress', 'completed', 'blocked'].includes(update?.status)) throw new Error(`Invalid todo status for ${item.id}.`);
        item.status = update.status; const note = String(update?.note || '').trim(); if (note.length > 500) throw new Error('Todo notes cannot exceed 500 characters.');
        item.note = note || undefined;
      }
      if (next.filter((item) => item.status === 'in_progress').length > 1) throw new Error('Only one todo may be in progress.');
      this.task.todos = next;
    } else throw new Error(`Unknown todo tool: ${name}`);
    this.task.updatedAt = new Date().toISOString(); this.publish();
    await this.activity.emit(this.task.id, 'todo', 'todo', this.task.todos.map((item) => `${item.id}. [${item.status}] ${item.text}${item.note ? ` — ${item.note}` : ''}`).join('\n'), { todos: this.task.todos });
    return { todos: this.task.todos };
  }
}
