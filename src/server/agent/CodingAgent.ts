import { GoogleGenAI } from '@google/genai';
import type { ActivityHub } from '../activity.js';
import { config } from '../config.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';
import type { WorkspaceSettings } from '../../shared/protocol.js';

const BASE_SYSTEM = `You are the only coding subagent in a local cowork application. Work autonomously and make production-quality changes inside the generated project workspace.

Workspace contract:
- You may edit only files exposed by the workspace tools. Never attempt to access the cowork shell, host, secrets, Docker socket, or parent directories.
- The visible workspace is an ordinary web application. It must listen on 0.0.0.0:4173 when npm start runs and answer GET /health with HTTP 200.
- Keep package scripts for start, build, and test. You may implement both frontend and backend code inside this project.
- The command environment is Node.js and npm. Prefer Node.js scripts and npm tooling for project inspection and automation. Python is not installed; do not invoke python or python3 or introduce Python tooling.
- Inspect existing files before editing. Prefer focused replacements or full-file writes when the resulting file is clear.
- When the prompt includes a selected DOM element, use its exact text, attributes, and selector to search for the owning source first. For a surgical text or style request, do not list and read the whole repository.
- Preserve existing data-cowork-id attributes. Add concise, stable data-cowork-id values to newly created major sections and interactive controls so later visual selections map cleanly back to source; do not clutter every decorative child.
- Use install_dependencies only when package dependencies changed. The independent validator owns routine tests, builds, and final preview inspection; do not run them yourself.
- Delegate AI-created images, video, animation, music, and sound effects to delegate_media_task. It immediately returns stable placeholder paths; integrate those exact paths while the independent Media Agent works. Never substitute hand-coded drawings for requested generated media.
- Animation requires an explicit startFrame. For a seamless animation, use the same workspace-relative image as startFrame and endFrame. The Media Agent owns endpoint geometry, alpha, timing, audio, inspection, and encoding.
- Generated assets are organized under assets/generated. A transparent animation is always a four-second, 48-frame, 12 FPS WebP and may include a synchronized MP3 sidecar. Ensure the project serves these formats correctly.
- Use remove_image_background to transform an existing opaque image; when generating a new transparent subject, use generate_image with transparent true instead. Use extract_image_regions to split an existing sprite, symbol, icon, or object sheet into separate transparent assets. Processed outputs are organized under assets/processed. Prefer these tools over installing image libraries or writing disposable processing scripts.
- The independent validator performs a browser smoke test. Use inspect_preview yourself only when visual judgment is necessary or the requested result is ambiguous.
- For approved plans or work with several meaningful steps, create a todo list before the first workspace mutation. Keep exactly one step in progress, update the list as work advances or becomes blocked, and do not return your final summary while any step remains pending or in progress.
- Do not narrate before tool calls. Finish with a concise user-facing summary listing what changed and important file paths. Do not claim validation that the independent validator has not yet performed.`;

const TOOLS = [
  tool('locate_code', 'Search up to eight filename or text queries and return contextual source excerpts.', { queries: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['queries']),
  tool('read_files', 'Read up to eight line-ranged project files in one call.', { files: { type: 'array', maxItems: 8, items: { type: 'object', properties: { path: stringProp('Relative file path'), startLine: numberProp('First line'), endLine: numberProp('Last line') }, required: ['path'] } } }, ['files']),
  tool('create_todo_list', 'Create the visible implementation checklist before starting multi-step work. The server assigns stable IDs.', { items: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string' } } }, ['items']),
  tool('update_todo_list', 'Atomically update one or more visible todo steps. Keep at most one step in_progress.', { updates: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: { id: stringProp('Todo ID returned by create_todo_list'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }, note: stringProp('Optional concise progress or blocker note') }, required: ['id', 'status'] } } }, ['updates']),
  tool('apply_edits', 'Atomically apply up to 20 exact replacements or complete file writes. Every edit is prevalidated before any file changes.', { edits: { type: 'array', maxItems: 20, items: { type: 'object', properties: { path: stringProp('Relative file path'), mode: { type: 'string', enum: ['write', 'replace'] }, content: stringProp('Complete content for write'), search: stringProp('Exact text for replace'), replacement: stringProp('Replacement text'), all: { type: 'boolean' } }, required: ['path', 'mode'] } } }, ['edits']),
  tool('list_reference_files', 'List files in a user-authorized, read-only source workspace.', { workspace: stringProp('Exact workspace name'), path: stringProp('Relative path, default .') }, ['workspace']),
  tool('read_reference_file', 'Read text from a user-authorized, read-only source workspace.', { workspace: stringProp('Exact workspace name'), path: stringProp('Relative file path'), startLine: numberProp('First line'), endLine: numberProp('Last line') }, ['workspace', 'path']),
  tool('search_reference_files', 'Search text in a user-authorized, read-only source workspace.', { workspace: stringProp('Exact workspace name'), query: stringProp('Text to find'), path: stringProp('Relative root path') }, ['workspace', 'query']),
  tool('copy_reference_file', 'Copy one regular file byte-for-byte from a user-authorized source workspace into the active workspace. The source remains unchanged.', { workspace: stringProp('Exact workspace name'), sourcePath: stringProp('Source workspace-relative file'), destinationPath: stringProp('Active workspace-relative destination') }, ['workspace', 'sourcePath', 'destinationPath']),
  tool('run_command', 'Run a Node.js/npm project command with the file utility inside an isolated Docker container without network access. Python is not installed.', { command: stringProp('Shell command to run from /workspace') }, ['command']),
  tool('install_dependencies', 'Install project dependencies inside an isolated Docker container with temporary registry network access.', { command: stringProp('Install command, usually npm install') }),
  tool('inspect_preview', 'Build and open the current draft in a real browser, returning runtime diagnostics and a screenshot.', {}),
  tool('delegate_media_task', 'Create a persistent Media Agent job and immediately reserve valid stable placeholder paths. Use for images, video, transparent animation, music, and sound effects.', {
    kind: { type: 'string', enum: ['image', 'video', 'animation', 'music', 'sound-effect'] }, prompt: stringProp('Detailed creative brief including composition, motion, timing, or audio intent'), name: stringProp('Stable output filename stem'), transparent: { type: 'boolean' },
    startFrame: stringProp('Required workspace-relative endpoint for animation'), endFrame: stringProp('Optional final endpoint; use the same path for a seamless animation'), referenceImages: arrayProp('Workspace-relative identity or style references'), aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] }, soundEffects: stringProp('Optional synchronized sound-effect brief'), durationSeconds: numberProp('Audio duration'), musicTier: { type: 'string', enum: ['clip', 'pro'] },
  }, ['kind', 'prompt', 'name']),
  tool('remove_image_background', 'Remove a flat-color background from an existing PNG, JPEG, or WebP without regenerating the subject. Edge mode removes only matching pixels connected to an image edge; color mode removes every matching pixel.', {
    sourcePath: stringProp('Workspace-relative source image path'), name: stringProp('Short output filename stem'),
    mode: { type: 'string', enum: ['edge', 'color'] }, backgroundColor: stringProp('Optional six-digit hex background color; defaults to a representative corner color'),
    tolerance: numberProp('Per-channel color tolerance from 0 to 255; defaults to 28'), crop: { type: 'boolean', description: 'Crop transparent borders; defaults to true' }, padding: numberProp('Transparent-border crop padding in pixels'),
  }, ['sourcePath', 'name']),
  tool('extract_image_regions', 'Split distinct foreground regions in an existing sprite, symbol, icon, or object sheet into separate lossless transparent WebP assets. This is deterministic image processing, not generation.', {
    sourcePath: stringProp('Workspace-relative source image path'), outputPrefix: stringProp('Filename prefix for extracted assets'),
    backgroundColor: stringProp('Optional six-digit hex background color; defaults to a representative corner color'), tolerance: numberProp('Per-channel background tolerance from 0 to 255; defaults to 28'),
    connectivity: { type: 'number', enum: [4, 8] }, minArea: numberProp('Minimum connected foreground pixel area; defaults to 64'), padding: numberProp('Pixels of context around each region; defaults to 2'), maxRegions: numberProp('Maximum outputs from 1 to 200; defaults to 100'),
  }, ['sourcePath', 'outputPrefix']),
];
export const CODING_TOOL_NAMES = TOOLS.map((item) => item.name);
export const CODING_TOOL_DEFINITIONS = TOOLS;

interface PendingCall {
  id: string;
  name: string;
  initialArguments?: unknown;
  argumentFragments: string;
}

export interface AgentPerformance {
  interactionCount: number;
  toolCount: number;
  callsByTool: Record<string, number>;
  firstMutationMs?: number;
  tokens: { input: number; output: number; thought: number; cached: number };
  modelMs: number;
  toolMs: number;
}

export interface TaskProfile { surgical: boolean; thinkingLevel: 'low' | 'medium'; summaries: boolean }
export function classifyTask(objective: string, criteria: string[] = [], profile: WorkspaceSettings['codingAgent']['reasoningProfile'] = 'adaptive', repair = false): TaskProfile {
  const broad = /\b(debug|bug|dependency|package|media|image|animation|video|migrat|architect|reference|refactor|feature|redesign|multiple files?|across)\b/i.test(objective);
  const localized = /\b(change|replace|rename|set|update|make|color|colour|text|size|spacing|style|config)\b/i.test(objective);
  const surgical = !repair && objective.trim().length <= 300 && criteria.length <= 2 && localized && !broad;
  const thinkingLevel = repair || profile === 'balanced' || (profile === 'adaptive' && !surgical) ? 'medium' : 'low';
  return { surgical, thinkingLevel, summaries: repair };
}

export class CodingAgent {
  private client?: GoogleGenAI;
  private previousInteractionId = '';
  constructor(private readonly tools: WorkspaceTools, private readonly activity: ActivityHub) {
    if (config.geminiKey) this.client = new GoogleGenAI({ apiKey: config.geminiKey });
  }

  beginTask() { this.previousInteractionId = ''; }

  async perform(taskId: string, prompt: string, cancelled: () => boolean, settings: WorkspaceSettings, canvasImage?: string, referenceWorkspaceIds: string[] = [], options: { objective?: string; criteria?: string[]; repair?: boolean; todo?: (name: string, args: any) => Promise<any>; requireTodos?: boolean; hasTodos?: () => boolean } = {}) {
    if (!this.client) throw new Error('GEMINI_API_KEY is not configured on the server.');
    let input: any = canvasImage
      ? [{ type: 'text', text: prompt }, { type: 'image', data: canvasImage, mime_type: 'image/jpeg' }]
      : prompt;
    let finalText = ''; const startedAt = Date.now();
    const performance: AgentPerformance = { interactionCount: 0, toolCount: 0, callsByTool: {}, tokens: { input: 0, output: 0, thought: 0, cached: 0 }, modelMs: 0, toolMs: 0 };
    const profile = classifyTask(options.objective || prompt, options.criteria, settings.codingAgent.reasoningProfile, options.repair);
    for (let iteration = 0; iteration < 60; iteration++) {
      if (cancelled()) throw new Error('Task cancelled');
      const pending = new Map<number, PendingCall>();
      let interactionId = '';
      let requiresAction = false;
      let interactionText = '';
      performance.interactionCount++;
      const modelStarted = Date.now(); const stream = await (this.client as any).interactions.create({
        model: config.coderModel,
        input,
        ...(this.previousInteractionId ? { previous_interaction_id: this.previousInteractionId } : {}),
        system_instruction: systemFor(settings),
        tools: toolsFor(settings, referenceWorkspaceIds.length > 0),
        generation_config: { thinking_level: profile.thinkingLevel, thinking_summaries: profile.summaries ? 'auto' : 'none' },
        store: true,
        stream: true,
      }, { timeout: config.taskTimeoutMs });

      for await (const event of stream as AsyncIterable<any>) {
        if (cancelled()) throw new Error('Task cancelled');
        const type = event.event_type;
        if (type === 'interaction.created' || type === 'interaction.in_progress' || type === 'interaction.requires_action' || type === 'interaction.completed') {
          interactionId = event.interaction?.id || interactionId; collectUsage(performance.tokens, event.interaction?.usage || event.interaction?.usage_metadata);
        }
        if (type === 'interaction.requires_action') requiresAction = true;
        if (type === 'step.start') {
          const step = event.step || {};
          if (step.type === 'function_call') {
            pending.set(event.index, {
              id: step.id,
              name: step.name,
              initialArguments: step.arguments,
              argumentFragments: '',
            });
          }
          if (profile.summaries && step.type === 'thought' && step.summary) for (const part of step.summary) if (part.text) await this.activity.emit(taskId, 'thought_summary', 'coding', part.text);
          if (step.type === 'model_output' && step.content) for (const part of step.content) if (part.text) interactionText += part.text;
        }
        if (type === 'step.delta') {
          const delta = event.delta || {};
          if (profile.summaries && delta.type === 'thought_summary' && delta.content?.text) await this.activity.emit(taskId, 'thought_summary', 'coding', delta.content.text);
          if (delta.type === 'text' && delta.text) interactionText += delta.text;
          if (delta.type === 'arguments_delta') {
            const call = pending.get(event.index);
            if (call && typeof delta.arguments === 'string') call.argumentFragments += delta.arguments;
          }
        }
      }
      performance.modelMs += Date.now() - modelStarted;

      if (interactionId) this.previousInteractionId = interactionId;
      if (!requiresAction && !pending.size) {
        finalText = interactionText.trim(); if (finalText) await this.activity.emit(taskId, 'model_output', 'coding', finalText);
        return { summary: finalText, performance };
      }
      const parsed = [];
      for (const call of pending.values()) {
        let args: any = {};
        const serialized = call.argumentFragments || (typeof call.initialArguments === 'string' ? call.initialArguments : JSON.stringify(call.initialArguments ?? {}));
        try { args = serialized ? JSON.parse(serialized) : {}; } catch { throw new Error(`Invalid arguments from coding model for ${call.name}: ${serialized}`); }
        parsed.push({ call, args }); performance.toolCount++; performance.callsByTool[call.name] = (performance.callsByTool[call.name] || 0) + 1;
        if (performance.firstMutationMs === undefined && isMutation(call.name)) performance.firstMutationMs = Date.now() - startedAt;
      }
      const toolsStarted = Date.now(); const values = await executeCalls(parsed, async (item) => {
        try {
          if (item.call.name === 'create_todo_list' || item.call.name === 'update_todo_list') {
            if (!options.todo) throw new Error('Todo tracking is unavailable for this task.');
            return await options.todo(item.call.name, item.args);
          }
          if (options.requireTodos && isMutation(item.call.name) && !options.hasTodos?.()) throw new Error('Create the approved plan todo list before the first workspace mutation.');
          return await this.tools.execute(taskId, item.call.name, item.args, cancelled, settings.codingAgent, referenceWorkspaceIds);
        } catch (error) {
          const message = (error as Error).message; await this.activity.emit(taskId, 'error', 'coding', `${item.call.name}: ${message}`); return { ok: false, error: message };
        }
      }); performance.toolMs += Date.now() - toolsStarted;
      const results = [];
      for (let index = 0; index < parsed.length; index++) {
        const { call } = parsed[index]; const value = values[index];
        const blocks: any[] = [{ type: 'text', text: JSON.stringify({ ...value, screenshotBase64: undefined }) }];
        if (value?.screenshotBase64) blocks.push({ type: 'image', mime_type: 'image/jpeg', data: value.screenshotBase64 });
        results.push({ type: 'function_result', name: call.name, call_id: call.id, result: blocks });
      }
      input = results;
    }
    throw new Error('Coding agent exceeded the 60-step tool limit.');
  }
}

function tool(name: string, description: string, properties: Record<string, any>, required: string[] = []) { return { type: 'function', name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }; }
function stringProp(description: string) { return { type: 'string', description }; }
function numberProp(description: string) { return { type: 'number', description }; }
function arrayProp(description: string) { return { type: 'array', description, items: { type: 'string' } }; }

function toolsFor(settings: WorkspaceSettings, references: boolean) {
  return TOOLS.filter((item) => {
    if (settings.codingAgent.dependencies === 'existing-only' && item.name === 'install_dependencies') return false;
    if (!settings.codingAgent.mediaGeneration && item.name === 'delegate_media_task') return false;
    if (settings.codingAgent.validation !== 'standard' && item.name === 'inspect_preview') return false;
    if (!references && item.name.includes('reference_')) return false;
    return true;
  });
}

function systemFor(settings: WorkspaceSettings) {
  const mode = settings.mode === 'canvas'
    ? 'Canvas mode is strict for all new visible work. Draw UI, text, generated media, and animation as layers in one primary HTML5 canvas marked data-cowork-canvas-primary. Do not add visible DOM overlays. Expose window.coworkCanvas with getPrimaryCanvas(), hitTest({x,y}), and getLayer(id); layer bounds use canvas backing-store coordinates, layer IDs are stable, and dispatch cowork:canvas-adapter-ready after registration. DOM is allowed only for the canvas host and nonvisual accessibility support.'
    : settings.mode === 'dom'
      ? 'DOM mode is active. Build new visible work with semantic HTML and CSS, use stable data-cowork-id attributes, and avoid introducing canvas rendering unless the user explicitly changes workspace mode.'
      : 'Mixed mode is active. Use semantic DOM for ordinary layout, text, forms, and controls; use HTML5 canvas for spatial or frame-driven content. Any canvas layers must use a data-cowork-canvas-primary canvas and the window.coworkCanvas adapter contract with stable layer IDs.';
  const dependencies = settings.codingAgent.dependencies === 'existing-only' ? 'Do not add, remove, or change package dependencies.' : 'New dependencies are allowed when materially useful.';
  const media = settings.codingAgent.mediaGeneration
    ? 'Media generation is enabled. Delegate requested generated media to the Media Agent with delegate_media_task.'
    : 'Do not generate new images or animations; reuse existing assets.';
  const validation = `The independent validator owns routine verification in ${settings.codingAgent.validation} mode. Do not run tests, builds, linters, typechecks, or final preview inspection.`;
  return `${BASE_SYSTEM}\n\nActive workspace settings:\n- ${mode}\n- ${dependencies}\n- ${media}\n- ${validation}`;
}

const READ_ONLY = new Set(['locate_code', 'read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files']);
function isMutation(name: string) { return ['apply_edits', 'copy_reference_file', 'run_command', 'install_dependencies', 'delegate_media_task', 'remove_image_background', 'extract_image_regions'].includes(name); }
export async function executeCalls<T extends { call: { name: string } }, R>(items: T[], execute: (item: T) => Promise<R>) {
  const output: R[] = new Array(items.length); let index = 0;
  while (index < items.length) {
    if (!READ_ONLY.has(items[index].call.name)) { output[index] = await execute(items[index]); index++; continue; }
    let end = index + 1; while (end < items.length && READ_ONLY.has(items[end].call.name)) end++;
    const values = await Promise.all(items.slice(index, end).map(execute)); values.forEach((value, offset) => { output[index + offset] = value; }); index = end;
  }
  return output;
}
function collectUsage(target: AgentPerformance['tokens'], usage: any) {
  if (!usage) return;
  target.input = Math.max(target.input, Number(usage.input_tokens ?? usage.prompt_token_count ?? usage.inputTokenCount ?? 0));
  target.output = Math.max(target.output, Number(usage.output_tokens ?? usage.candidates_token_count ?? usage.outputTokenCount ?? 0));
  target.thought = Math.max(target.thought, Number(usage.thought_tokens ?? usage.thoughts_token_count ?? usage.thoughtsTokenCount ?? 0));
  target.cached = Math.max(target.cached, Number(usage.cached_tokens ?? usage.cached_content_token_count ?? usage.cachedContentTokenCount ?? 0));
}
