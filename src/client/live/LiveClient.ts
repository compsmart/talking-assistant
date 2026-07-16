export interface LiveFunctionCall { id: string; name: string; args?: Record<string, unknown> }
export type LiveStatus = 'offline' | 'connecting' | 'ready' | 'closed' | 'error';
const MUTATING_TOOLS = new Set(['submit_work', 'update_work', 'cancel_work', 'approve_work_plan', 'answer_work_question', 'delegate_coding_task', 'create_implementation_plan', 'execute_implementation_plan', 'respond_to_planning_continuation', 'generate_image_asset', 'copy_reference_workspace_file', 'edit_workspace_files']);

const FUNCTION_DECLARATIONS = [
  {
    name: 'submit_work',
    description: 'Delegate substantial or multi-file work to your internal orchestration layer. Do not use this for a small localized one-file edit when edit_workspace_files is available. Returns immediately after acceptance or duplicate detection while you remain available for conversation.',
    parameters: { type: 'OBJECT', properties: {
      strategy: { type: 'STRING', enum: ['auto', 'direct', 'plan_first', 'plan_only'], description: 'Use auto for implementation. Use plan_first or plan_only only when the user explicitly requests planning.' },
      objective: { type: 'STRING', description: 'Precise intended outcome.' }, successCriteria: { type: 'ARRAY', items: { type: 'STRING' } },
      useSelectedElement: { type: 'BOOLEAN' }, includeWorkspacePreview: { type: 'BOOLEAN', description: 'Attach the current rendered workspace preview when broader visual context materially helps implementation.' },
      preferredAgentId: { type: 'STRING', description: 'Optional exact configured agent ID, only when the user explicitly selects an agent.' },
      dedupeMode: { type: 'STRING', enum: ['auto', 'force'], description: 'Use force only when the user explicitly wants a separate duplicate task.' },
    }, required: ['objective'] },
  },
  {
    name: 'update_work', description: 'Add context, correct a detail, or replace the direction of an existing queued or running task.',
    parameters: { type: 'OBJECT', properties: { taskId: { type: 'STRING' }, change: { type: 'STRING' }, successCriteria: { type: 'ARRAY', items: { type: 'STRING' } }, mode: { type: 'STRING', enum: ['append', 'correct', 'replace'] }, expectedRevision: { type: 'NUMBER' } }, required: ['taskId', 'change', 'mode'] },
  },
  { name: 'cancel_work', description: 'Cancel one exact queued or running task because the user changed their mind.', parameters: { type: 'OBJECT', properties: { taskId: { type: 'STRING' } }, required: ['taskId'] } },
  { name: 'get_work_status', description: 'List durable queued, active, waiting, and recently completed work, including worker attempts.', parameters: { type: 'OBJECT', properties: { taskId: { type: 'STRING' } } } },
  { name: 'approve_work_plan', description: 'Approve the reviewed plan attached to an exact work item.', parameters: { type: 'OBJECT', properties: { taskId: { type: 'STRING' }, path: { type: 'STRING' }, hash: { type: 'STRING' } }, required: ['taskId', 'path'] } },
  { name: 'answer_work_question', description: 'Answer a question raised by one exact work item.', parameters: { type: 'OBJECT', properties: { taskId: { type: 'STRING' }, questionId: { type: 'STRING' }, answer: { type: 'STRING' } }, required: ['taskId', 'questionId', 'answer'] } },
  {
    name: 'set_expression',
    description: 'Briefly show a facial expression matching the emotional tone of the response.',
    parameters: { type: 'OBJECT', properties: { expression: { type: 'STRING', enum: ['neutral', 'happy', 'sad', 'angry', 'surprised', 'skeptical', 'thinking', 'fear'] } }, required: ['expression'] },
  },
  {
    name: 'play_gesture',
    description: 'Play a subtle head gesture while speaking.',
    parameters: { type: 'OBJECT', properties: { gesture: { type: 'STRING', enum: ['nod', 'shake', 'tilt_left', 'tilt_right'] } }, required: ['gesture'] },
  },
  {
    name: 'open_ui_component',
    description: 'Open a shell UI component for the user. Use file_manager for workspace files and image_editor only for static raster-image composition. Never open image_editor to modify the workspace HTML5 canvas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        component: { type: 'STRING', enum: ['file_manager', 'image_editor'] },
        params: {
          type: 'OBJECT', properties: {
            revealPath: { type: 'STRING', description: 'For file_manager, a workspace-relative file to reveal.' },
            selectPaths: { type: 'ARRAY', items: { type: 'STRING' }, description: 'For file_manager, paths to add to agent context.' },
            addPaths: { type: 'ARRAY', items: { type: 'STRING' }, description: 'For image_editor, workspace image paths to insert.' },
            tool: { type: 'STRING', enum: ['select', 'pan', 'brush', 'eraser', 'picker', 'magic'], description: 'For image_editor, the editing tool to activate.' },
          },
        },
      }, required: ['component'],
    },
  },
  {
    name: 'generate_image_asset',
    description: 'Generate one new static WebP raster asset and place it in the Image Editor. Use only when the user explicitly requests a new image asset; never use it for a workspace HTML5 canvas change or an ambiguous mention of canvas. This opens the Image Editor and blocks until generation finishes.',
    parameters: {
      type: 'OBJECT', properties: {
        prompt: { type: 'STRING', description: 'Detailed image prompt.' },
        name: { type: 'STRING', description: 'Short output filename stem.' },
        transparent: { type: 'BOOLEAN', description: 'Remove a generated green-screen background.' },
        referenceImages: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Up to fourteen workspace-relative reference image paths.' },
        aspectRatio: { type: 'STRING', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        placement: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, width: { type: 'NUMBER' } }, description: 'Optional top-left position and width in the 1024 by 768 Image Editor coordinate space.' },
      }, required: ['prompt', 'name'],
    },
  },
  {
    name: 'delegate_coding_task',
    description: 'Start a focused implementation task with the coding agent. Returns as soon as the task is accepted; use get_agent_run_status for progress.',
    parameters: {
      type: 'OBJECT',
      properties: {
        objective: { type: 'STRING', description: 'A precise description of the requested workspace change.' },
        successCriteria: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Observable conditions that must be true when finished.' },
        useSelectedElement: { type: 'BOOLEAN', description: 'Use the DOM element or canvas layer currently selected by the user. Defaults to true when a selection exists.' },
        includeWorkspacePreview: { type: 'BOOLEAN', description: 'Attach the current rendered workspace preview to the coding agent. Use only when visual layout, styling, or spatial context is important; omit for simple text or logic edits.' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'create_implementation_plan',
    description: 'Start the read-only planning agent only when the user explicitly requests a plan or reviewed plan-first workflow. The resulting Markdown plan opens for user review and must be approved before coding.',
    parameters: {
      type: 'OBJECT', properties: {
        objective: { type: 'STRING', description: 'A precise description of the requested workspace change.' },
        successCriteria: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Observable conditions the plan and implementation must satisfy.' },
        useSelectedElement: { type: 'BOOLEAN', description: 'Include the currently selected DOM element or canvas layer.' },
        includeWorkspacePreview: { type: 'BOOLEAN', description: 'Record that the current rendered workspace preview matters to the implementation.' },
      }, required: ['objective'],
    },
  },
  {
    name: 'execute_implementation_plan',
    description: 'Execute a reviewed plan by its workspace-relative plans/*.md path. Returns immediately after the coding task is accepted.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Reviewed Markdown plan path beneath plans/.' } }, required: ['path'] },
  },
  {
    name: 'respond_to_planning_continuation',
    description: 'Resume or stop the exact planning run that is waiting after a timeout or 80-interaction segment. Call only after the user explicitly answers the continuation prompt.',
    parameters: { type: 'OBJECT', properties: { runId: { type: 'STRING', description: 'The waiting planning run ID.' }, continue: { type: 'BOOLEAN', description: 'True to resume with preserved context; false to stop it.' } }, required: ['runId', 'continue'] },
  },
  {
    name: 'get_agent_run_status',
    description: 'Return the active planning or coding run, including coding todos and progress. This never starts or changes work.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_coding_task_status',
    description: 'Compatibility alias for get_agent_run_status.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_selected_element_context',
    description: 'Return the selected workspace DOM element or semantic canvas layer, including its stable identifier and bounds.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_workspace_settings',
    description: 'Return the active workspace rendering mode, vision, validation, and agent restriction settings.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'capture_selected_element_image',
    description: 'Capture a tightly cropped image containing the currently selected workspace element and stream it into your image input. Use when appearance, layout, color, spacing, or surrounding visual context matters.',
    parameters: { type: 'OBJECT', properties: { padding: { type: 'NUMBER', description: 'Extra pixels of surrounding context, from 0 to 160. Defaults to 24.' } } },
  },
  {
    name: 'get_selected_files_context',
    description: 'Return the workspace files selected by the user. Use this whenever the user refers to selected files, an uploaded image, or a reference image.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'list_workspace_files',
    description: 'List immediate files and directories inside a workspace path.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Workspace-relative directory; defaults to the project root.' } } },
  },
  {
    name: 'search_workspace_files',
    description: 'Search workspace filenames and text content.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['query'] },
  },
  {
    name: 'read_workspace_file',
    description: 'Read a UTF-8 workspace text file.',
    parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
  },
  {
    name: 'list_reference_workspace_files',
    description: 'List files in another workspace only when the current user request explicitly named it.',
    parameters: { type: 'OBJECT', properties: { workspace: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['workspace'] },
  },
  {
    name: 'search_reference_workspace_files',
    description: 'Search another workspace read-only when the current user request explicitly named it.',
    parameters: { type: 'OBJECT', properties: { workspace: { type: 'STRING' }, query: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['workspace', 'query'] },
  },
  {
    name: 'read_reference_workspace_file',
    description: 'Read a UTF-8 file in another workspace only when the current user request explicitly named it.',
    parameters: { type: 'OBJECT', properties: { workspace: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['workspace', 'path'] },
  },
  {
    name: 'copy_reference_workspace_file',
    description: 'Copy one file from an explicitly named source workspace into the active workspace without modifying the source.',
    parameters: { type: 'OBJECT', properties: { workspace: { type: 'STRING' }, sourcePath: { type: 'STRING' }, destinationPath: { type: 'STRING' } }, required: ['workspace', 'sourcePath', 'destinationPath'] },
  },
  {
    name: 'edit_workspace_files',
    description: 'Fast path for a small localized one-file code, text, configuration, or style change. Atomically write or exactly replace text, then publish without the coding-agent test pipeline. Use full content for mode write; use search and replacement for mode replace.',
    parameters: { type: 'OBJECT', properties: { edits: { type: 'ARRAY', items: { type: 'OBJECT', properties: { path: { type: 'STRING' }, mode: { type: 'STRING', enum: ['write', 'replace'] }, content: { type: 'STRING' }, search: { type: 'STRING' }, replacement: { type: 'STRING' }, all: { type: 'BOOLEAN' } }, required: ['path', 'mode'] } } }, required: ['edits'] },
  },
] as any[];

function liveTools(settings: WorkspaceSettings) { return [{ functionDeclarations: FUNCTION_DECLARATIONS.filter((tool) => {
  if (!settings.liveAgent.directFileEdits && ['edit_workspace_files', 'copy_reference_workspace_file'].includes(tool.name)) return false;
  if (!settings.codingAgent.mediaGeneration && tool.name === 'generate_image_asset') return false;
  return true;
}) }]; }

export function liveSetup(settings: WorkspaceSettings, assistant: AssistantSettings, sessionHandle = '', catalog?: WorkspaceCatalog) {
  return {
    model: 'models/gemini-3.1-flash-live-preview',
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: assistant.voice } } } },
    systemInstruction: { parts: [{ text: systemPrompt(settings, assistant, catalog) }] },
    outputAudioTranscription: {}, inputAudioTranscription: {}, contextWindowCompression: { slidingWindow: {} },
    sessionResumption: sessionHandle ? { handle: sessionHandle } : {}, tools: liveTools(settings),
  };
}

export function systemPrompt(settings: WorkspaceSettings, assistant: AssistantSettings, catalog?: WorkspaceCatalog) {
  const delegationRule = 'Delegate substantial work with submit_work. ';
  const mode = settings.mode === 'canvas'
    ? 'Canvas mode is active. Continuous vision contains only the primary HTML5 canvas and user selections are semantic canvas layers.'
    : settings.mode === 'dom'
      ? 'DOM mode is active. Continuous vision contains the complete rendered page, but user selections are DOM elements only.'
      : 'Mixed mode is active. Continuous vision contains the complete rendered page and selections may be DOM elements or semantic canvas layers.';
  const edits = settings.liveAgent.directFileEdits ? 'For any small, localized one-file code, text, style, or configuration change, locate and read the target, then use one atomic edit_workspace_files call. Make the edit immediately and publish the workspace; do not submit it to the durable agent pipeline, create a plan, or request tests or validation.' : 'Direct file editing is disabled; use the coding workflow for mutations. Use planning only when the user explicitly requests it.';
  const workspaceContext = catalog ? ` The active workspace is ${catalog.workspaces.find((item) => item.active)?.name}. Other known workspace names are: ${catalog.workspaces.filter((item) => !item.active).map((item) => item.name).join(', ') || 'none'}. Other workspace files are available only when the current user request explicitly names that workspace.` : '';
  const base = `You are the live cowork agent represented by a floating talking wireframe head. ${mode}${workspaceContext} You receive an authoritative persisted-workspace image on connect and continuous frames when vision is enabled. Be concise, warm, and practical. A user may select a rendered element or workspace files. Call get_selected_element_context when they refer to a selected DOM element or canvas layer. Call get_selected_files_context for selected files, uploads, media, or reference images. You can list, search, and read workspace files. Keep these surfaces distinct: “canvas,” Canvas workspace mode, and selected semantic canvas layers refer to the generated workspace's HTML5 canvas, whose behavior is changed through workspace files; “Image Editor” refers only to the separate shell raster-composition window. Never open the Image Editor or generate an image merely because a workspace change mentions canvas. Use open_ui_component with image_editor only when the user explicitly asks for the Image Editor or static raster composition. While the Image Editor is open, your image input is its current static composition instead of the generated workspace. Use generate_image_asset only when the user explicitly requests a new raster image asset; use selected workspace images as references when appropriate. If mode, selection, and explicit wording do not resolve whether “canvas” means the workspace HTML5 canvas or an image in the Image Editor, ask “Do you mean the workspace's HTML5 canvas, or an image in the Image Editor?” and call no mutating, editor-opening, or generation tool until the user answers. ${edits} Delegate substantial or multi-file implementation work with submit_work using strategy auto. Never start the planner, use plan_first, or use plan_only unless the user explicitly asks for a plan or a reviewed plan-first workflow; architectural complexity or uncertainty alone is not permission to plan. Update or cancel the exact durable task when the user changes direction. Work starts return immediately, so remain available and use get_work_status for progress. The internal orchestration Assistant and its workers are parts of you: never acknowledge, name, or refer to an assistant or coordinator. Say “I’m doing that now,” “I already have that in progress,” or “I finished it,” always in first person. The UI may show technical worker activity, but do not expose internal delegation in conversation. Selected element and file context is attached automatically. Set includeWorkspacePreview only when broader visual context materially helps. Report only confirmed results and paths.`;
  const personality = assistant.personalityPrompt.trim();
  return personality ? `${delegationRule}${base}\n\n[USER-CONFIGURED PERSONALITY AND SPEAKING STYLE]\n${personality}` : `${delegationRule}${base}`;
}

export class LiveClient {
  ws: WebSocket | null = null;
  ready = false;
  inputBlocked = false;
  status: LiveStatus = 'offline';
  lastSessionHandle = '';
  onStatus?: (status: LiveStatus, detail?: string) => void;
  onAudio?: (samples: Float32Array) => void;
  onCaption?: (text: string, user: boolean) => void;
  onUserInput?: (text: string) => void;
  onInterrupted?: () => void;
  onToolCalls?: (calls: LiveFunctionCall[]) => Promise<void>;
  onGoAway?: (timeLeft?: string) => void;
  private restartPending = false;
  private catalog?: WorkspaceCatalog;
  private inputTranscript = '';
  private mutationChain: Promise<unknown> = Promise.resolve();
  private toolCalls = new Map<string, { signature: string; promise: Promise<unknown> }>();

  constructor(private settings: WorkspaceSettings, private assistant: AssistantSettings) {}
  configure(settings: WorkspaceSettings, catalog?: WorkspaceCatalog) { this.settings = settings; if (catalog) this.catalog = catalog; }
  configureAssistant(settings: AssistantSettings) { this.assistant = settings; }
  resetWorkspace(settings: WorkspaceSettings, catalog: WorkspaceCatalog) { this.settings = settings; this.catalog = catalog; this.lastSessionHandle = ''; this.restartPending = false; this.inputTranscript = ''; this.toolCalls.clear(); this.mutationChain = Promise.resolve(); this.close(false); }
  restartForConfiguration() { this.lastSessionHandle = ''; this.restartPending = true; this.scheduleRestart(); }

  connect() {
    this.close(false);
    this.setStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/live`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ setup: liveSetup(this.settings, this.assistant, this.lastSessionHandle, this.catalog) }));
    };
    ws.onmessage = async (event) => {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      try { this.handle(JSON.parse(raw)); } catch { /* ignore malformed upstream frames */ }
    };
    ws.onerror = () => this.setStatus('error', 'Live connection failed');
    ws.onclose = (event) => { this.ready = false; this.setStatus('closed', event.reason || `code ${event.code}`); };
  }

  private handle(message: any) {
    if (message.setupComplete !== undefined) { this.ready = true; this.setStatus('ready'); return; }
    if (message.error) { this.setStatus('error', message.error.message || 'Gemini Live error'); return; }
    if (message.sessionResumptionUpdate?.newHandle) this.lastSessionHandle = message.sessionResumptionUpdate.newHandle;
    if (message.goAway) { this.onGoAway?.(message.goAway.timeLeft); return; }
    if (message.toolCall?.functionCalls?.length) { void this.onToolCalls?.(message.toolCall.functionCalls); return; }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) this.onInterrupted?.();
    if (content.inputTranscription?.text) {
      const text = String(content.inputTranscription.text); this.inputTranscript = text.startsWith(this.inputTranscript) ? text : `${this.inputTranscript}${this.inputTranscript && !/^\s/.test(text) ? ' ' : ''}${text}`;
      this.onCaption?.(text, true); this.onUserInput?.(this.inputTranscript);
    }
    if (content.outputTranscription?.text) this.onCaption?.(content.outputTranscription.text, false);
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) this.onAudio?.(decodePcm(part.inlineData.data));
    }
    if (content.turnComplete) this.inputTranscript = '';
  }

  sendText(text: string) {
    if (!this.canSend()) return false;
    this.ws!.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
    return true;
  }

  sendAudio(data: string, sampleRate = 16000) {
    if (!this.canSend()) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${sampleRate}` } } }));
  }

  sendVideo(data: string) {
    if (!this.canSend()) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { video: { data, mimeType: 'image/jpeg' } } }));
  }

  sendAudioEnd() {
    if (!this.canSend()) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  sendToolResponse(responses: Array<{ id: string; name: string; response: unknown }>) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    this.scheduleRestart();
    return true;
  }

  executeToolCalls<T>(calls: LiveFunctionCall[], execute: (call: LiveFunctionCall) => Promise<T>): Promise<T[]> {
    return Promise.all(calls.map((call) => {
      const signature = JSON.stringify([call.name, call.args || {}]); const cached = this.toolCalls.get(call.id);
      if (cached) {
        if (cached.signature !== signature) return Promise.reject(new Error(`Live tool call ${call.id} was replayed with different arguments.`));
        return cached.promise as Promise<T>;
      }
      const start = () => {
        void reportLiveActivity(call, 'running');
        return execute(call).then((result) => {
          const error = (result as any)?.response?.error; void reportLiveActivity(call, error ? 'failed' : 'succeeded', error); return result;
        }, (error) => { void reportLiveActivity(call, 'failed', (error as Error).message); throw error; });
      };
      const promise = MUTATING_TOOLS.has(call.name) ? this.mutationChain.then(start, start) : start();
      if (MUTATING_TOOLS.has(call.name)) this.mutationChain = promise.then(() => undefined, () => undefined);
      this.toolCalls.set(call.id, { signature, promise });
      if (this.toolCalls.size > 250) this.toolCalls.delete(this.toolCalls.keys().next().value!);
      return promise;
    }));
  }

  close(report = true) {
    this.ready = false;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (report) this.setStatus('offline');
  }

  private canSend() { return !this.inputBlocked && this.ready && this.ws?.readyState === WebSocket.OPEN; }
  private setStatus(status: LiveStatus, detail?: string) { this.status = status; this.onStatus?.(status, detail); }
  private scheduleRestart() {
    if (!this.restartPending || this.inputBlocked) return;
    window.setTimeout(() => {
      if (!this.restartPending || this.inputBlocked) return;
      if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount > 0) { this.scheduleRestart(); return; }
      this.restartPending = false; if (this.ready || this.ws) this.connect();
    }, 75);
  }
}

async function reportLiveActivity(call: LiveFunctionCall, status: 'running' | 'succeeded' | 'failed', message?: string) {
  const edits = Array.isArray(call.args?.edits) ? call.args.edits as Array<{ path?: unknown }> : [];
  await fetch('/api/activity/client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    operationId: call.id, source: 'live', status, severity: status === 'failed' ? 'error' : 'info', title: `Live tool: ${call.name}`,
    message: message || `${call.name} ${status}`, paths: edits.map((edit) => String(edit.path || '')).filter(Boolean),
  }) }).catch(() => undefined);
}

function decodePcm(base64: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  return Float32Array.from(pcm, (sample) => sample / 32768);
}
import type { AssistantSettings, WorkspaceCatalog, WorkspaceSettings } from '../../shared/protocol';
