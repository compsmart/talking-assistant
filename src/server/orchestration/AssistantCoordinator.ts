import { GoogleGenAI } from '@google/genai';
import type { AgentProfile, AgentStage, AssistantIntakeRequest, WorkDispatchKind, WorkItemSnapshot, WorkUpdateMode } from '../../shared/protocol.js';
import { config } from '../config.js';
import type { AgentConfigService } from '../agents/AgentConfigService.js';
import type { AgentRuntimeProfile } from '../agent/CodingAgent.js';
import { AgentRouter, type AgentRoutingDecision, type RoutableAgentProfile } from './AgentRouter.js';

export interface CoordinationDecision { action: 'code' | 'media' | 'plan' | 'duplicate'; duplicateOf?: string; writeScope: string[]; reason: string }
export interface AssistantManagementDecision {
  action: 'create' | 'reuse' | 'update' | 'cancel' | 'answer' | 'approve' | 'status' | 'ignore' | 'clarify' | 'reject';
  targetId?: string;
  questionId?: string;
  objective?: string;
  successCriteria?: string[];
  execution?: 'fast' | WorkDispatchKind;
  updateMode?: WorkUpdateMode;
  message: string;
}
export type AgentSelectionDecision =
  | { status: 'selected'; agent: AgentRuntimeProfile; reason: string; candidates: Array<{ id: string; name: string; score: number }> }
  | { status: 'tie'; reason: string; candidates: Array<{ id: string; name: string; score: number }> }
  | { status: 'no_eligible'; reason: string; candidates: [] };

const SYSTEM = `You are the hidden orchestration Assistant for a local coding application. You never address the user and never present yourself as a conversational identity. Decide how one durable user work item should be routed.

Return JSON only:
{"action":"code|media|duplicate","duplicateOf":"optional active task id","writeScope":["likely glob"],"reason":"short operational reason"}

Rules:
- duplicate only when a non-terminal task has the same intended deliverable, not merely a related topic.
- route standalone image generation or manipulation, sprite/symbol extraction, video, animation, music, audio, and sound-effect work to media.
- route requests that explicitly integrate media into application code, pages, components, games, or an HTML5 canvas to code.
- route every other non-duplicate automatic request to code, including architectural work, uncertain debugging, migrations, redesigns, dependency changes, and broad work.
- planning is handled before this decision only when the user explicitly selects plan_first or plan_only; never infer or return plan.
- writeScope is advisory and must be conservative; use **/* when the owning paths cannot be known from the request.
- do not write code, claim completion, or explain this decision to the user.`;

const MANAGEMENT_SYSTEM = `You are the authoritative task manager for a local coding application. A conversational Live agent forwards one user turn to you. You alone decide whether to create, reuse, update, cancel, answer, approve, report, ignore, clarify, or reject work.

Return JSON only:
{"action":"create|reuse|update|cancel|answer|approve|status|ignore|clarify|reject","targetId":"optional exact task id","questionId":"optional exact question id","objective":"normalized requested outcome","successCriteria":["observable result"],"execution":"fast|code|media|plan","updateMode":"append|correct|replace","message":"short first-person sentence for Live to speak"}

Rules:
- Treat the raw user text and application context as authoritative. A Live note is advisory only.
- Inspect active work before creating anything. Reuse a non-terminal task with the same intended deliverable even when wording differs.
- A correction, extension, or changed direction for existing work is update, not create. A stop request is cancel.
- If more than one task plausibly matches an update, cancel, answer, or approval, return clarify and change nothing.
- Use answer only for an exact open question and approve only for an exact task awaiting plan approval.
- Use status for progress questions, ignore for conversation with no workspace action, and reject unsafe or impossible requests.
- Use fast only for a clear localized edit to one existing code, text, style, or configuration file. Never use fast for media, dependencies, commands, file creation/deletion/rename/copy, multiple files, or uncertain targets.
- Use media for standalone asset generation or image/media processing. Use code when media must be integrated into an app, page, game, component, or HTML5 canvas.
- Use plan only when the user explicitly asks for a plan or reviewed plan-first workflow. Never infer planning from complexity.
- Never force a duplicate unless the user explicitly asks for a separate variant or independent copy.
- Do not claim work completed unless the supplied ledger says it completed.`;

export class AssistantCoordinator {
  private client?: GoogleGenAI;
  constructor(private readonly agents?: AgentConfigService) { if (config.geminiKey) this.client = new GoogleGenAI({ apiKey: config.geminiKey }); }

  async manage(request: AssistantIntakeRequest, history: WorkItemSnapshot[]): Promise<AssistantManagementDecision> {
    const active = history.filter((item) => !['completed', 'failed', 'cancelled', 'superseded'].includes(item.status));
    if (!this.client) return managementFallback(request, active);
    try {
      const response = await this.client.models.generateContent({
        model: config.assistantModel,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({
          request: {
            rawUserText: request.userText,
            liveNote: request.liveNote,
            selectedElement: request.selectedElement ? { kind: request.selectedElement.kind, identifier: request.selectedElement.identifier, ...(request.selectedElement.kind === 'dom' ? { text: request.selectedElement.text, selector: request.selectedElement.selector, tagName: request.selectedElement.tagName } : { label: request.selectedElement.label, layerId: request.selectedElement.layerId }) } : undefined,
            selectedFiles: request.selectedFiles,
          },
          work: history.slice(-30).map((item) => ({ id: item.id, status: item.status, revision: item.specRevision, objective: item.request.objective, criteria: item.request.successCriteria, plan: item.plan, questions: item.questions.filter((question) => !question.answeredAt).map((question) => ({ id: question.id, prompt: question.prompt, options: question.options })) })),
        }) }] }],
        config: { systemInstruction: MANAGEMENT_SYSTEM, responseMimeType: 'application/json', temperature: 0 },
      } as any);
      return validateManagementDecision(JSON.parse(String((response as any).text || '{}')), request, history);
    } catch {
      return managementFallback(request, active);
    }
  }

  async coordinate(work: WorkItemSnapshot, active: WorkItemSnapshot[]): Promise<CoordinationDecision> {
    if (work.strategy === 'plan_first' || work.strategy === 'plan_only') return { action: 'plan', writeScope: [], reason: 'The task explicitly requires planning.' };
    if (work.plan) return { action: 'code', writeScope: ['**/*'], reason: 'The approved implementation plan is ready for coding.' };
    const duplicate = active.find((item) => item.id !== work.id && normalize(item.request.objective) === normalize(work.request.objective) && !['completed', 'failed', 'cancelled', 'superseded'].includes(item.status));
    if (duplicate) return { action: 'duplicate', duplicateOf: duplicate.id, writeScope: [], reason: 'An equivalent task is already active.' };
    if (isStandaloneMediaObjective(work.request.objective)) return { action: 'media', writeScope: ['assets/generated/**', 'assets/processed/**'], reason: 'Standalone media work routes to the configured Media Agent.' };
    if (work.strategy === 'direct') return isStandaloneMediaObjective(work.request.objective)
      ? { action: 'media', writeScope: ['assets/generated/**', 'assets/processed/**'], reason: 'The explicitly ready task is standalone media work.' }
      : { action: 'code', writeScope: ['**/*'], reason: 'The task is explicitly implementation-ready.' };
    if (!this.client) return fallback(work, active);
    try {
      const response = await this.client.models.generateContent({
        model: config.assistantModel,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ work: { id: work.id, objective: work.request.objective, successCriteria: work.request.successCriteria, selectedFiles: work.request.selectedFiles }, active: active.filter((item) => item.id !== work.id).map((item) => ({ id: item.id, objective: item.request.objective, status: item.status })) }) }] }],
        config: { systemInstruction: SYSTEM, responseMimeType: 'application/json', temperature: 0 },
      } as any);
      const parsed = JSON.parse(String((response as any).text || '{}'));
      if (!['code', 'media', 'duplicate'].includes(parsed.action)) throw new Error('Invalid Assistant action.');
      if (parsed.action === 'duplicate' && !active.some((item) => item.id === parsed.duplicateOf && item.id !== work.id)) throw new Error('Invalid duplicate target.');
      return { action: parsed.action, duplicateOf: parsed.duplicateOf, writeScope: Array.isArray(parsed.writeScope) && parsed.writeScope.length ? parsed.writeScope.map(String).slice(0, 20) : parsed.action === 'code' ? ['**/*'] : parsed.action === 'media' ? ['assets/generated/**', 'assets/processed/**'] : [], reason: String(parsed.reason || 'Assistant routing decision.') };
    } catch { return fallback(work, active); }
  }

  async selectAgent(work: WorkItemSnapshot, stage: AgentStage, history: WorkItemSnapshot[]): Promise<AgentSelectionDecision> {
    if (!this.agents) return { status: 'selected', agent: legacyProfile(stage), reason: 'Using the built-in compatibility profile.', candidates: [] };
    const snapshot = this.agents.get();
    const profiles = snapshot.profiles.map((profile) => effectiveProfile(profile, snapshot, work.workspaceId));
    const candidates = profiles.filter((profile) => profile.stages.includes(stage));
    const scores = await this.semanticScores(work.request.objective, stage, candidates);
    const states = Object.fromEntries(profiles.map((profile) => {
      const attempts = history.flatMap((item) => item.attempts).filter((attempt) => (attempt as any).agentId === profile.id);
      const terminal = attempts.filter((attempt) => ['succeeded', 'failed'].includes(attempt.status));
      const reliability = terminal.length ? terminal.filter((attempt) => attempt.status === 'succeeded').length / terminal.length : .5;
      return [profile.id, { active: attempts.filter((attempt) => attempt.status === 'running').length, reliability }];
    }));
    const routerProfiles: RoutableAgentProfile[] = profiles.map((profile) => ({
      id: profile.id, name: profile.name, enabled: profile.enabled, stages: profile.stages,
      capabilities: profile.capabilities, tools: profile.toolIds, secrets: profile.secretGrantIds,
      priority: profile.priority, maxConcurrency: profile.maxConcurrency, model: profile.model,
      riskClass: profile.toolIds.some((id) => ['apply_edits', 'run_command', 'install_dependencies'].includes(id)) ? 'mutating' : 'read-only',
      secretExposure: snapshot.secrets.some((secret) => secret.exposure === 'model_readable' && secret.agentIds.includes(profile.id)) ? 'model_readable' : snapshot.secrets.some((secret) => secret.agentIds.includes(profile.id)) ? 'tool_only' : 'none',
      configurationErrors: snapshot.skills.filter((skill) => skill.enabled && profile.skillIds.includes(skill.id)).flatMap((skill) => [
        ...skill.requiredToolIds.filter((id) => !profile.toolIds.includes(id)).map((id) => `skill ${skill.name} requires tool ${id}`),
        ...skill.requiredSecretKinds.filter((kind) => !snapshot.secrets.some((secret) => secret.kind === kind && secret.agentIds.includes(profile.id) && (secret.scope === 'global' || secret.workspaceId === work.workspaceId))).map((kind) => `skill ${skill.name} requires secret kind ${kind}`),
      ]),
      routingRules: profile.routingRules.filter((rule) => rule.enabled).map((rule) => ({ id: rule.id, weight: rule.weight, stages: rule.stages, capabilities: rule.capabilities, keywords: rule.keywords, fileGlobs: rule.fileGlobs, exclude: rule.effect === 'exclude' })),
    }));
    const requiredTools = stage === 'coder' || stage === 'resolver' ? ['apply_edits'] : stage === 'planner' || stage === 'researcher' || stage === 'reviewer' ? ['read_files'] : [];
    let decision = new AgentRouter({ tieThreshold: snapshot.routing.tieThreshold }).route({
      stage, objective: work.request.objective, requiredCapabilities: [], requiredTools,
      files: work.request.selectedFiles, preferredAgentId: (work.request as any).preferredAgentId, semanticScores: scores,
    }, routerProfiles, states);
    if (snapshot.routing.mode === 'priority_first' && decision.status === 'tie') decision = { status: 'selected', selected: decision.candidates[0], candidates: decision.candidates, excluded: decision.excluded, preferred: false, reason: `Selected ${decision.candidates[0].name} by strict priority policy.` };
    if (snapshot.routing.mode === 'ask_on_overlap' && decision.status === 'selected' && !decision.preferred && decision.candidates.length > 1) decision = { status: 'tie', candidates: decision.candidates, excluded: decision.excluded, reason: 'Multiple eligible agents overlap and the routing policy requires a user choice.' };
    const selection = selectionFrom(decision, profiles, stage);
    if (selection.status === 'selected') {
      const agentId = selection.agent.id;
      selection.agent.modelReadableSecrets = this.agents.modelReadableSecrets(agentId, work.workspaceId);
      if (selection.agent.modelReadableSecrets.length) selection.agent.readSecret = (secretId) => this.agents!.readModelSecret(secretId, agentId, work.workspaceId);
    }
    return selection;
  }

  private async semanticScores(objective: string, stage: AgentStage, profiles: AgentProfile[]) {
    if (!profiles.length) return {};
    if (!this.client) return Object.fromEntries(profiles.map((profile) => [profile.id, 50]));
    try {
      const response = await this.client.models.generateContent({
        model: config.assistantModel,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ objective, stage, candidates: profiles.map((profile) => ({ id: profile.id, name: profile.name, description: profile.description, capabilities: profile.capabilities, examples: profile.routingRules.flatMap((rule) => rule.examples || []), negativeExamples: profile.routingRules.flatMap((rule) => rule.negativeExamples || []) })) }) }] }],
        config: { systemInstruction: 'Score each candidate from 0 to 100 for this assignment. Return JSON only as {"scores":{"agent-id":number}}. Do not include candidates not provided.', responseMimeType: 'application/json', temperature: 0 },
      } as any);
      const parsed = JSON.parse(String((response as any).text || '{}')).scores || {};
      return Object.fromEntries(profiles.map((profile) => [profile.id, Math.max(0, Math.min(100, Number(parsed[profile.id]) || 0))]));
    } catch { return Object.fromEntries(profiles.map((profile) => [profile.id, 50])); }
  }
}

function effectiveProfile(profile: AgentProfile, snapshot: ReturnType<AgentConfigService['get']>, workspaceId: string): AgentProfile {
  const override = snapshot.overrides.find((item) => item.agentId === profile.id && item.workspaceId === workspaceId);
  const skillIds = override?.skillIds || profile.skillIds; const contextIds = override?.contextIds || profile.contextIds;
  const skills = snapshot.skills.filter((skill) => skill.enabled && skillIds.includes(skill.id));
  const contexts = snapshot.contexts.filter((context) => context.enabled && contextIds.includes(context.id) && (context.scope === 'global' || context.workspaceId === workspaceId));
  const additions = [...skills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`), ...contexts.map((context) => `Context: ${context.name}\n${context.content || `Workspace files: ${(context.fileGlobs || []).join(', ')}`}`)].filter(Boolean).join('\n\n');
  return { ...profile, enabled: override?.enabled ?? profile.enabled, capabilities: [...new Set([...profile.capabilities, ...skills.flatMap((skill) => skill.capabilities)])], toolIds: override?.toolIds?.filter((id) => profile.toolIds.includes(id)) || profile.toolIds, skillIds, contextIds, secretGrantIds: override?.secretGrantIds || profile.secretGrantIds, priority: override?.priority ?? profile.priority, instructions: [profile.instructions, additions].filter(Boolean).join('\n\n') };
}

function selectionFrom(decision: AgentRoutingDecision, profiles: AgentProfile[], stage: AgentStage): AgentSelectionDecision {
  if (decision.status === 'no_eligible') return { status: 'no_eligible', reason: decision.reason, candidates: [] };
  const candidates = decision.candidates.map((item) => ({ id: item.id, name: item.name, score: item.score.total }));
  if (decision.status === 'tie') return { status: 'tie', reason: decision.reason, candidates };
  const profile = profiles.find((item) => item.id === decision.selected.id)!;
  return { status: 'selected', reason: decision.reason, candidates, agent: { id: profile.id, name: profile.name, revision: profile.revision, stage, modelId: profile.model, instructions: profile.instructions, enabledToolIds: profile.toolIds } };
}

function legacyProfile(stage: AgentStage): AgentRuntimeProfile { return { id: `builtin-${stage}`, name: stage[0].toUpperCase() + stage.slice(1), revision: 1, stage }; }

function fallback(work: WorkItemSnapshot, active: WorkItemSnapshot[]): CoordinationDecision {
  const normalized = normalize(work.request.objective);
  const duplicate = active.find((item) => item.id !== work.id && normalize(item.request.objective) === normalized && !['completed', 'failed', 'cancelled', 'superseded'].includes(item.status));
  if (duplicate) return { action: 'duplicate', duplicateOf: duplicate.id, writeScope: [], reason: 'An equivalent task is already active.' };
  if (isStandaloneMediaObjective(work.request.objective)) return { action: 'media', writeScope: ['assets/generated/**', 'assets/processed/**'], reason: 'Standalone media work routes to the configured Media Agent.' };
  return { action: 'code', writeScope: ['**/*'], reason: 'Automatic work routes directly to implementation; planning is user-requested only.' };
}

function validateManagementDecision(value: any, request: AssistantIntakeRequest, history: WorkItemSnapshot[]): AssistantManagementDecision {
  const actions = new Set(['create', 'reuse', 'update', 'cancel', 'answer', 'approve', 'status', 'ignore', 'clarify', 'reject']);
  const action = actions.has(String(value.action)) ? String(value.action) as AssistantManagementDecision['action'] : 'clarify';
  const targetId = typeof value.targetId === 'string' ? value.targetId : undefined;
  const target = targetId ? history.find((item) => item.id === targetId) : undefined;
  if (['reuse', 'update', 'cancel', 'answer', 'approve'].includes(action) && !target) return { action: 'clarify', message: 'I need to know which task you mean before I change anything.' };
  if (['update', 'cancel', 'answer', 'approve'].includes(action) && target && ['completed', 'failed', 'cancelled', 'superseded'].includes(target.status)) return { action: 'clarify', message: 'That task is no longer active; tell me whether you want a new task instead.' };
  let execution = ['fast', 'code', 'media', 'plan'].includes(String(value.execution)) ? value.execution as AssistantManagementDecision['execution'] : undefined;
  if (execution === 'plan' && !explicitlyRequestsPlan(request.userText)) execution = 'code';
  const updateMode = ['append', 'correct', 'replace'].includes(String(value.updateMode)) ? value.updateMode as WorkUpdateMode : 'append';
  const message = String(value.message || defaultManagementMessage(action)).trim().slice(0, 1000);
  return {
    action, targetId, questionId: typeof value.questionId === 'string' ? value.questionId : undefined,
    objective: typeof value.objective === 'string' && value.objective.trim() ? value.objective.trim() : request.userText.trim(),
    successCriteria: Array.isArray(value.successCriteria) ? value.successCriteria.map(String).map((item: string) => item.trim()).filter(Boolean).slice(0, 30) : [],
    execution, updateMode, message,
  };
}

function managementFallback(request: AssistantIntakeRequest, active: WorkItemSnapshot[]): AssistantManagementDecision {
  const text = request.userText.trim(); const lower = text.toLocaleLowerCase();
  if (!text) return { action: 'ignore', message: 'There is no request for me to act on.' };
  if (/\b(status|progress|how(?:'s| is) .*going|what.*working on)\b/i.test(text)) return { action: 'status', message: active.length ? `I have ${active.length} active task${active.length === 1 ? '' : 's'}.` : 'I do not have any active tasks.' };
  const exact = active.find((item) => normalize(item.request.objective) === normalize(text));
  if (exact) return { action: 'reuse', targetId: exact.id, message: 'I already have that in progress.' };
  if (/^(?:hi|hello|hey|thanks|thank you|okay|ok|great|nice)[.! ]*$/i.test(text)) return { action: 'ignore', message: 'Happy to help.' };
  const execution: AssistantManagementDecision['execution'] = explicitlyRequestsPlan(text) ? 'plan' : isStandaloneMediaObjective(text) ? 'media' : isFastEditObjective(text, request.selectedFiles) ? 'fast' : 'code';
  return { action: 'create', objective: text, successCriteria: [], execution, message: execution === 'fast' ? 'I’ll make that focused change now.' : 'I’m doing that now.' };
}

export function isFastEditObjective(text: string, selectedFiles: string[] = []) {
  if (selectedFiles.length > 1 || text.length > 500) return false;
  const action = /\b(change|replace|rename|set|update|make|fix|adjust)\b/i.test(text);
  const unsafe = /\b(create|add (?:a )?(?:new )?file|delete|remove (?:the )?file|move|copy|install|dependency|package|command|script|generate|image|video|animation|audio|music|multiple|across|refactor|redesign|feature)\b/i.test(text);
  return action && !unsafe;
}

function explicitlyRequestsPlan(text: string) { return /\b(plan|planning|plan-first|implementation plan|design document)\b/i.test(text); }
function defaultManagementMessage(action: AssistantManagementDecision['action']) {
  if (action === 'clarify') return 'I need a little more detail before I change anything.';
  if (action === 'ignore') return 'No workspace action is needed.';
  if (action === 'status') return 'I checked the current work.';
  return 'I handled that request.';
}
export function isStandaloneMediaObjective(objective: string) {
  const text = objective.normalize('NFKC').toLocaleLowerCase();
  const mediaAction = /\b(generate|create|design|draw|illustrate|render|produce|edit|manipulate|transform|retouch|crop|resize|upscale|remove(?:\s+the)?\s+background|extract|isolate|slice|split)\b/.test(text);
  const mediaSubject = /\b(image|images|photo|photos|picture|pictures|illustration|illustrations|icon|icons|symbol|symbols|sprite|sprites|texture|textures|background|backgrounds|video|videos|animation|animations|audio|music|sound(?:\s+effect)?s?)\b/.test(text);
  const explicitIntegration = /\b(add|place|insert|integrate|embed|display|show|wire|hook|use|replace|map)\b[^.\n]{0,100}\b(page|site|app|application|component|screen|layout|reel|game|canvas|workspace|code)\b|\b(?:as|for)\s+(?:the\s+)?(?:page|site|app|application|component|screen|layout|canvas)\b|\b(?:gallery|component)\b/.test(text);
  return mediaAction && mediaSubject && !explicitIntegration;
}
function normalize(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
