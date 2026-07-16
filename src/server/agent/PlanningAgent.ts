import { GoogleGenAI } from '@google/genai';
import type { ActivityHub } from '../activity.js';
import { config } from '../config.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';

export const PLANNING_SYSTEM = `You are the read-only software architect for a local cowork application. Explore the generated project thoroughly and produce a decision-complete implementation plan for a separate coding agent.

Hard boundaries:
- You cannot create, edit, delete, move, or copy project files.
- You cannot run shell commands, install dependencies, inspect a live preview, or generate media.
- Use only the provided list, search, locate, and read tools. Never ask for a mutation tool.
- The server will persist your final Markdown response; do not attempt to save it yourself.

Planning process:
1. Understand the objective, success criteria, selected context, workspace mode, and project guidance.
2. Trace the relevant architecture, existing patterns, interfaces, data flow, and tests.
3. Resolve discoverable questions by reading the project. Choose conservative defaults for remaining low-risk ambiguity and state them as assumptions.
4. Produce an implementation-ready plan with no unresolved decisions.

Return Markdown only, with these sections: title, summary, current-state findings, numbered implementation steps, public interfaces or data changes, test scenarios, assumptions, and critical files. Each implementation step must be concrete enough to become a coding-agent todo. Do not wrap the response in a code fence.`;

const TOOLS = [
  tool('list_files', 'List project files beneath a workspace-relative directory.', { path: stringProp('Relative directory, default .') }),
  tool('search_files', 'Search project filenames and text content.', { query: stringProp('Text to find'), path: stringProp('Relative root, default .') }, ['query']),
  tool('locate_code', 'Search up to eight filename or text queries and return contextual source excerpts.', { queries: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['queries']),
  tool('read_files', 'Read up to eight line-ranged project files.', { files: { type: 'array', maxItems: 8, items: { type: 'object', properties: { path: stringProp('Relative file path'), startLine: numberProp('First line'), endLine: numberProp('Last line') }, required: ['path'] } } }, ['files']),
  tool('list_reference_files', 'List files in a user-authorized read-only source workspace.', { workspace: stringProp('Exact workspace name'), path: stringProp('Relative directory, default .') }, ['workspace']),
  tool('read_reference_file', 'Read a text file from a user-authorized source workspace.', { workspace: stringProp('Exact workspace name'), path: stringProp('Relative file path'), startLine: numberProp('First line'), endLine: numberProp('Last line') }, ['workspace', 'path']),
  tool('search_reference_files', 'Search a user-authorized source workspace.', { workspace: stringProp('Exact workspace name'), query: stringProp('Text to find'), path: stringProp('Relative root, default .') }, ['workspace', 'query']),
];
export const PLANNING_TOOL_NAMES = TOOLS.map((item) => item.name);
export const PLANNING_SEGMENT_LIMIT = 80;

interface PendingCall { id: string; name: string; initialArguments?: unknown; argumentFragments: string }
export interface PlanningContinuationState { previousInteractionId: string; input: any; interactionCount: number; segment: number }
export type PlanningOutcome =
  | { status: 'completed'; content: string; interactionCount: number; segment: number }
  | { status: 'paused'; reason: 'step_limit' | 'timeout'; message: string; continuation: PlanningContinuationState };

export class PlanningAgent {
  private client?: GoogleGenAI;
  constructor(private readonly tools: WorkspaceTools, private readonly activity: ActivityHub) {
    if (config.geminiKey) this.client = new GoogleGenAI({ apiKey: config.geminiKey });
  }

  async perform(runId: string, prompt: string, cancelled: () => boolean, referenceWorkspaceIds: string[] = [], continuation?: PlanningContinuationState): Promise<PlanningOutcome> {
    if (!this.client) throw new Error('GEMINI_API_KEY is not configured on the server.');
    let input: any = continuation?.input ?? prompt; let previousInteractionId = continuation?.previousInteractionId || '';
    let interactionCount = continuation?.interactionCount || 0; const segment = (continuation?.segment || 0) + 1;
    for (let iteration = 0; iteration < PLANNING_SEGMENT_LIMIT; iteration++) {
      if (cancelled()) throw new Error('Planning cancelled');
      const checkpoint: PlanningContinuationState = { previousInteractionId, input, interactionCount, segment };
      const pending = new Map<number, PendingCall>(); let interactionId = ''; let requiresAction = false; let output = '';
      try {
        const stream = await (this.client as any).interactions.create({
          model: config.plannerModel, input, ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
          system_instruction: PLANNING_SYSTEM, tools: TOOLS.filter((item) => referenceWorkspaceIds.length || !item.name.includes('reference_')),
          generation_config: { thinking_level: 'medium', thinking_summaries: 'auto' }, store: true, stream: true,
        }, { timeout: config.taskTimeoutMs });

        for await (const event of stream as AsyncIterable<any>) {
          if (cancelled()) throw new Error('Planning cancelled');
          const type = event.event_type;
          if (['interaction.created', 'interaction.in_progress', 'interaction.requires_action', 'interaction.completed'].includes(type)) interactionId = event.interaction?.id || interactionId;
          if (type === 'interaction.requires_action') requiresAction = true;
          if (type === 'step.start') {
            const step = event.step || {};
            if (step.type === 'function_call') pending.set(event.index, { id: step.id, name: step.name, initialArguments: step.arguments, argumentFragments: '' });
            if (step.type === 'thought' && step.summary) for (const part of step.summary) if (part.text) await this.activity.emit(runId, 'thought_summary', 'planning', part.text);
            if (step.type === 'model_output' && step.content) for (const part of step.content) if (part.text) output += part.text;
          }
          if (type === 'step.delta') {
            const delta = event.delta || {};
            if (delta.type === 'thought_summary' && delta.content?.text) await this.activity.emit(runId, 'thought_summary', 'planning', delta.content.text);
            if (delta.type === 'text' && delta.text) output += delta.text;
            if (delta.type === 'arguments_delta') { const call = pending.get(event.index); if (call && typeof delta.arguments === 'string') call.argumentFragments += delta.arguments; }
          }
        }
      } catch (error) {
        if (!isRecoverableTimeout(error) || cancelled()) throw error;
        return { status: 'paused', reason: 'timeout', message: 'The planning model timed out. Its last completed interaction is preserved and can be resumed.', continuation: checkpoint };
      }
      interactionCount++;
      if (interactionId) previousInteractionId = interactionId;
      if (!requiresAction && !pending.size) {
        const plan = output.trim(); if (!plan) throw new Error('The planning agent returned an empty plan.');
        await this.activity.emit(runId, 'model_output', 'planning', plan); return { status: 'completed', content: plan, interactionCount, segment };
      }

      const calls = [...pending.values()].map((call) => {
        const serialized = call.argumentFragments || (typeof call.initialArguments === 'string' ? call.initialArguments : JSON.stringify(call.initialArguments ?? {}));
        try { return { call, args: serialized ? JSON.parse(serialized) : {} }; }
        catch { throw new Error(`Invalid arguments from planning model for ${call.name}: ${serialized}`); }
      });
      const values = await Promise.all(calls.map(({ call, args }) => this.tools.execute(runId, call.name, args, cancelled, undefined, referenceWorkspaceIds, 'planning')));
      input = calls.map(({ call }, index) => ({ type: 'function_result', name: call.name, call_id: call.id, result: [{ type: 'text', text: JSON.stringify(values[index]) }] }));
    }
    return { status: 'paused', reason: 'step_limit', message: `The planning agent used its ${PLANNING_SEGMENT_LIMIT}-interaction segment before completing the plan. Its interaction chain and pending tool results are preserved.`, continuation: { previousInteractionId, input, interactionCount, segment } };
  }
}

function isRecoverableTimeout(error: unknown) { return /timeout|timed out|deadline|etimedout|aborterror/i.test(`${(error as any)?.name || ''} ${(error as Error)?.message || error}`); }

function tool(name: string, description: string, properties: Record<string, any>, required: string[] = []) { return { type: 'function', name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }; }
function stringProp(description: string) { return { type: 'string', description }; }
function numberProp(description: string) { return { type: 'number', description }; }
