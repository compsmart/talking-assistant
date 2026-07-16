import { GoogleGenAI } from '@google/genai';
import type { ActivityHub } from '../activity.js';
import { config } from '../config.js';
import type { WorkspaceTools } from '../workspace/WorkspaceTools.js';
import type { AgentStage, MediaJobKind, WorkspaceSettings } from '../../shared/protocol.js';
import { BUILTIN_AGENT_TOOLS, ToolCatalog } from '../agents/ToolCatalog.js';
import { ToolBroker } from '../agents/ToolBroker.js';

export const CODING_AGENT_SYSTEM = `You are the only coding subagent in a local cowork application. Work autonomously and make production-quality changes inside the generated project workspace.

Workspace contract:
- You may edit only files exposed by the workspace tools. Never attempt to access the cowork shell, host, secrets, Docker socket, or parent directories.
- The visible workspace is an ordinary web application. It must listen on 0.0.0.0:4173 when npm start runs and answer GET /health with HTTP 200.
- Keep package scripts for start, build, and test. You may implement both frontend and backend code inside this project.
- The command environment is Node.js and npm. Prefer Node.js scripts and npm tooling for project inspection and automation. Python is not installed; do not invoke python or python3 or introduce Python tooling.
- Inspect existing files before editing. Prefer focused replacements or full-file writes when the resulting file is clear.
- When the prompt includes a selected DOM element, use its exact text, attributes, and selector to search for the owning source first. For a surgical text or style request, do not list and read the whole repository.
- Preserve existing data-cowork-id attributes. Every newly created user-visible semantic DOM element must have a concise, unique, stable data-cowork-id in source, including headings, text blocks, images, cards, list items, form controls, buttons, links, regions, and media containers. Purely decorative nested spans or SVG path primitives may remain untagged. Never generate duplicate data-cowork-id values.
- Use install_dependencies only when package dependencies changed. The independent validator owns routine tests, builds, and final preview inspection; do not run them yourself.
- Keep the workspace HTML5 canvas distinct from raster media. A request to change a canvas, Canvas workspace, or selected semantic canvas layer is a request to edit the workspace implementation. Never delegate media merely because the task mentions canvas; delegate only when the user explicitly requests a new image or other media asset.
- Delegate AI-created images, video, animation, music, and sound effects to delegate_media_task. It immediately returns stable placeholder paths. For a standalone media request, create the media job and do not edit application files, add a gallery or preview, or place the asset in HTML, CSS, JavaScript, or an HTML5 canvas. Integrate a returned media path only when the user explicitly asked to place or use the asset in the application. Never substitute hand-coded drawings for requested generated media.
- Animation requires an explicit startFrame. For a seamless animation, use the same workspace-relative image as startFrame and endFrame. The Media Agent owns endpoint geometry, alpha, timing, audio, inspection, and encoding.
- Generated assets are organized under assets/generated. A transparent animation is always a four-second, 48-frame, 12 FPS WebP and may include a synchronized MP3 sidecar. Ensure the project serves these formats correctly.
- Use remove_image_background to transform an existing opaque image; when generating a new transparent subject, use delegate_media_task with kind image and transparent true instead. Use extract_image_regions to split an existing sprite, symbol, icon, or object sheet into separate transparent assets. Processed outputs are organized under assets/processed. Prefer these tools over installing image libraries or writing disposable processing scripts.
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
  tool('run_node_script', 'Run an existing user-defined Node.js utility beneath scripts/ in the resource-limited, network-disabled workspace sandbox. Arguments are passed literally; do not construct a shell command.', { script: stringProp('Workspace-relative scripts/*.js, *.mjs, or *.cjs path'), args: arrayProp('Literal command arguments') }, ['script']),
  tool('image.inspect', 'Inspect a workspace image and return its dimensions, format, channels, and a bounded visual preview.', { path: stringProp('Workspace-relative PNG, JPEG, or WebP path') }, ['path']),
  tool('project.run_tests', 'Run only the test script declared by the workspace package.json.', {}),
  tool('project.run_build', 'Run only the build script declared by the workspace package.json.', {}),
  tool('project.run_typecheck', 'Run only the typecheck script declared by the workspace package.json.', {}),
  tool('project.run_lint', 'Run only the lint script declared by the workspace package.json.', {}),
  tool('package.lookup', 'Read bounded metadata for one package from the public npm registry. This never installs packages.', { name: stringProp('Exact npm package name') }, ['name']),
  tool('workspace.http_request', 'Send an HTTP request only to the active workspace preview.', { path: stringProp('Preview-relative URL path'), method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, body: stringProp('Optional request body') }, ['path']),
  tool('calculate', 'Evaluate a bounded arithmetic expression with an allowlisted parser; no JavaScript evaluation.', { expression: stringProp('Arithmetic expression using numbers, parentheses, +, -, *, /, %, and ^') }, ['expression']),
  tool('datetime', 'Parse, format, or offset an ISO date and time.', { value: stringProp('ISO date; defaults to the current time'), addMilliseconds: numberProp('Signed offset in milliseconds'), timeZone: stringProp('IANA time zone for formatting') }),
  tool('regex.test', 'Test a bounded regular expression in a disposable worker with a hard timeout.', { pattern: stringProp('Regular expression source'), input: stringProp('Input text'), flags: stringProp('Optional flags') }, ['pattern', 'input']),
  tool('content.hash', 'Hash bounded text content.', { content: stringProp('Text content'), algorithm: { type: 'string', enum: ['sha256', 'sha512'] } }, ['content']),
  tool('install_dependencies', 'Install project dependencies inside an isolated Docker container with temporary registry network access.', { command: stringProp('Install command, usually npm install') }),
  tool('inspect_preview', 'Build and open the current draft in a real browser, returning runtime diagnostics and a screenshot.', {}),
  tool('delegate_media_task', 'Create a persistent Media Agent job and immediately reserve valid stable placeholder paths. Use only for an explicit request for a new image, video, transparent animation, music, or sound-effect asset; never use it to modify a workspace HTML5 canvas.', {
    kind: { type: 'string', enum: ['image', 'video', 'animation', 'music', 'sound-effect'] }, prompt: stringProp('Detailed creative brief including composition, motion, timing, or audio intent'), name: stringProp('Stable output filename stem'), transparent: { type: 'boolean' },
    startFrame: stringProp('Required workspace-relative endpoint for animation'), endFrame: stringProp('Optional final endpoint; use the same path for a seamless animation'), referenceImages: arrayProp('Workspace-relative identity or style references'), aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] }, soundEffects: stringProp('Optional synchronized sound-effect brief'), durationSeconds: numberProp('Audio duration'), musicTier: { type: 'string', enum: ['clip', 'pro'] },
  }, ['kind', 'prompt', 'name']),
  tool('remove_image_background', 'Remove a flat-color background from an existing PNG, JPEG, or WebP without regenerating the subject. Edge mode removes only matching pixels connected to an image edge; color mode removes every matching pixel.', {
    sourcePath: stringProp('Workspace-relative source image path'), name: stringProp('Short output filename stem'),
    mode: { type: 'string', enum: ['edge', 'color'] }, backgroundColor: stringProp('Optional six-digit hex background color; defaults to a representative corner color'),
    tolerance: numberProp('Per-channel color tolerance from 0 to 255; defaults to 28'), crop: { type: 'boolean', description: 'Crop transparent borders; defaults to true' }, padding: numberProp('Transparent-border crop padding in pixels'),
  }, ['sourcePath', 'name']),
  tool('extract_image_regions', 'Split visual foreground regions in an existing sprite, symbol, icon, or object sheet into separate lossless transparent WebP assets. Nearby detached pieces such as sparkles, letters, and highlights are grouped into one asset. This is deterministic image processing, not generation.', {
    sourcePath: stringProp('Workspace-relative source image path'), outputPrefix: stringProp('Filename prefix for extracted assets'),
    backgroundColor: stringProp('Optional six-digit hex background color; defaults to a representative corner color'), tolerance: numberProp('Per-channel background tolerance from 0 to 255; defaults to 28'),
    connectivity: { type: 'number', enum: [4, 8] }, minArea: numberProp('Minimum connected foreground pixel area; defaults to 64'), mergeGap: numberProp('Maximum pixel gap for grouping detached pieces of one visual region; defaults to 2% of the shorter image side'), padding: numberProp('Pixels of context around each region; defaults to 2'), maxRegions: numberProp('Maximum outputs from 1 to 200; defaults to 100'),
  }, ['sourcePath', 'outputPrefix']),
];
const MEDIA_TOOL_KINDS = Object.fromEntries(BUILTIN_AGENT_TOOLS
  .filter((item) => item.runtimeToolId === 'delegate_media_task' && typeof item.fixedArguments?.kind === 'string')
  .map((item) => [item.id, item.fixedArguments!.kind as MediaJobKind])) as Record<string, MediaJobKind>;
export const CODING_TOOL_NAMES = TOOLS.map((item) => item.name);
export const CODING_TOOL_DEFINITIONS = TOOLS;
const TOOL_BROKER = new ToolBroker(new ToolCatalog(), TOOLS as any);

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
export interface AgentRuntimeProfile {
  id: string;
  name: string;
  revision: number;
  stage?: AgentStage;
  modelId?: string;
  instructions?: string;
  enabledToolIds?: string[];
  modelReadableSecrets?: Array<{ id: string; name: string; kind: string }>;
  readSecret?: (id: string) => Promise<string>;
}
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

  async perform(taskId: string, prompt: string, cancelled: () => boolean, settings: WorkspaceSettings, canvasImage?: string, referenceWorkspaceIds: string[] = [], options: { objective?: string; criteria?: string[]; repair?: boolean; todo?: (name: string, args: any) => Promise<any>; requireTodos?: boolean; hasTodos?: () => boolean; agent?: AgentRuntimeProfile } = {}) {
    if (!this.client) throw new Error('GEMINI_API_KEY is not configured on the server.');
    if (options.agent?.modelReadableSecrets?.length) return this.performStateless(taskId, prompt, cancelled, settings, canvasImage, referenceWorkspaceIds, options);
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
        model: options.agent?.modelId || config.coderModel,
        input,
        ...(this.previousInteractionId ? { previous_interaction_id: this.previousInteractionId } : {}),
        system_instruction: systemFor(settings, options.agent),
        tools: toolsFor(settings, referenceWorkspaceIds.length > 0, options.agent),
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
          assertToolPermission(options.agent, item.call.name, item.args);
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

  private async performStateless(taskId: string, prompt: string, cancelled: () => boolean, settings: WorkspaceSettings, canvasImage: string | undefined, referenceWorkspaceIds: string[], options: { objective?: string; criteria?: string[]; repair?: boolean; todo?: (name: string, args: any) => Promise<any>; requireTodos?: boolean; hasTodos?: () => boolean; agent?: AgentRuntimeProfile }) {
    const agent = options.agent!; const profile = classifyTask(options.objective || prompt, options.criteria, settings.codingAgent.reasoningProfile, options.repair);
    const content: any[] = [{ type: 'text', text: prompt }]; if (canvasImage) content.push({ type: 'image', data: canvasImage, mime_type: 'image/jpeg' });
    const history: any[] = [{ type: 'user_input', content }]; const disclosed: string[] = [];
    const performance: AgentPerformance = { interactionCount: 0, toolCount: 0, callsByTool: {}, tokens: { input: 0, output: 0, thought: 0, cached: 0 }, modelMs: 0, toolMs: 0 };
    const secretTool = tool('read_secret', 'Read one explicitly authorized model-readable credential on demand. Use only when the assignment requires it.', { secretId: stringProp('Authorized secret ID') }, ['secretId']);
    for (let iteration = 0; iteration < 60; iteration++) {
      if (cancelled()) throw new Error('Task cancelled'); const modelStarted = Date.now(); performance.interactionCount++;
      const interaction: any = await (this.client as any).interactions.create({
        model: agent.modelId || config.coderModel, input: history, system_instruction: systemFor(settings, agent),
        tools: [...toolsFor(settings, referenceWorkspaceIds.length > 0, agent), secretTool],
        generation_config: { thinking_level: profile.thinkingLevel, thinking_summaries: profile.summaries ? 'auto' : 'none' }, store: false,
      }, { timeout: config.taskTimeoutMs });
      performance.modelMs += Date.now() - modelStarted; collectUsage(performance.tokens, interaction.usage || interaction.usage_metadata);
      const steps = Array.isArray(interaction.steps) ? interaction.steps : []; history.push(...steps);
      for (const step of steps) {
        if (step.type === 'thought' && profile.summaries) for (const part of step.summary || []) if (part.text) await this.activity.emit(taskId, 'thought_summary', 'coding', redactText(part.text, disclosed));
      }
      const calls = steps.filter((step: any) => step.type === 'function_call');
      if (!calls.length) {
        const summary = steps.filter((step: any) => step.type === 'model_output').flatMap((step: any) => step.content || []).map((part: any) => part.text || '').join('').trim();
        if (summary) await this.activity.emit(taskId, 'model_output', 'coding', redactText(summary, disclosed));
        return { summary: redactText(summary, disclosed), performance };
      }
      const toolsStarted = Date.now(); const results: any[] = [];
      for (const call of calls) {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments || {};
        performance.toolCount++; performance.callsByTool[call.name] = (performance.callsByTool[call.name] || 0) + 1;
        try {
          let value: any;
          if (call.name === 'read_secret') {
            const secretId = String(args.secretId || ''); const authorized = agent.modelReadableSecrets!.find((secret) => secret.id === secretId);
            if (!authorized || !agent.readSecret) throw new Error('That secret is not authorized for this agent.');
            value = await agent.readSecret(secretId); disclosed.push(value);
          } else if (call.name === 'create_todo_list' || call.name === 'update_todo_list') {
            assertToolPermission(agent, call.name, args);
            if (!options.todo) throw new Error('Todo tracking is unavailable for this task.'); value = await options.todo(call.name, args);
          } else {
            if (options.requireTodos && isMutation(call.name) && !options.hasTodos?.()) throw new Error('Create the approved plan todo list before the first workspace mutation.');
            assertToolPermission(agent, call.name, args);
            value = await this.tools.execute(taskId, call.name, args, cancelled, settings.codingAgent, referenceWorkspaceIds, 'coding', disclosed);
          }
          results.push({ type: 'function_result', name: call.name, call_id: call.id, result: [{ type: 'text', text: String(value && typeof value === 'object' ? JSON.stringify({ ...value, screenshotBase64: undefined }) : value) }] });
        } catch (error) {
          const message = redactText((error as Error).message, disclosed); if (call.name !== 'read_secret') await this.activity.emit(taskId, 'error', 'coding', `${call.name}: ${message}`);
          results.push({ type: 'function_result', name: call.name, call_id: call.id, result: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }] });
        }
      }
      performance.toolMs += Date.now() - toolsStarted; history.push(...results);
    }
    throw new Error('Coding agent exceeded the 60-step tool limit.');
  }
}

function tool(name: string, description: string, properties: Record<string, any>, required: string[] = []) { return { type: 'function', name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }; }
function stringProp(description: string) { return { type: 'string', description }; }
function numberProp(description: string) { return { type: 'number', description }; }
function arrayProp(description: string) { return { type: 'array', description, items: { type: 'string' } }; }

export function toolsFor(settings: WorkspaceSettings, references: boolean, agent?: AgentRuntimeProfile) {
  return TOOL_BROKER.compile({ stage: agent?.stage || 'coder', grantedToolIds: agent?.enabledToolIds }).flatMap((item) => {
    if (item.name === 'delegate_media_task' && !settings.codingAgent.mediaGeneration) return [];
    if (settings.codingAgent.dependencies === 'existing-only' && item.name === 'install_dependencies') return [];
    if (settings.codingAgent.validation !== 'standard' && item.name === 'inspect_preview') return [];
    if (!references && item.name.includes('reference_')) return [];
    return [item];
  });
}

function allowedMediaKinds(agent?: AgentRuntimeProfile): MediaJobKind[] {
  const all = Object.values(MEDIA_TOOL_KINDS);
  if (agent?.enabledToolIds === undefined || agent.enabledToolIds.includes('delegate_media_task')) return all;
  const grants = new Set(agent.enabledToolIds);
  return Object.entries(MEDIA_TOOL_KINDS).flatMap(([id, kind]) => grants.has(id) ? [kind] : []);
}

export function assertToolPermission(agent: AgentRuntimeProfile | undefined, name: string, args: any) {
  TOOL_BROKER.authorize({ stage: agent?.stage || 'coder', grantedToolIds: agent?.enabledToolIds }, name, args);
}

function systemFor(settings: WorkspaceSettings, agent?: AgentRuntimeProfile) {
  const mode = settings.mode === 'canvas'
    ? 'Canvas mode is strict for all new visible work. Draw UI, text, generated media, and animation as layers in one primary HTML5 canvas marked data-cowork-canvas-primary. Do not add visible DOM overlays. Expose window.coworkCanvas with getPrimaryCanvas(), hitTest({x,y}), and getLayer(id); layer bounds use canvas backing-store coordinates, layer IDs are stable, and dispatch cowork:canvas-adapter-ready after registration. DOM is allowed only for the canvas host and nonvisual accessibility support.'
    : settings.mode === 'dom'
      ? 'DOM mode is active. Build new visible work with semantic HTML and CSS, use stable data-cowork-id attributes, and avoid introducing canvas rendering unless the user explicitly changes workspace mode.'
      : 'Mixed mode is active. Use semantic DOM for ordinary layout, text, forms, and controls; use HTML5 canvas for spatial or frame-driven content. Any canvas layers must use a data-cowork-canvas-primary canvas and the window.coworkCanvas adapter contract with stable layer IDs.';
  const dependencies = settings.codingAgent.dependencies === 'existing-only' ? 'Do not add, remove, or change package dependencies.' : 'New dependencies are allowed when materially useful.';
  const media = settings.codingAgent.mediaGeneration
    ? 'Media generation is enabled. Delegate explicitly requested new media assets to the Media Agent with delegate_media_task. A media-only request authorizes creation of the asset, not edits that display or integrate it in the application. Never treat a workspace canvas change as media generation.'
    : 'Do not generate new images or animations; reuse existing assets.';
  const validation = `The independent validator owns routine verification in ${settings.codingAgent.validation} mode. Do not run tests, builds, linters, typechecks, or final preview inspection.`;
  const custom = agent?.instructions?.trim() ? `\n\nConfigured worker identity: ${agent.name}\nAdditional instructions:\n${agent.instructions.trim()}` : '';
  const base = agent?.stage === 'media'
    ? `You are the configured Media Agent in a local cowork application. Own standalone image, sprite, symbol, video, animation, music, audio, and sound-effect work. Follow assigned skill instructions exactly. Use only the granted media and inspection tools. Do not edit application source, place assets into pages or HTML5 canvases, or invent code-integration work. Generated and processed outputs belong under assets/generated or assets/processed. When a skill names an existing script under scripts/, use run_node_script with literal arguments. Inspect relevant inputs before acting, verify outputs as far as the granted tools allow, and report durable workspace-relative paths.\n\nPython is unavailable; use the checked-in Node utilities. A media job returning a stable path may still be processing asynchronously, so report its job state accurately.`
    : CODING_AGENT_SYSTEM;
  return `${base}\n\nActive workspace settings:\n- ${mode}\n- ${dependencies}\n- ${media}\n- ${validation}${custom}`;
}

const READ_ONLY = new Set(['locate_code', 'read_files', 'list_reference_files', 'read_reference_file', 'search_reference_files']);
function isMutation(name: string) { return ['apply_edits', 'copy_reference_file', 'run_command', 'run_node_script', 'install_dependencies', 'delegate_media_task', 'remove_image_background', 'extract_image_regions'].includes(name); }
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
function redactText(value: string, secrets: readonly string[]) { return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value)); }
