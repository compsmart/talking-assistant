export interface LiveFunctionCall { id: string; name: string; args?: Record<string, unknown> }
export interface LiveUserTurn { id: string; text: string }
export type LiveStatus = 'offline' | 'connecting' | 'ready' | 'closed' | 'error';
export type LiveActivityKind = 'thinking' | 'inspecting' | 'editing' | 'opening' | 'delegating' | 'planning' | 'starting' | 'updating' | 'cancelling' | 'approving' | 'responding';
export interface LiveActivity { kind: LiveActivityKind; label: string }
const MUTATING_TOOLS = new Set(['delegate_to_assistant']);

const TOOL_ACTIVITIES: Record<string, LiveActivity> = {
  delegate_to_assistant: { kind: 'delegating', label: 'Delegating' },
  submit_work: { kind: 'delegating', label: 'Delegating' },
  delegate_coding_task: { kind: 'delegating', label: 'Delegating' },
  create_implementation_plan: { kind: 'planning', label: 'Planning' },
  execute_implementation_plan: { kind: 'starting', label: 'Starting implementation' },
  respond_to_planning_continuation: { kind: 'planning', label: 'Resuming plan' },
  update_work: { kind: 'updating', label: 'Updating task' },
  cancel_work: { kind: 'cancelling', label: 'Cancelling task' },
  approve_work_plan: { kind: 'approving', label: 'Approving plan' },
  answer_work_question: { kind: 'responding', label: 'Answering task' },
  get_work_status: { kind: 'inspecting', label: 'Checking progress' },
  get_agent_run_status: { kind: 'inspecting', label: 'Checking progress' },
  get_coding_task_status: { kind: 'inspecting', label: 'Checking progress' },
  get_selected_element_context: { kind: 'inspecting', label: 'Inspecting selection' },
  get_selected_files_context: { kind: 'inspecting', label: 'Inspecting files' },
  get_workspace_settings: { kind: 'inspecting', label: 'Inspecting settings' },
  capture_selected_element_image: { kind: 'inspecting', label: 'Capturing selection' },
  list_workspace_files: { kind: 'inspecting', label: 'Listing files' },
  search_workspace_files: { kind: 'inspecting', label: 'Searching files' },
  read_workspace_file: { kind: 'inspecting', label: 'Reading file' },
  list_reference_workspace_files: { kind: 'inspecting', label: 'Listing reference files' },
  search_reference_workspace_files: { kind: 'inspecting', label: 'Searching reference files' },
  read_reference_workspace_file: { kind: 'inspecting', label: 'Reading reference file' },
  copy_reference_workspace_file: { kind: 'editing', label: 'Copying reference file' },
  edit_workspace_files: { kind: 'editing', label: 'Editing workspace' },
  open_ui_component: { kind: 'opening', label: 'Opening interface' },
  set_expression: { kind: 'updating', label: 'Changing expression' },
  play_gesture: { kind: 'updating', label: 'Playing gesture' },
};

export function liveToolActivity(name: string): LiveActivity {
  return TOOL_ACTIVITIES[name] || { kind: 'updating', label: 'Working' };
}

/** Remove internal identifiers from application-authored text before it reaches the voice model. */
export function speechSafeText(value: string) {
  return value
    .replace(/\b(?:task|work|run|job|request|question|workspace|agent)(?:\s+(?:id|identifier))?\s*[:#]?\s*[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'the task')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'the task')
    .replace(/\b(?:sha(?:256)?|hash|version)\s*[:#]?\s*[0-9a-f]{20,}\b/gi, 'the current version')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const FUNCTION_DECLARATIONS = [
  {
    name: 'delegate_to_assistant',
    description: 'Hand the current actionable user request to the authoritative Assistant. Call exactly once for any request that may inspect, create, edit, generate, plan, update, cancel, approve, answer, or report workspace work. The application attaches the raw user turn and selected context; your note is advisory only.',
    parameters: { type: 'OBJECT', properties: { note: { type: 'STRING', description: 'Optional concise visual or conversational context that is not present in the raw user words.' } } },
  },
  {
    name: 'submit_work',
    description: 'Delegate substantial implementation or media work to your internal orchestration layer, which selects the appropriate configured agent and its assigned skills. Do not use this for a small localized one-file edit when edit_workspace_files is available. Returns immediately after acceptance or duplicate detection while you remain available for conversation.',
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

const ASSISTANT_OWNED_TOOLS = new Set([
  'submit_work', 'update_work', 'cancel_work', 'get_work_status', 'approve_work_plan', 'answer_work_question',
  'delegate_coding_task', 'create_implementation_plan', 'execute_implementation_plan', 'respond_to_planning_continuation',
  'get_agent_run_status', 'get_coding_task_status', 'copy_reference_workspace_file', 'edit_workspace_files',
]);

function liveTools(_settings: WorkspaceSettings) { return [{ functionDeclarations: FUNCTION_DECLARATIONS.filter((tool) => !ASSISTANT_OWNED_TOOLS.has(tool.name)) }]; }

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
  const delegationRule = 'For every actionable workspace request, call delegate_to_assistant exactly once. The Assistant is the sole authority for task lifecycle, planning, edits, media generation, routing, status, approvals, and task questions. ';
  const mode = settings.mode === 'canvas'
    ? 'Canvas mode is active. Continuous vision contains only the primary HTML5 canvas and user selections are semantic canvas layers.'
    : settings.mode === 'dom'
      ? 'DOM mode is active. Continuous vision contains the complete rendered page, but user selections are DOM elements only.'
      : 'Mixed mode is active. Continuous vision contains the complete rendered page and selections may be DOM elements or semantic canvas layers.';
  const workspaceContext = catalog ? ` The active workspace is ${catalog.workspaces.find((item) => item.active)?.name}. Other known workspace names are: ${catalog.workspaces.filter((item) => !item.active).map((item) => item.name).join(', ') || 'none'}. Other workspace files are available only when the current user request explicitly names that workspace.` : '';
  const base = `You are the live cowork agent represented by a floating talking wireframe head. ${mode}${workspaceContext} You receive an authoritative persisted-workspace image on connect and continuous frames when vision is enabled. Be concise, warm, and practical. Your role is conversation and shell UI presentation, not workspace execution or task management. You may inspect read-only context, open the File Manager or Image Editor when explicitly requested, and use expressions or gestures. Never edit, generate, plan, submit, update, cancel, approve, answer task questions, or infer task status yourself. For any actionable workspace or task request, call delegate_to_assistant once and wait for its result. The application supplies the exact raw user turn, selected element, selected files, and authorization context; use the optional note only for concise visual context the raw words omit. Speak the returned message faithfully and do not invent task IDs, progress, paths, or completion claims. Never say, spell out, or read aloud a GUID, UUID, task ID, run ID, job ID, request ID, workspace ID, question ID, hash, or other internal identifier, even when one appears in tool output or context; refer naturally to “the task,” “the file,” or “the current version” instead. If you accidentally call the handoff more than once, the same user turn remains one idempotent request. Keep these surfaces distinct: “canvas,” Canvas workspace mode, and selected semantic canvas layers refer to the generated workspace's HTML5 canvas; “Image Editor” refers only to the separate shell raster-composition window. Use open_ui_component with image_editor only when the user explicitly asks to open or operate that UI. If wording does not resolve which canvas they mean, ask “Do you mean the workspace's HTML5 canvas, or an image in the Image Editor?” before delegating. Planning must only be requested when the user explicitly asks for a plan. The internal Assistant and workers are parts of you: speak in first person and do not expose internal orchestration names.`;
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
  onActivity?: (activity?: LiveActivity) => void;
  onGoAway?: (timeLeft?: string) => void;
  private restartPending = false;
  private catalog?: WorkspaceCatalog;
  private inputTranscript = '';
  private userTurn?: LiveUserTurn;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private toolCalls = new Map<string, { signature: string; promise: Promise<unknown> }>();
  private thinking = false;
  private activeTools = new Map<string, LiveActivity>();

  constructor(private settings: WorkspaceSettings, private assistant: AssistantSettings) {}
  configure(settings: WorkspaceSettings, catalog?: WorkspaceCatalog) { this.settings = settings; if (catalog) this.catalog = catalog; }
  configureAssistant(settings: AssistantSettings) { this.assistant = settings; }
  resetWorkspace(settings: WorkspaceSettings, catalog: WorkspaceCatalog) { this.settings = settings; this.catalog = catalog; this.lastSessionHandle = ''; this.restartPending = false; this.inputTranscript = ''; this.userTurn = undefined; this.toolCalls.clear(); this.mutationChain = Promise.resolve(); this.clearActivity(); this.close(false); }
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
    ws.onerror = () => { this.clearActivity(); this.setStatus('error', 'Live connection failed'); };
    ws.onclose = (event) => { this.ready = false; this.clearActivity(); this.setStatus('closed', event.reason || `code ${event.code}`); };
  }

  private handle(message: any) {
    if (message.setupComplete !== undefined) { this.ready = true; this.setStatus('ready'); return; }
    if (message.error) { this.clearActivity(); this.setStatus('error', message.error.message || 'Gemini Live error'); return; }
    if (message.sessionResumptionUpdate?.newHandle) this.lastSessionHandle = message.sessionResumptionUpdate.newHandle;
    if (message.goAway) { this.onGoAway?.(message.goAway.timeLeft); return; }
    if (message.toolCall?.functionCalls?.length) { void this.onToolCalls?.(message.toolCall.functionCalls); return; }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) { this.clearActivity(); this.onInterrupted?.(); }
    if (content.inputTranscription?.text) {
      const text = String(content.inputTranscription.text); this.inputTranscript = text.startsWith(this.inputTranscript) ? text : `${this.inputTranscript}${this.inputTranscript && !/^\s/.test(text) ? ' ' : ''}${text}`;
      if (!this.userTurn) this.userTurn = { id: crypto.randomUUID(), text: this.inputTranscript };
      else this.userTurn.text = this.inputTranscript;
      this.onCaption?.(text, true); this.onUserInput?.(this.inputTranscript);
    }
    if (content.outputTranscription?.text) { this.setThinking(false); this.onCaption?.(content.outputTranscription.text, false); }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) { this.setThinking(false); this.onAudio?.(decodePcm(part.inlineData.data)); }
    }
    if (content.turnComplete) { this.inputTranscript = ''; this.userTurn = undefined; this.clearActivity(); }
  }

  beginUserTurn(text: string) { this.userTurn = { id: crypto.randomUUID(), text: text.trim() }; }
  currentUserTurn() { return this.userTurn ? { ...this.userTurn } : undefined; }

  sendText(text: string) {
    if (!this.canSend()) return false;
    this.ws!.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
    this.setThinking(true);
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
    this.setThinking(true);
  }

  sendToolResponse(responses: Array<{ id: string; name: string; response: unknown }>) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    this.setThinking(true);
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
        this.startTool(call);
        void reportLiveActivity(call, 'running');
        return execute(call).then((result) => {
          const error = (result as any)?.response?.error; this.finishTool(call.id); void reportLiveActivity(call, error ? 'failed' : 'succeeded', error); return result;
        }, (error) => { this.finishTool(call.id); void reportLiveActivity(call, 'failed', (error as Error).message); throw error; });
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
    this.clearActivity();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (report) this.setStatus('offline');
  }

  private canSend() { return !this.inputBlocked && this.ready && this.ws?.readyState === WebSocket.OPEN; }
  private setStatus(status: LiveStatus, detail?: string) { this.status = status; this.onStatus?.(status, detail); }
  private setThinking(value: boolean) { this.thinking = value; this.publishActivity(); }
  private startTool(call: LiveFunctionCall) { this.thinking = false; this.activeTools.set(call.id, liveToolActivity(call.name)); this.publishActivity(); }
  private finishTool(id: string) { this.activeTools.delete(id); this.publishActivity(); }
  private clearActivity() { this.thinking = false; this.activeTools.clear(); this.publishActivity(); }
  private publishActivity() {
    const tools = [...this.activeTools.values()];
    this.onActivity?.(tools.at(-1) || (this.thinking ? { kind: 'thinking', label: 'Thinking' } : undefined));
  }
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
