export type TaskStatus = 'queued' | 'running' | 'validating' | 'repairing' | 'publishing' | 'completed' | 'failed' | 'cancelled';
export type PlanningStatus = 'queued' | 'planning' | 'awaiting_continuation' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'planning' | 'coding' | 'media';

export type ActivityKind =
  | 'status' | 'thought_summary' | 'model_output' | 'tool_call' | 'tool_result'
  | 'stdout' | 'stderr' | 'diff' | 'validation' | 'todo' | 'continuation_required' | 'error' | 'complete';

export interface ActivityEvent {
  taskId: string;
  seq: number;
  at: string;
  kind: ActivityKind;
  phase: string;
  message: string;
  data?: unknown;
}

export type ActivitySource = 'live' | 'direct-edit' | 'coding' | 'planning' | 'media' | 'preview' | 'workspace' | 'http' | 'system' | 'legacy';
export type ActivitySeverity = 'info' | 'warning' | 'error';
export type ActivityStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ActivityRecord {
  id: string;
  workspaceId?: string;
  source: ActivitySource;
  severity: ActivitySeverity;
  status: ActivityStatus;
  title: string;
  message: string;
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  runId?: string;
  operationId?: string;
  requestId?: string;
  httpStatus?: number;
  paths?: string[];
  resolvedAt?: string;
  resolution?: string;
  legacy?: boolean;
}

export interface ActivityPage {
  items: ActivityRecord[];
  nextCursor?: string;
  unresolved: number;
}

export interface WorkspaceReleaseSummary {
  version: string;
  active: boolean;
  createdAt: string;
  changedFiles?: FileReference[];
}

export interface RecoveryState {
  workspaceId: string;
  workspaceVersion: string;
  lockOwner?: string;
  activeRun?: AgentRunSnapshot;
  serverStartedAt: string;
  restartRequired: boolean;
  restartCommand: string;
  git: { dirty: boolean; fingerprint: string; changes: Array<{ status: string; path: string }> };
}

export interface TaskRequest {
  objective: string;
  successCriteria?: string[];
  selectedElement?: WorkspaceSelection;
  selectedFiles?: string[];
  includeCanvasImage?: boolean;
  referenceGrantId?: string;
  approvedPlan?: { id: string; path: string; hash: string };
}

export interface PlanRequest extends Omit<TaskRequest, 'approvedPlan'> {}

export interface TaskTodo {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  note?: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  mode: WorkspaceMode;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface WorkspaceCatalog {
  activeWorkspaceId: string;
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceReferenceGrant {
  id: string;
  workspaceIds: string[];
  workspaceNames: string[];
  expiresAt: string;
}

export interface DomSelection {
  kind: 'dom';
  identifier: string;
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  outerHTML: string;
  parentText: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface CanvasSelection {
  kind: 'canvas';
  identifier: string;
  canvasId: string;
  layerId: string;
  label: string;
  layerType: string;
  properties: Record<string, unknown>;
  rect: { x: number; y: number; width: number; height: number };
  canvasRect: { x: number; y: number; width: number; height: number };
  canvasSize: { width: number; height: number };
}

export type WorkspaceSelection = DomSelection | CanvasSelection;

export type WorkspaceMode = 'canvas' | 'dom' | 'mixed';
export type VisionFrameRate = 0.5 | 1 | 2;
export type VisionQuality = 'low' | 'balanced' | 'high';
export type ValidationProfile = 'standard' | 'fast' | 'unchecked';
export type ReasoningProfile = 'adaptive' | 'balanced' | 'fast';

export const GEMINI_LIVE_VOICES = [
  { name: 'Zephyr', style: 'Bright' }, { name: 'Puck', style: 'Upbeat' }, { name: 'Charon', style: 'Informative' },
  { name: 'Kore', style: 'Firm' }, { name: 'Fenrir', style: 'Excitable' }, { name: 'Leda', style: 'Youthful' },
  { name: 'Orus', style: 'Firm' }, { name: 'Aoede', style: 'Breezy' }, { name: 'Callirrhoe', style: 'Easy-going' },
  { name: 'Autonoe', style: 'Bright' }, { name: 'Enceladus', style: 'Breathy' }, { name: 'Iapetus', style: 'Clear' },
  { name: 'Umbriel', style: 'Easy-going' }, { name: 'Algieba', style: 'Smooth' }, { name: 'Despina', style: 'Smooth' },
  { name: 'Erinome', style: 'Clear' }, { name: 'Algenib', style: 'Gravelly' }, { name: 'Rasalgethi', style: 'Informative' },
  { name: 'Laomedeia', style: 'Upbeat' }, { name: 'Achernar', style: 'Soft' }, { name: 'Alnilam', style: 'Firm' },
  { name: 'Schedar', style: 'Even' }, { name: 'Gacrux', style: 'Mature' }, { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Achird', style: 'Friendly' }, { name: 'Zubenelgenubi', style: 'Casual' }, { name: 'Vindemiatrix', style: 'Gentle' },
  { name: 'Sadachbia', style: 'Lively' }, { name: 'Sadaltager', style: 'Knowledgeable' }, { name: 'Sulafat', style: 'Warm' },
] as const;

export type GeminiLiveVoiceName = typeof GEMINI_LIVE_VOICES[number]['name'];
export type AvatarBackgroundMode = 'none' | 'grid' | 'digital-rain' | 'starfield';

export interface AvatarAppearanceSettings {
  skinBlend: number;
  colors: { wire: string; rim: string; background: string; backgroundAccent: string };
  background: { mode: AvatarBackgroundMode; intensity: number; speed: number; particles: number };
  effects: { glow: number; bloom: number; meshPulse: number; scanlines: number; glitch: number; chromaticSplit: number; vignette: number };
}

export interface AssistantSettings {
  voice: GeminiLiveVoiceName;
  personalityPrompt: string;
  appearance: AvatarAppearanceSettings;
}

export interface AssistantProfile {
  settings: AssistantSettings;
  hasPhoto: boolean;
  photoVersion?: string;
}

export interface WorkspaceSettings {
  mode: WorkspaceMode;
  vision: { frameRate: VisionFrameRate; quality: VisionQuality };
  liveAgent: { directFileEdits: boolean };
  codingAgent: {
    dependencies: 'allow' | 'existing-only';
    mediaGeneration: boolean;
    validation: ValidationProfile;
    reasoningProfile: ReasoningProfile;
  };
  git: { commitOnFileManagerClose: 'ask' | 'always' | 'never' };
}

export interface FileReference {
  path: string;
  action: 'added' | 'modified' | 'deleted';
}

export interface WorkspaceFileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  mimeType?: string;
  previewKind?: 'text' | 'image' | 'video' | 'audio' | 'binary';
}

export interface WorkspaceFileDocument {
  path: string;
  content: string;
  hash: string;
  size: number;
  modifiedAt: string;
  mimeType: string;
}

export interface WorkspaceEdit {
  path: string;
  mode: 'write' | 'replace';
  content?: string;
  search?: string;
  replacement?: string;
  all?: boolean;
  expectedHash?: string;
}

export interface AssetRecord {
  id: string;
  kind: 'image' | 'animation' | 'video' | 'music' | 'sound-effect' | 'upload';
  path: string;
  prompt?: string;
  model?: string;
  transparent?: boolean;
  referenceImages?: string[];
  startFrame?: string;
  endFrame?: string;
  durationSeconds?: number;
  fps?: number;
  mimeType: string;
  size: number;
  createdAt: string;
  originalName?: string;
  mediaJobId?: string;
  mediaRevision?: number;
  pairedAudioPath?: string;
}

export type MediaJobKind = 'image' | 'video' | 'animation' | 'music' | 'sound-effect';
export type MediaJobStatus = 'queued' | 'running' | 'review' | 'publishing' | 'completed' | 'failed' | 'cancelled';
export type MediaStageName = 'brief' | 'normalize' | 'generate' | 'extract' | 'matte' | 'encode' | 'publish';
export type MediaStageStatus = 'pending' | 'running' | 'ready' | 'stale' | 'failed' | 'cancelled';

export interface AnimationMatteSettings {
  backgroundColor: string;
  tolerance: number;
  feather: number;
  despill: number;
  edgeConnected: boolean;
}

export interface AnimationEncodingSettings {
  fps: 12;
  frameCount: 48;
  lossless: boolean;
  quality: number;
}

export interface MediaJobRequestBase {
  kind: MediaJobKind;
  prompt: string;
  name: string;
  parentRunId?: string;
  referenceImages?: string[];
}

export interface AnimationMediaJobRequest extends MediaJobRequestBase {
  kind: 'animation';
  startFrame?: string;
  endFrame?: string;
  transparent?: boolean;
  aspectRatio?: '16:9' | '9:16';
  soundEffects?: string;
  matte?: Partial<AnimationMatteSettings>;
  encoding?: Partial<AnimationEncodingSettings>;
}

export interface ImageMediaJobRequest extends MediaJobRequestBase {
  kind: 'image';
  transparent?: boolean;
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}

export interface VideoMediaJobRequest extends MediaJobRequestBase {
  kind: 'video';
  startFrame?: string;
  endFrame?: string;
  aspectRatio?: '16:9' | '9:16';
  soundEffects?: string;
}

export interface AudioMediaJobRequest extends MediaJobRequestBase {
  kind: 'music' | 'sound-effect';
  durationSeconds?: number;
  musicTier?: 'clip' | 'pro';
}

export type MediaJobRequest = AnimationMediaJobRequest | ImageMediaJobRequest | VideoMediaJobRequest | AudioMediaJobRequest;

export interface MediaArtifact {
  id: string;
  stage: MediaStageName;
  type: 'image' | 'video' | 'audio' | 'contact-sheet' | 'mask' | 'animation';
  label: string;
  mimeType: string;
  revision: number;
  createdAt: string;
  url: string;
}

export interface MediaStageState {
  name: MediaStageName;
  status: MediaStageStatus;
  progress: number;
  attempt: number;
  artifactIds: string[];
  error?: string;
}

export interface MediaJobSnapshot {
  kind: 'media';
  id: string;
  workspaceId: string;
  parentRunId?: string;
  status: MediaJobStatus;
  request: MediaJobRequest;
  revision: number;
  selectedRevision: number;
  stablePaths: string[];
  stages: MediaStageState[];
  artifacts: MediaArtifact[];
  settings: { matte: AnimationMatteSettings; encoding: AnimationEncodingSettings };
  createdAt: string;
  updatedAt: string;
  previewVersion?: string;
  error?: string;
}

export interface CanvasImageGenerationRequest {
  prompt: string;
  name: string;
  transparent?: boolean;
  referenceImages?: string[];
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}

export interface CanvasImageGenerationResult {
  value: { ok: true; asset: AssetRecord };
  changedFiles: FileReference[];
  checks: CheckResult[];
  version: string;
  previewUrl: string;
}

export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  details?: string;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  changedFiles: FileReference[];
  checks: CheckResult[];
  retries: number;
  previewVersion?: string;
  previewUrl?: string;
  performance?: {
    phases: Record<string, number>;
    firstMutationMs?: number;
    interactionCount: number;
    toolCount: number;
    callsByTool: Record<string, number>;
    tokens: { input: number; output: number; thought: number; cached: number };
  };
}

export interface TaskSnapshot {
  kind: 'coding';
  id: string;
  workspaceId: string;
  status: TaskStatus;
  request: TaskRequest;
  createdAt: string;
  updatedAt: string;
  todos: TaskTodo[];
  result?: TaskResult;
}

export interface PlanResult {
  planId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  path?: string;
  hash?: string;
}

export interface PlanningRunSnapshot {
  kind: 'planning';
  id: string;
  workspaceId: string;
  status: PlanningStatus;
  request: PlanRequest;
  createdAt: string;
  updatedAt: string;
  continuation?: { reason: 'step_limit' | 'timeout'; interactionCount: number; segment: number; message: string };
  result?: PlanResult;
}

export type AgentRunSnapshot = TaskSnapshot | PlanningRunSnapshot;
export type AgentRunResult = TaskResult | PlanResult;
