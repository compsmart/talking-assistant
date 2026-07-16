import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent, AgentRunSnapshot, AssistantProfile, AssistantSettings, AvatarAppearanceSettings, PlanResult, TaskResult, TaskSnapshot, UiTheme, UiThemeProfile, UiThemeProfileResponse, WorkItemSnapshot, WorkspaceCatalog, WorkspaceMode, WorkspaceReferenceGrant, WorkspaceSelection, WorkspaceSettings } from '../shared/protocol';
import { AvatarPanel } from './components/AvatarPanel';
import { WorkspaceStage } from './components/WorkspaceStage';
import { ChatTray } from './components/ChatTray';
import { AgentTerminal } from './components/AgentTerminal';
import { WorkCenter } from './components/WorkCenter';
import { IconButton } from './components/IconButton';
import { LiveClient, type LiveFunctionCall, type LiveStatus } from './live/LiveClient';
import { MicrophoneInput } from './live/MicrophoneInput';
import { CanvasVision } from './live/CanvasVision';
import { SurfaceVision } from './live/SurfaceVision';
import { cancelPlan, cancelTask, continuePlan, createPlan, createTask, executePlan, getActiveRun, getPendingPlan, watchAgentRun } from './agent/TaskClient';
import { approveWorkPlan, cancelWork, getWork, listWork, submitWork, updateWork, watchWork as watchWorkFeed } from './agent/WorkClient';
import type { AvatarController } from './avatar/AvatarController';
import { editFiles, listFiles, readFile, searchFiles, uploadFiles } from './files/FileClient';
import { WorkspaceSettingsPanel } from './components/WorkspaceSettingsPanel';
import { AssistantSettingsPanel } from './components/AssistantSettingsPanel';
import { AgentsPanel } from './components/AgentsPanel';
import { UiThemePanel } from './components/UiThemePanel';
import { DEFAULT_CLIENT_SETTINGS } from './settings/defaults';
import { DEFAULT_ASSISTANT_SETTINGS } from './settings/assistantDefaults';
import { getWorkspaceSettings, saveWorkspaceSettings } from './settings/SettingsClient';
import { getAssistantPhoto, getAssistantProfile, saveAssistantProfile } from './settings/AssistantSettingsClient';
import { activateWorkspace, createReferenceGrant, createWorkspace, deleteWorkspace, duplicateWorkspace, getActiveWorkspace, getWorkspaces, referenceOperation, renameWorkspace, type WorkspaceLifecycleResult } from './settings/WorkspaceClient';
import type { CanvasPanelHandle } from './components/CanvasPanel';
import { deleteCanvasDocument } from './canvas/CanvasStore';
import { ActivityPanel } from './components/ActivityPanel';
import { getActivity, recordClientError, watchActivity } from './activity/ActivityClient';
import { listMediaJobs } from './media/MediaClient';
import { applyUiTheme, getUiThemeProfile, saveUiThemeProfile } from './settings/UiThemeClient';
import { DEFAULT_UI_THEME_PROFILE, activeUiTheme, allUiThemes } from '../shared/uiThemes';

const Icon = ({ path }: { path: string }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
const FileManager = lazy(() => import('./components/FileManager').then((module) => ({ default: module.FileManager })));
const CanvasPanel = lazy(() => import('./components/CanvasPanel').then((module) => ({ default: module.CanvasPanel })));
const AnimationEditorPanel = lazy(() => import('./components/AnimationEditorPanel'));
const paths = {
  mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3m5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z',
  chat: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-6 4V6a2 2 0 0 1 2-2m2 5v2h12V9zm0 4v2h8v-2z',
  eye: 'M12 5c5.5 0 9.5 5.3 10 6c-.5.7-4.5 6-10 6S2.5 11.7 2 11c.5-.7 4.5-6 10-6m0 2a4 4 0 1 0 0 8a4 4 0 0 0 0-8m0 2a2 2 0 1 1 0 4a2 2 0 0 1 0-4',
  face: 'M12 2a7 7 0 0 0-7 7v3.5c0 4.1 3.1 8 7 9.5 3.9-1.5 7-5.4 7-9.5V9a7 7 0 0 0-7-7m-3 8.5A1.25 1.25 0 1 1 9 8a1.25 1.25 0 0 1 0 2.5m6 0A1.25 1.25 0 1 1 15 8a1.25 1.25 0 0 1 0 2.5m-6.2 4.2c2.1 1.5 4.3 1.5 6.4 0l.8 1.1c-2.7 2-5.3 2-8 0z',
  select: 'M4 2h2v2H4v2H2V4a2 2 0 0 1 2-2m14 0a2 2 0 0 1 2 2v2h-2V4h-2V2zM4 18v-2H2v4a2 2 0 0 0 2 2h4v-2H4zm16-2h2v4a2 2 0 0 1-2 2h-4v-2h2v-2zm-9-7 7 3-3 1.5 2.5 4-2 1.2-2.4-4.1L11 17z',
  folder: 'M10 4H2v16h20V6H12zM4 8h16v10H4z',
  canvas: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m0 2v14h16V5zm3 11 3-4 2.5 3 2-2 3 5H6z',
  activity: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m2 4v2h8V7zm0 4v2h12v-2zm0 4v2h7v-2zm12.5-.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5',
  agents: 'M8 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6m8-1a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5M2 20v-2c0-3 2.7-5 6-5s6 2 6 5v2zm12.5 0v-2c0-1.5-.5-2.8-1.4-3.9c.9-.7 1.9-1.1 3.1-1.1c3 0 5.3 2 5.3 5v2z',
  palette: 'M12 3a9 9 0 0 0 0 18h1.5a2.5 2.5 0 0 0 0-5H12a2 2 0 0 1 0-4h5.7A3.3 3.3 0 0 0 21 8.7C21 5.6 17 3 12 3M7 9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m4-2a1.5 1.5 0 1 1 3 0a1.5 1.5 0 0 1-3 0m5 3a1.5 1.5 0 1 1 3 0a1.5 1.5 0 0 1-3 0M7.5 15a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3',
  subtitles: 'M3 5h18v14H3zm2 2v10h14V7zm2 3h4v2H9v2h2v2H7zm6 0h4v2h-2v2h2v2h-4z',
  volume: 'M4 9h4l5-4v14l-5-4H4zm11.5-.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2zm2.8-2.8a9 9 0 0 1 0 12.6l-1.4-1.4a7 7 0 0 0 0-9.8z',
  volumeMuted: 'M4 9h4l5-4v14l-5-4H4zm11.4.2 1.4-1.4 2.2 2.2 2.2-2.2 1.4 1.4-2.2 2.2 2.2 2.2-1.4 1.4-2.2-2.2-2.2 2.2-1.4-1.4 2.2-2.2z',
  settings: 'M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65-2-3.46-2.49 1a7.2 7.2 0 0 0-1.69-.98L15 3.25h-4l-.37 2.68c-.6.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.11 1.65c-.04.32-.07.66-.07.98s.03.66.07.98l-2.11 1.65 2 3.46 2.49-1c.52.41 1.09.74 1.69.98l.37 2.68h4l.37-2.68c.6-.25 1.17-.58 1.69-.98l2.49 1 2-3.46zM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5',
};

export function App() {
  const iframe = useRef<HTMLIFrameElement>(null);
  const captureTarget = useRef<HTMLElement | null>(null);
  const avatar = useRef<AvatarController | null>(null);
  const live = useMemo(() => new LiveClient(DEFAULT_CLIENT_SETTINGS, DEFAULT_ASSISTANT_SETTINGS), []);
  const mic = useMemo(() => new MicrophoneInput(live), [live]);
  const vision = useRef<CanvasVision | null>(null);
  const surfaceVision = useRef<SurfaceVision | null>(null);
  const surfaceElement = useRef<HTMLCanvasElement | null>(null);
  const canvasOpenRef = useRef(false);
  const canvasPanel = useRef<CanvasPanelHandle | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('offline');
  const [micOn, setMicOn] = useState(false);
  const [visionOn, setVisionOn] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [caption, setCaption] = useState('');
  const [captionFading, setCaptionFading] = useState(false);
  const [subtitlesOn, setSubtitlesOn] = useState(() => localStorage.getItem('cowork.avatar.subtitles') !== 'off');
  const [voiceMuted, setVoiceMuted] = useState(() => localStorage.getItem('cowork.avatar.voice-muted') === 'true');
  const [error, setError] = useState('');
  const [task, setTask] = useState<AgentRunSnapshot>();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [works, setWorks] = useState<WorkItemSnapshot[]>([]);
  const [workCenterOpen, setWorkCenterOpen] = useState(false);
  const [workEvents, setWorkEvents] = useState<Record<string, ActivityEvent[]>>({});
  const [previewVersion, setPreviewVersion] = useState<string>();
  const [workspaceId, setWorkspaceId] = useState('');
  const [catalog, setCatalog] = useState<WorkspaceCatalog>({ activeWorkspaceId: '', workspaces: [] });
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<WorkspaceSelection>();
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasLoaded, setCanvasLoaded] = useState(false);
  const [canvasBusy, setCanvasBusy] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [focusFile, setFocusFile] = useState<string>();
  const [fileRefreshKey, setFileRefreshKey] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [settings, setSettings] = useState<WorkspaceSettings>(DEFAULT_CLIENT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityUnresolved, setActivityUnresolved] = useState(0);
  const [assistantProfile, setAssistantProfile] = useState<AssistantProfile>({ settings: DEFAULT_ASSISTANT_SETTINGS, hasPhoto: false });
  const [assistantPhoto, setAssistantPhoto] = useState<Blob>();
  const [assistantPhotoReady, setAssistantPhotoReady] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [uiThemesOpen, setUiThemesOpen] = useState(false);
  const [uiThemeProfile, setUiThemeProfile] = useState<UiThemeProfileResponse>(() => ({ ...structuredClone(DEFAULT_UI_THEME_PROFILE), themes: allUiThemes(DEFAULT_UI_THEME_PROFILE) }));
  const [animationEditorJobId, setAnimationEditorJobId] = useState<string>();
  const [canvasStatus, setCanvasStatus] = useState<{ compatible: boolean; canvasId?: string; restrictionTarget?: unknown }>({ compatible: false });
  const dragDepth = useRef(0);
  const pendingCompletion = useRef<string>('');
  const watchedRuns = useRef(new Set<string>());
  const announcedContinuations = useRef(new Set<string>());
  const referenceGrant = useRef<Promise<WorkspaceReferenceGrant | undefined> | undefined>(undefined);
  const referenceGrantId = useRef<string | undefined>(undefined);
  const assistantProfileRef = useRef(assistantProfile);
  const assistantPhotoRef = useRef<Blob | undefined>(undefined);
  const captionRef = useRef('');
  const agentSpeakingRef = useRef(false);
  const voiceMutedRef = useRef(voiceMuted);
  const captionFadeTimer = useRef<number | undefined>(undefined);
  const captionClearTimer = useRef<number | undefined>(undefined);
  const uploadSequence = useRef(0);
  const taskBusy = !!task && !['completed', 'failed', 'cancelled'].includes(task.status);
  const activeWorks = works.filter((work) => !['completed', 'failed', 'cancelled', 'superseded'].includes(work.status));

  const reportError = useCallback((message: string) => {
    setError(message); void recordClientError(message, message.toLocaleLowerCase().includes('live') || message.toLocaleLowerCase().includes('gemini') ? 'live' : 'system'); window.setTimeout(() => setError(''), 5500);
  }, []);
  const openCanvasPanel = useCallback(async () => {
    setCanvasLoaded(true); setCanvasOpen(true);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (canvasPanel.current) return canvasPanel.current;
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error('The Image Editor did not finish opening.');
  }, []);
  const connectCanvasSurface = useCallback((surface: HTMLCanvasElement | null) => {
    if (!surface) { surfaceVision.current?.stop(); surfaceVision.current = null; surfaceElement.current = null; return; }
    if (surfaceElement.current !== surface) {
      surfaceVision.current?.stop(); surfaceElement.current = surface;
      surfaceVision.current = new SurfaceVision(live, surface, { frameRate: settings.vision.frameRate, quality: settings.vision.quality });
    }
    if (canvasOpenRef.current) surfaceVision.current?.start();
  }, [live, settings.vision.frameRate, settings.vision.quality]);
  const clearSelection = useCallback(() => {
    setSelection(undefined); setSelectMode(false);
    iframe.current?.contentWindow?.postMessage({ type: 'cowork:clear-selection' }, '*');
  }, []);
  const authorizeUserTurn = useCallback((text: string) => {
    referenceGrant.current = createReferenceGrant(text, referenceGrantId.current).then((grant) => { referenceGrantId.current = grant.id; return grant; }).catch((reason) => { reportError((reason as Error).message); return undefined; });
  }, [reportError]);
  const clearCaptionTimers = useCallback(() => {
    window.clearTimeout(captionFadeTimer.current);
    window.clearTimeout(captionClearTimer.current);
  }, []);
  const scheduleCaptionFade = useCallback(() => {
    clearCaptionTimers();
    if (!captionRef.current || captionRef.current.startsWith('You:') || agentSpeakingRef.current) return;
    captionFadeTimer.current = window.setTimeout(() => {
      setCaptionFading(true);
      captionClearTimer.current = window.setTimeout(() => {
        captionRef.current = ''; setCaption(''); setCaptionFading(false);
      }, 450);
    }, 3000);
  }, [clearCaptionTimers]);
  const updateCaption = useCallback((text: string, user: boolean) => {
    clearCaptionTimers(); setCaptionFading(false);
    const current = captionRef.current;
    const next = user ? `You: ${text}` : (current.startsWith('You:') ? text : current + text);
    captionRef.current = next; setCaption(next);
    if (!user && !agentSpeakingRef.current) scheduleCaptionFade();
  }, [clearCaptionTimers, scheduleCaptionFade]);
  const handleSpeakingChange = useCallback((speaking: boolean) => {
    agentSpeakingRef.current = speaking;
    clearCaptionTimers();
    if (speaking) { setCaptionFading(false); return; }
    scheduleCaptionFade();
  }, [clearCaptionTimers, scheduleCaptionFade]);
  const avatarReady = useCallback((controller: AvatarController) => {
    avatar.current = controller; controller.onSpeakingChange = handleSpeakingChange; controller.configureAppearance(assistantProfileRef.current.settings.appearance);
    controller.setMuted(voiceMutedRef.current);
    if (assistantPhotoRef.current) void controller.applyPhoto(blobAsFile(assistantPhotoRef.current)).then(() => controller.configureAppearance(assistantProfileRef.current.settings.appearance));
  }, [handleSpeakingChange]);

  useEffect(() => { localStorage.setItem('cowork.avatar.subtitles', subtitlesOn ? 'on' : 'off'); }, [subtitlesOn]);
  useEffect(() => { voiceMutedRef.current = voiceMuted; localStorage.setItem('cowork.avatar.voice-muted', String(voiceMuted)); avatar.current?.setMuted(voiceMuted); }, [voiceMuted]);

  const syncWorkspaceFrame = useCallback(async () => {
    if (canvasOpenRef.current) { await surfaceVision.current?.sendNow(); return; }
    try {
      const response = await fetch('/api/workspace/snapshot', { cache: 'no-store' });
      if (!response.ok) throw new Error(`workspace snapshot returned ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      live.sendVideo(bytesToBase64(bytes));
    } catch (reason) { reportError(`Live workspace sync failed: ${(reason as Error).message}`); }
  }, [live, reportError]);

  useEffect(() => {
    getActiveWorkspace()
      .then((data) => { setPreviewVersion(data.version); setWorkspaceId(data.id); })
      .catch((reason) => reportError(`Could not restore the persisted workspace: ${(reason as Error).message}`));
  }, [reportError]);

  useEffect(() => {
    getWorkspaceSettings().then((value) => { setSettings(value); live.configure(value); }).catch((reason) => reportError((reason as Error).message));
  }, [live, reportError]);

  useEffect(() => { getUiThemeProfile().then((profile) => { setUiThemeProfile(profile); applyUiTheme(activeUiTheme(profile), true); }).catch((reason) => reportError((reason as Error).message)); }, [reportError]);

  useEffect(() => { getWorkspaces().then((value) => { setCatalog(value); live.configure(settings, value); }).catch((reason) => reportError((reason as Error).message)); }, [live, reportError]);
  useEffect(() => { if (catalog.workspaces.length) live.configure(settings, catalog); }, [catalog, live, settings]);
  useEffect(() => {
    const refresh = () => void getActivity().then((page) => setActivityUnresolved(page.unresolved)).catch(() => undefined);
    refresh(); const stop = watchActivity(refresh); return stop;
  }, []);

  useEffect(() => {
    getAssistantProfile().then(async (profile) => {
      const photo = profile.hasPhoto ? await getAssistantPhoto(profile.photoVersion) : undefined;
      assistantProfileRef.current = profile; assistantPhotoRef.current = photo; setAssistantProfile(profile); setAssistantPhoto(photo); setAssistantPhotoReady(true);
      live.configureAssistant(profile.settings);
      if (live.ready) live.restartForConfiguration();
      avatar.current?.configureAppearance(profile.settings.appearance);
      if (photo && avatar.current) { await avatar.current.applyPhoto(blobAsFile(photo)); avatar.current.configureAppearance(profile.settings.appearance); }
      else avatar.current?.clearPhoto();
    }).catch((reason) => { setAssistantPhotoReady(true); reportError((reason as Error).message); });
  }, [live, reportError]);

  useEffect(() => { assistantProfileRef.current = assistantProfile; assistantPhotoRef.current = assistantPhoto; }, [assistantPhoto, assistantProfile]);

  useEffect(() => {
    live.onStatus = (status, detail) => {
      setLiveStatus(status);
      if (status === 'error' && detail) reportError(detail);
      if (status === 'ready' && pendingCompletion.current) {
        live.sendText(`[WORKSPACE EVENT] ${pendingCompletion.current}`); pendingCompletion.current = '';
      }
      if (status === 'ready') void syncWorkspaceFrame();
    };
    live.onAudio = (samples) => avatar.current?.enqueueAudio(samples);
    live.onInterrupted = () => avatar.current?.interrupt();
    live.onCaption = updateCaption;
    live.onUserInput = authorizeUserTurn;
    live.onGoAway = () => window.setTimeout(() => live.connect(), 250);
    return () => { clearCaptionTimers(); mic.stop(); vision.current?.stop(); surfaceVision.current?.stop(); live.close(); };
  }, [authorizeUserTurn, clearCaptionTimers, live, mic, reportError, syncWorkspaceFrame, updateCaption]);

  useEffect(() => {
    if (previewVersion && live.ready && !live.inputBlocked) void syncWorkspaceFrame();
  }, [previewVersion, live, syncWorkspaceFrame]);

  useEffect(() => {
    canvasOpenRef.current = canvasOpen;
    vision.current?.setPaused(canvasOpen);
    if (canvasOpen) {
      const surface = canvasPanel.current?.getCompositeCanvas(); if (surface) connectCanvasSurface(surface);
      surfaceVision.current?.configure({ frameRate: settings.vision.frameRate, quality: settings.vision.quality }); surfaceVision.current?.start();
    } else {
      surfaceVision.current?.stop(); if (live.ready && previewVersion) void syncWorkspaceFrame();
    }
  }, [canvasOpen, connectCanvasSurface, live, previewVersion, settings.vision.frameRate, settings.vision.quality, syncWorkspaceFrame]);

  const announceRunResult = useCallback((result: TaskResult | PlanResult) => {
    const message = 'planId' in result
      ? `Planning agent ${result.status}: ${result.summary}${result.path ? ` Review ${result.path}.` : ''}`
      : `Coding agent ${result.status}: ${result.summary}`;
    if (!live.ready || live.inputBlocked || !live.sendText(`[WORKSPACE EVENT] ${message}`)) pendingCompletion.current = message;
  }, [live]);

  const announceContinuation = useCallback((run: AgentRunSnapshot) => {
    if (run.kind !== 'planning' || run.status !== 'awaiting_continuation' || !run.continuation || announcedContinuations.current.has(`${run.id}:${run.continuation.segment}`)) return;
    announcedContinuations.current.add(`${run.id}:${run.continuation.segment}`);
    const message = `Planning run ${run.id} paused after ${run.continuation.interactionCount} interactions: ${run.continuation.message} Ask the user whether they want this same planning run to continue.`;
    if (!live.ready || live.inputBlocked || !live.sendText(`[WORKSPACE EVENT] ${message}`)) pendingCompletion.current = message;
  }, [live]);

  const startWatching = useCallback((run: AgentRunSnapshot, reset = true) => {
    if (watchedRuns.current.has(run.id)) return;
    watchedRuns.current.add(run.id); if (reset) setEvents([]); setTask(run); setTerminalOpen(true);
    void watchAgentRun(run.id, (event) => {
      setEvents((items) => [...items, event]); const liveVersion = (event.data as { previewVersion?: unknown } | undefined)?.previewVersion;
      if (typeof liveVersion === 'string') setPreviewVersion(liveVersion);
    }, (snapshot) => { setTask(snapshot); announceContinuation(snapshot); }).then((result) => {
      if ('planId' in result) {
        if (result.status === 'completed' && result.path) { setFocusFile(result.path); setFileRefreshKey((value) => value + 1); setFileManagerOpen(true); setTerminalOpen(false); }
      } else if (result.previewVersion) setPreviewVersion(result.previewVersion);
      announceRunResult(result);
    }).catch((reason) => reportError((reason as Error).message)).finally(() => watchedRuns.current.delete(run.id));
  }, [announceContinuation, announceRunResult, reportError]);

  const delegate = useCallback(async (call: LiveFunctionCall): Promise<TaskSnapshot> => {
    const objective = String(call.args?.objective || '').trim();
    if (!objective) throw new Error('The coding task had no objective.');
    const grant = await referenceGrant.current;
    const created = await createTask({
      objective, successCriteria: Array.isArray(call.args?.successCriteria) ? call.args!.successCriteria as string[] : [],
      selectedElement: call.args?.useSelectedElement === false ? undefined : selection, includeCanvasImage: call.args?.includeWorkspacePreview === true,
      selectedFiles, referenceGrantId: grant?.id,
    });
    startWatching(created); return created;
  }, [selection, selectedFiles, startWatching]);

  const delegatePlan = useCallback(async (call: LiveFunctionCall) => {
    const objective = String(call.args?.objective || '').trim(); if (!objective) throw new Error('The planning task had no objective.');
    const grant = await referenceGrant.current;
    const created = await createPlan({
      objective, successCriteria: Array.isArray(call.args?.successCriteria) ? call.args!.successCriteria as string[] : [],
      selectedElement: call.args?.useSelectedElement === false ? undefined : selection, includeCanvasImage: call.args?.includeWorkspacePreview === true,
      selectedFiles, referenceGrantId: grant?.id,
    });
    startWatching(created); return created;
  }, [selection, selectedFiles, startWatching]);

  const beginPlanExecution = useCallback(async (path: string, expectedHash?: string) => {
    const created = await executePlan(path, expectedHash); setFileManagerOpen(false); startWatching(created); return created;
  }, [startWatching]);

  useEffect(() => {
    let cancelled = false;
    void getActiveRun().then(async (active) => {
      if (cancelled) return;
      if (active) { startWatching(active); return; }
      const pending = await getPendingPlan();
      if (!cancelled && pending?.path) { setFocusFile(pending.path); setFileManagerOpen(true); setFileRefreshKey((value) => value + 1); }
    }).catch((reason) => { if (!cancelled) reportError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [reportError, startWatching]);

  useEffect(() => {
    if (!workspaceId) return; let active = true; let mediaMarker = '';
    const refresh = () => void listMediaJobs().then((jobs) => {
      if (!active) return; const nextMarker = jobs.map((job) => `${job.id}:${job.updatedAt}:${job.previewVersion || ''}`).join('|');
      if (nextMarker !== mediaMarker) {
        mediaMarker = nextMarker;
        void getActiveWorkspace().then((current) => { if (active && current.id === workspaceId) setPreviewVersion(current.version); }).catch(() => undefined);
      }
      const stored = localStorage.getItem(`cowork.animation-editor.${workspaceId}`); const dismissed = localStorage.getItem(`cowork.animation-editor-dismissed.${workspaceId}`); const candidate = jobs.find((job) => job.id === stored && job.request.kind === 'animation') || jobs.find((job) => job.id !== dismissed && job.request.kind === 'animation' && ['review', 'completed'].includes(job.status));
      if (candidate) { setAnimationEditorJobId(candidate.id); localStorage.setItem(`cowork.animation-editor.${workspaceId}`, candidate.id); }
    }).catch(() => undefined);
    refresh(); const timer = window.setInterval(refresh, 2500); return () => { active = false; clearInterval(timer); };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const updateSnapshot = (work: WorkItemSnapshot) => setWorks((items) => [...items.filter((item) => item.id !== work.id), work]);
    const close = watchWorkFeed(workspaceId, setWorks, (event) => {
      if (event.type === 'work_snapshot') {
        updateSnapshot(event.work); if (event.work.result?.previewVersion) setPreviewVersion(event.work.result.previewVersion);
        if (event.work.status === 'awaiting_approval' && event.work.plan) { setFocusFile(event.work.plan.path); setFileRefreshKey((value) => value + 1); setFileManagerOpen(true); }
      } else if (event.type === 'work_removed') setWorks((items) => items.filter((item) => item.id !== event.workId));
      else if (event.type === 'activity_event') {
        setWorkEvents((items) => ({ ...items, [event.workId]: [...(items[event.workId] || []), event.event].slice(-500) }));
        const liveVersion = (event.event.data as { previewVersion?: unknown } | undefined)?.previewVersion; if (typeof liveVersion === 'string') setPreviewVersion(liveVersion);
      }
      else if (event.type === 'work_notice') {
        const message = `${event.message} Task ${event.workId}.`;
        if (!live.ready || live.inputBlocked || !live.sendText(`[WORKSPACE EVENT] ${message}`)) pendingCompletion.current = message;
      }
    });
    void listWork().then(setWorks).catch(() => undefined); return close;
  }, [live, workspaceId]);

  const performUpload = useCallback(async (files: File[], destination?: string) => {
    const sequence = ++uploadSequence.current;
    setUploadProgress(0);
    try {
      const result = await uploadFiles(files, { destination, accept: destination !== undefined ? 'file' : undefined, onProgress: (progress) => {
        if (uploadSequence.current !== sequence) return;
        setUploadProgress(progress >= 0.995 ? undefined : progress);
      } });
      setPreviewVersion(result.version); setFileRefreshKey((value) => value + 1);
      return result;
    } finally { if (uploadSequence.current === sequence) setUploadProgress(undefined); }
  }, []);

  const importWorkspaceFiles = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return;
    try {
      const result = await performUpload(incoming);
      if (!fileManagerOpen) { setFocusFile(result.value.at(-1)?.path); setFileManagerOpen(true); }
    } catch (reason) { reportError((reason as Error).message); }
  }, [fileManagerOpen, performUpload, reportError]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
    const isSpecialTarget = (event: DragEvent) => !!(event.target as Element | null)?.closest('[data-canvas-dropzone], [data-file-dropzone], .file-manager-window');
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; if (isSpecialTarget(event)) { dragDepth.current = 0; setDropActive(false); return; } event.preventDefault(); dragDepth.current++; setDropActive(true); };
    const over = (event: DragEvent) => { if (!hasFiles(event)) return; if (isSpecialTarget(event)) { dragDepth.current = 0; setDropActive(false); return; } event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    const leave = (event: DragEvent) => { if (!hasFiles(event) || isSpecialTarget(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropActive(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event) || isSpecialTarget(event)) return;
      event.preventDefault(); dragDepth.current = 0; setDropActive(false);
      void importWorkspaceFiles(Array.from(event.dataTransfer?.files || []));
    };
    window.addEventListener('dragenter', enter, true); window.addEventListener('dragover', over, true); window.addEventListener('dragleave', leave, true); window.addEventListener('drop', drop, true);
    return () => { window.removeEventListener('dragenter', enter, true); window.removeEventListener('dragover', over, true); window.removeEventListener('dragleave', leave, true); window.removeEventListener('drop', drop, true); };
  }, [importWorkspaceFiles]);

  const captureSelectedElement = useCallback(async (padding: unknown) => {
    if (!selection) throw new Error('No workspace element is currently selected. Ask the user to select one first.');
    const response = await fetch('/api/workspace/selection-snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selection, workspaceId, version: previewVersion,
        viewport: { width: iframe.current?.clientWidth, height: iframe.current?.clientHeight },
        padding: typeof padding === 'number' ? padding : 24,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})); throw new Error(body.error || `Element capture failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    live.sendVideo(bytesToBase64(bytes));
    return {
      imageSentToVision: true,
      workspaceVersion: response.headers.get('x-workspace-version'),
      width: Number(response.headers.get('x-capture-width')),
      height: Number(response.headers.get('x-capture-height')),
      selectedElement: selection.kind === 'dom'
        ? { kind: selection.kind, identifier: selection.identifier, selector: selection.selector, text: selection.text, tagName: selection.tagName }
        : { kind: selection.kind, identifier: selection.identifier, canvasId: selection.canvasId, layerId: selection.layerId, label: selection.label },
    };
  }, [live, previewVersion, selection, workspaceId]);

  useEffect(() => {
    live.onToolCalls = async (calls) => {
      live.inputBlocked = false;
      let responses: Array<{ id: string; name: string; response: { result?: unknown; error?: string } }>;
      try { responses = await live.executeToolCalls(calls, async (call) => {
        try {
          let result: unknown;
          if (call.name === 'submit_work') {
            const objective = String(call.args?.objective || '');
            const grant = await referenceGrant.current; result = await submitWork({
              objective, strategy: call.args?.strategy as any, dedupeMode: call.args?.dedupeMode as any, clientRequestId: call.id,
              preferredAgentId: call.args?.preferredAgentId ? String(call.args.preferredAgentId) : undefined,
              successCriteria: Array.isArray(call.args?.successCriteria) ? call.args.successCriteria.map(String) : [], selectedElement: call.args?.useSelectedElement === false ? undefined : selection,
              selectedFiles, includeCanvasImage: call.args?.includeWorkspacePreview === true, referenceGrantId: grant?.id,
            });
          }
          else if (call.name === 'update_work') result = await updateWork(String(call.args?.taskId || ''), { text: String(call.args?.change || ''), successCriteria: Array.isArray(call.args?.successCriteria) ? call.args.successCriteria.map(String) : [] }, call.args?.mode as any, typeof call.args?.expectedRevision === 'number' ? call.args.expectedRevision : undefined);
          else if (call.name === 'cancel_work') result = await cancelWork(String(call.args?.taskId || ''));
          else if (call.name === 'get_work_status') result = call.args?.taskId ? await getWork(String(call.args.taskId)) : await listWork();
          else if (call.name === 'approve_work_plan') result = await approveWorkPlan(String(call.args?.taskId || ''), String(call.args?.path || ''), call.args?.hash ? String(call.args.hash) : undefined);
          else if (call.name === 'answer_work_question') {
            const response = await fetch(`/api/work/${encodeURIComponent(String(call.args?.taskId || ''))}/questions/${encodeURIComponent(String(call.args?.questionId || ''))}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: String(call.args?.answer || '') }) });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not answer the task question.'); result = await response.json();
          }
          else if (call.name === 'delegate_coding_task') result = await delegate(call);
          else if (call.name === 'create_implementation_plan') result = await delegatePlan(call);
          else if (call.name === 'execute_implementation_plan') result = await beginPlanExecution(String(call.args?.path || ''));
          else if (call.name === 'respond_to_planning_continuation') result = await continuePlan(String(call.args?.runId || ''), call.args?.continue !== false);
          else if (call.name === 'open_ui_component') {
            const component = String(call.args?.component || ''); const params = call.args?.params && typeof call.args.params === 'object' ? call.args.params as Record<string, unknown> : {};
            if (component === 'file_manager') {
              if (params.addPaths !== undefined || params.tool !== undefined) throw new Error('Image Editor parameters cannot be used with the file manager.');
              const revealPath = typeof params.revealPath === 'string' ? params.revealPath : undefined;
              const selectPaths = Array.isArray(params.selectPaths) ? params.selectPaths.map(String).filter(Boolean) : [];
              if (revealPath) { setFocusFile(revealPath); setFileRefreshKey((value) => value + 1); } if (selectPaths.length) setSelectedFiles((current) => [...new Set([...current, ...selectPaths])]);
              setFileManagerOpen(true); result = { component, open: true, revealPath: revealPath || null, selectedPaths: selectPaths };
            } else if (component === 'image_editor') {
              if (params.revealPath !== undefined || params.selectPaths !== undefined) throw new Error('File-manager parameters cannot be used with the Image Editor.');
              const panel = await openCanvasPanel(); const addPaths = Array.isArray(params.addPaths) ? params.addPaths.map(String).filter(Boolean) : [];
              const tool = typeof params.tool === 'string' && ['select', 'pan', 'brush', 'eraser', 'picker', 'magic'].includes(params.tool) ? params.tool as any : undefined;
              if (tool) panel.setTool(tool); const layerIds = addPaths.length ? await panel.addWorkspaceImages(addPaths) : [];
              result = { component, open: true, addedPaths: addPaths, layerIds, tool: tool || panel.getContext().tool };
            } else throw new Error('Unknown UI component. Use file_manager or image_editor.');
          } else if (call.name === 'get_coding_task_status' || call.name === 'get_agent_run_status') {
            const active = await getActiveRun(); result = { active: !!active, run: active };
          } else if (call.name === 'get_selected_element_context') {
            result = { selected: !!selection, workspaceVersion: previewVersion, element: selection || null };
          } else if (call.name === 'capture_selected_element_image') {
            result = await captureSelectedElement(call.args?.padding);
          } else if (call.name === 'get_selected_files_context') {
            result = { selected: selectedFiles.length > 0, files: selectedFiles, activeFile: focusFile || null };
          } else if (call.name === 'get_workspace_settings') {
            result = settings;
          } else if (call.name === 'list_workspace_files') {
            result = await listFiles(String(call.args?.path || '.'));
          } else if (call.name === 'search_workspace_files') {
            result = await searchFiles(String(call.args?.query || ''), String(call.args?.path || '.'));
          } else if (call.name === 'read_workspace_file') {
            result = await readFile(String(call.args?.path || ''));
          } else if (['list_reference_workspace_files', 'search_reference_workspace_files', 'read_reference_workspace_file', 'copy_reference_workspace_file'].includes(call.name)) {
            const grant = await referenceGrant.current;
            if (!grant?.workspaceIds.length) throw new Error('Name the source workspace explicitly in this request before accessing it.');
            const common = { grantId: grant.id, workspace: String(call.args?.workspace || '') };
            if (call.name === 'list_reference_workspace_files') result = await referenceOperation('list', { ...common, path: String(call.args?.path || '.') });
            if (call.name === 'search_reference_workspace_files') result = await referenceOperation('search', { ...common, query: String(call.args?.query || ''), path: String(call.args?.path || '.') });
            if (call.name === 'read_reference_workspace_file') result = await referenceOperation('read', { ...common, path: String(call.args?.path || '') });
            if (call.name === 'copy_reference_workspace_file') {
              result = await referenceOperation<any>('copy', { ...common, sourcePath: String(call.args?.sourcePath || ''), destinationPath: String(call.args?.destinationPath || '') });
              if ((result as any)?.version) { setPreviewVersion((result as any).version); setFileRefreshKey((value) => value + 1); }
            }
          } else if (call.name === 'edit_workspace_files') {
            if (!settings.liveAgent.directFileEdits) throw new Error('Direct Live-agent file edits are disabled in Workspace Settings.');
            result = await editFiles(Array.isArray(call.args?.edits) ? call.args!.edits as any[] : [], call.id); if ((result as any).version) { setPreviewVersion((result as any).version); setFileRefreshKey((value) => value + 1); }
          } else result = avatar.current?.runTool(call.name, call.args || {}) || { ok: false, error: 'avatar unavailable' };
          return { id: call.id, name: call.name, response: { result } };
        } catch (reason) {
          const message = (reason as Error).message; reportError(message);
          return { id: call.id, name: call.name, response: { error: message } };
        }
      }); } catch (reason) {
        const message = (reason as Error).message; reportError(message); responses = calls.map((call) => ({ id: call.id, name: call.name, response: { error: message } }));
      }
      live.inputBlocked = false;
      if (!live.sendToolResponse(responses)) {
        pendingCompletion.current = `An agent tool finished while the Live connection was unavailable: ${JSON.stringify(responses.map((item) => item.response))}`;
        live.connect();
      }
    };
  }, [beginPlanExecution, captureSelectedElement, delegate, delegatePlan, focusFile, live, openCanvasPanel, previewVersion, reportError, selectedFiles, selection, settings]);

  const toggleMic = async () => {
    avatar.current?.ensureAudio();
    if (mic.active) { mic.stop(); setMicOn(false); return; }
    if (!live.ready) live.connect();
    try { await mic.start(); setMicOn(true); } catch (reason) { reportError(`Microphone unavailable: ${(reason as Error).message}`); }
  };

  const toggleVision = async () => {
    if (canvasOpen) { reportError('The Image Editor is shared with the Live agent automatically while it is open.'); return; }
    if (vision.current?.active) { vision.current.stop(); setVisionOn(false); return; }
    if (!captureTarget.current) return;
    if (settings.mode === 'canvas' && !canvasStatus.compatible) { reportError('Canvas vision requires a primary canvas and Cowork layer adapter.'); return; }
    if (!live.ready) live.connect();
    vision.current = new CanvasVision(live, captureTarget.current, { mode: settings.mode, frameRate: settings.vision.frameRate, quality: settings.vision.quality, canvasRestrictionTarget: canvasStatus.restrictionTarget });
    try { await vision.current.start(); setVisionOn(true); } catch (reason) { reportError((reason as Error).message); }
  };

  const applyWorkspaceResult = async (result: WorkspaceLifecycleResult) => {
    const reconnect = !!live.ws || mic.active;
    await canvasPanel.current?.flush().catch(() => undefined); surfaceVision.current?.stop();
    vision.current?.stop(); setVisionOn(false); clearSelection(); setSelectedFiles([]); setFocusFile(undefined); setFileManagerOpen(false); setCanvasOpen(false); setFileRefreshKey((value) => value + 1);
    clearCaptionTimers(); captionRef.current = ''; setCaptionFading(false);
    setTask(undefined); setEvents([]); setTerminalOpen(false); setCaption(''); setCanvasStatus({ compatible: false });
    setWorkspaceId(result.workspaceId); setPreviewVersion(result.version); setCatalog(result.catalog); setSettings(result.settings);
    referenceGrant.current = undefined; referenceGrantId.current = undefined;
    live.resetWorkspace(result.settings, result.catalog); if (reconnect) live.connect();
  };
  const createManagedWorkspace = async (name: string, mode: WorkspaceMode) => applyWorkspaceResult(await createWorkspace(name, mode));
  const activateManagedWorkspace = async (id: string) => applyWorkspaceResult(await activateWorkspace(id));
  const duplicateManagedWorkspace = async (id: string, name: string) => applyWorkspaceResult(await duplicateWorkspace(id, name));
  const renameManagedWorkspace = async (id: string, name: string) => { const next = await renameWorkspace(id, name); setCatalog(next); live.configure(settings, next); if (live.ready) live.restartForConfiguration(); };
  const deleteManagedWorkspace = async (id: string) => { const next = await deleteWorkspace(id); await deleteCanvasDocument(id).catch((reason) => reportError((reason as Error).message)); setCatalog(next); live.configure(settings, next); if (live.ready) live.restartForConfiguration(); };

  const saveSettings = async (next: WorkspaceSettings) => {
    const saved = await saveWorkspaceSettings(next); const nextCatalog = { ...catalog, workspaces: catalog.workspaces.map((item) => item.active ? { ...item, mode: saved.mode } : item) }; setSettings(saved); setCatalog(nextCatalog); live.configure(saved, nextCatalog);
    if ((saved.mode === 'canvas' && selection?.kind !== 'canvas') || (saved.mode === 'dom' && selection?.kind !== 'dom')) clearSelection();
    if (vision.current?.active) {
      try { await vision.current.configure({ mode: saved.mode, frameRate: saved.vision.frameRate, quality: saved.vision.quality, canvasRestrictionTarget: canvasStatus.restrictionTarget }); setVisionOn(vision.current.active); }
      catch (reason) { setVisionOn(false); reportError((reason as Error).message); }
    }
    setSettingsOpen(false);
    live.restartForConfiguration();
  };

  const previewAssistantAppearance = useCallback((appearance: AvatarAppearanceSettings) => { avatar.current?.configureAppearance(appearance); }, []);
  const previewAssistantPhoto = useCallback(async (photo: File | null) => {
    if (photo) await avatar.current?.applyPhoto(photo); else avatar.current?.clearPhoto();
  }, []);
  const restoreAssistant = useCallback(async () => {
    if (!avatar.current) return;
    if (assistantPhotoRef.current) await avatar.current.applyPhoto(blobAsFile(assistantPhotoRef.current)); else avatar.current.clearPhoto();
    avatar.current.configureAppearance(assistantProfileRef.current.settings.appearance);
  }, []);
  const saveAssistant = useCallback(async (next: AssistantSettings, photoAction: 'keep' | 'replace' | 'remove', photo?: File) => {
    const previous = assistantProfileRef.current.settings;
    const saved = await saveAssistantProfile(next, photoAction, photo);
    const savedPhoto = saved.hasPhoto ? await getAssistantPhoto(saved.photoVersion) : undefined;
    assistantProfileRef.current = saved; assistantPhotoRef.current = savedPhoto; setAssistantProfile(saved); setAssistantPhoto(savedPhoto); setAssistantPhotoReady(true);
    live.configureAssistant(saved.settings);
    if (previous.voice !== saved.settings.voice || previous.personalityPrompt !== saved.settings.personalityPrompt) live.restartForConfiguration();
    if (avatar.current) {
      if (savedPhoto) await avatar.current.applyPhoto(blobAsFile(savedPhoto)); else avatar.current.clearPhoto();
      avatar.current.configureAppearance(saved.settings.appearance);
    }
  }, [live]);

  const previewUiTheme = useCallback((theme: UiTheme) => { applyUiTheme(theme, false); }, []);
  const restoreUiTheme = useCallback(() => { applyUiTheme(activeUiTheme(uiThemeProfile), true); }, [uiThemeProfile]);
  const saveUiThemes = useCallback(async (profile: UiThemeProfile) => {
    const saved = await saveUiThemeProfile(profile); setUiThemeProfile(saved); applyUiTheme(activeUiTheme(saved), true);
  }, []);

  const sendText = (text: string) => {
    avatar.current?.ensureAudio();
    authorizeUserTurn(text);
    updateCaption(text, true);
    const elementContext = selection ? selection.kind === 'dom'
      ? `\n\n[CURRENT USER-SELECTION CONTEXT]\nKind: DOM\nIdentifier: ${selection.identifier}\nSelector: ${selection.selector}\nElement: ${selection.tagName}\nVisible text: ${JSON.stringify(selection.text)}\nAttributes: ${JSON.stringify(selection.attributes)}`
      : `\n\n[CURRENT USER-SELECTION CONTEXT]\nKind: canvas layer\nIdentifier: ${selection.identifier}\nCanvas: ${selection.canvasId}\nLayer: ${selection.layerId}\nLabel: ${selection.label}\nType: ${selection.layerType}\nProperties: ${JSON.stringify(selection.properties)}` : '';
    const fileContext = selectedFiles.length ? `\n\n[SELECTED WORKSPACE FILES]\n${selectedFiles.map((path) => `- ${path}`).join('\n')}` : '';
    const outgoing = `${text}${elementContext}${fileContext}`;
    if (live.sendText(outgoing)) return;
    live.connect();
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (live.ready) { live.sendText(outgoing); clearInterval(timer); }
      else if (Date.now() - started > 8000) { clearInterval(timer); reportError('Could not connect to Gemini Live.'); }
    }, 150);
  };

  const todoProgress = task?.kind === 'coding' && task.todos.length ? `${task.todos.filter((item) => item.status === 'completed').length}/${task.todos.length} steps` : '';
  const runLabel = task?.kind === 'planning' ? 'Planning agent' : 'Coding agent';
  const toolbar = <>
    <IconButton label={micOn ? 'Mute microphone' : 'Start microphone'} active={micOn} onClick={() => void toggleMic()}><Icon path={paths.mic} /></IconButton>
    <IconButton label="Open chat" active={chatOpen} onClick={() => setChatOpen((open) => !open)}><Icon path={paths.chat} /></IconButton>
    <IconButton label={visionOn ? 'Stop workspace vision' : 'Share workspace with live agent'} active={visionOn} onClick={() => void toggleVision()}><Icon path={paths.eye} /></IconButton>
    <IconButton label={selectMode ? 'Cancel element selection' : 'Select a workspace element'} active={selectMode} onClick={() => {
      if (selectMode) { clearSelection(); return; }
      if (settings.mode === 'canvas' && !canvasStatus.compatible) { reportError('Canvas selection requires a primary canvas and Cowork layer adapter.'); return; }
      setSelectMode(true);
    }}><Icon path={paths.select} /></IconButton>
    <IconButton label="Open workspace files" active={fileManagerOpen} onClick={() => setFileManagerOpen(true)}><Icon path={paths.folder} /></IconButton>
    <IconButton label="Open Image Editor" active={canvasOpen} onClick={() => { void openCanvasPanel(); }}><Icon path={paths.canvas} /></IconButton>
  </>;

  const avatarHeaderActions = <>
    <IconButton label="Configure assistant appearance and personality" active={assistantOpen} onClick={() => setAssistantOpen(true)}><Icon path={paths.face} /></IconButton>
    <IconButton label="Customize UI theme" active={uiThemesOpen} onClick={() => setUiThemesOpen(true)}><Icon path={paths.palette} /></IconButton>
    <IconButton label="Configure subagents, tools, skills, secrets, and routing" active={agentsOpen} onClick={() => setAgentsOpen(true)}><Icon path={paths.agents} /></IconButton>
    <IconButton label={`Open activity center${activityUnresolved ? ` (${activityUnresolved} unresolved)` : ''}`} active={activityOpen} onClick={() => setActivityOpen(true)}><span className="activity-icon"><Icon path={paths.activity} />{activityUnresolved > 0 && <b>{Math.min(99, activityUnresolved)}</b>}</span></IconButton>
    <IconButton label="Open workspace settings" active={settingsOpen} onClick={() => setSettingsOpen(true)}><Icon path={paths.settings} /></IconButton>
  </>;

  const avatarCanvasControls = <>
    <IconButton label={subtitlesOn ? 'Hide subtitles' : 'Show subtitles'} active={subtitlesOn} aria-pressed={subtitlesOn} onClick={() => setSubtitlesOn((value) => !value)}><Icon path={paths.subtitles} /></IconButton>
    <IconButton label={voiceMuted ? 'Unmute assistant voice' : 'Mute assistant voice'} active={voiceMuted} aria-pressed={voiceMuted} onClick={() => setVoiceMuted((value) => !value)}><Icon path={voiceMuted ? paths.volumeMuted : paths.volume} /></IconButton>
  </>;

  return (
    <div className="app-shell">
      {previewVersion
        ? <WorkspaceStage key={workspaceId} ref={iframe} version={previewVersion} mode={settings.mode} selectMode={selectMode} onCaptureTarget={(element) => { captureTarget.current = element; }} onCanvasStatus={setCanvasStatus} onSelection={setSelection} onExternalDrag={setDropActive} onExternalFiles={importWorkspaceFiles} />
        : <main className="workspace-stage workspace-loading"><span className="spinner" /> Restoring your workspace…</main>}
      <div className="status-pill"><span className={`status-led ${liveStatus}`} />{`live · ${liveStatus}`}</div>
      {selection && <div className="selection-pill"><span>Selected</span><strong>{selection.kind === 'dom' ? selection.text || selection.selector : selection.label}</strong><button onClick={clearSelection} aria-label="Clear selected element">×</button></div>}
      {!!selectedFiles.length && <div className={`selection-pill file-selection-pill ${selection ? 'with-element' : ''}`}><span>Files</span><strong>{selectedFiles.join(', ')}</strong><button onClick={() => setSelectedFiles([])} aria-label="Clear selected files">×</button></div>}
      <AvatarPanel caption={subtitlesOn ? caption : ''} captionFading={captionFading} canvasControls={avatarCanvasControls} toolbar={toolbar} headerActions={avatarHeaderActions} onReady={avatarReady} onError={reportError} />
      <ChatTray open={chatOpen} caption={caption} disabled={false} onClose={() => setChatOpen(false)} onSend={sendText} />
      {taskBusy && <button className={`task-beacon ${task?.kind || ''}`} onClick={() => setTerminalOpen(true)}>{task?.status === 'awaiting_continuation' ? <span className="continuation-mark">?</span> : <span className="spinner" />} {runLabel} · {todoProgress || task?.status}</button>}
      {!!activeWorks.length && <button className="work-beacon" onClick={() => setWorkCenterOpen(true)}><span className="spinner" /> {activeWorks.filter((work) => ['running', 'planning', 'integrating', 'validating', 'publishing'].includes(work.status)).length} active · {activeWorks.filter((work) => work.status === 'queued').length} queued{activeWorks.some((work) => ['needs_input', 'awaiting_approval'].includes(work.status)) ? ' · action needed' : ''}</button>}
      <AgentTerminal open={terminalOpen} task={task} events={events} onClose={() => setTerminalOpen(false)} onContinue={() => { if (task?.kind === 'planning') void continuePlan(task.id, true).catch((reason) => reportError((reason as Error).message)); }} onCancel={() => task && void (task.kind === 'planning' ? cancelPlan(task.id) : cancelTask(task.id))} onOpenMedia={(id) => { setAnimationEditorJobId(id); localStorage.removeItem(`cowork.animation-editor-dismissed.${workspaceId}`); localStorage.setItem(`cowork.animation-editor.${workspaceId}`, id); }} />
      <WorkCenter open={workCenterOpen} works={works} events={workEvents} onClose={() => setWorkCenterOpen(false)} onCancel={(id) => void cancelWork(id).catch((reason) => reportError((reason as Error).message))} onApprove={(work) => { if (work.plan) void approveWorkPlan(work.id, work.plan.path, work.plan.hash).catch((reason) => reportError((reason as Error).message)); }} />
      <ActivityPanel open={activityOpen} onClose={() => setActivityOpen(false)} onError={reportError} onVersion={setPreviewVersion} onReconnectLive={() => live.restartForConfiguration()} onOpenRun={() => activeWorks.length ? setWorkCenterOpen(true) : setTerminalOpen(true)} onOpenFile={(path) => { setFocusFile(path); setFileRefreshKey((value) => value + 1); setFileManagerOpen(true); }} onAskLive={sendText} />
      {fileManagerOpen && <Suspense fallback={<div className="toast">Opening workspace files…</div>}><FileManager focusPath={focusFile} refreshKey={fileRefreshKey} selectedPaths={selectedFiles} onSelectedPaths={setSelectedFiles} onUpload={(files, destination) => performUpload(files, destination)} onExecutePlan={beginPlanExecution} onClose={() => setFileManagerOpen(false)} onVersion={setPreviewVersion} onError={reportError} /></Suspense>}
      {canvasLoaded && <Suspense fallback={<div className="toast">Opening Image Editor…</div>}><CanvasPanel ref={canvasPanel} open={canvasOpen} workspaceId={workspaceId} busyMessage={canvasBusy} visionActive={canvasOpen && liveStatus === 'ready'} onCompositeChange={connectCanvasSurface} onClose={() => { setCanvasOpen(false); void canvasPanel.current?.flush(); }} onError={reportError} onSaved={(path, version) => { setPreviewVersion(version); setFileRefreshKey((value) => value + 1); if (path) setFocusFile(path); }} /></Suspense>}
      {animationEditorJobId && <Suspense fallback={<div className="toast">Opening Animation Editor…</div>}><AnimationEditorPanel jobId={animationEditorJobId} onClose={() => { localStorage.setItem(`cowork.animation-editor-dismissed.${workspaceId}`, animationEditorJobId); setAnimationEditorJobId(undefined); localStorage.removeItem(`cowork.animation-editor.${workspaceId}`); }} onError={reportError} onSaved={(paths, version) => { if (version) setPreviewVersion(version); setFileRefreshKey((value) => value + 1); setFocusFile(paths[0]); }} /></Suspense>}
      {settingsOpen && <WorkspaceSettingsPanel settings={settings} catalog={catalog} canvasCompatible={canvasStatus.compatible} taskBusy={taskBusy} onSave={saveSettings} onCreate={createManagedWorkspace} onActivate={activateManagedWorkspace} onDuplicate={duplicateManagedWorkspace} onRename={renameManagedWorkspace} onDelete={deleteManagedWorkspace} onClose={() => setSettingsOpen(false)} />}
      {assistantOpen && assistantPhotoReady && <AssistantSettingsPanel profile={assistantProfile} onPreviewAppearance={previewAssistantAppearance} onPreviewPhoto={previewAssistantPhoto} onSave={saveAssistant} onCancel={restoreAssistant} onError={reportError} onClose={() => setAssistantOpen(false)} />}
      {uiThemesOpen && <UiThemePanel profile={uiThemeProfile} onPreview={previewUiTheme} onSave={saveUiThemes} onCancel={restoreUiTheme} onError={reportError} onClose={() => setUiThemesOpen(false)} />}
      {agentsOpen && <AgentsPanel workspaceId={workspaceId} onError={reportError} onClose={() => setAgentsOpen(false)} />}
      {(dropActive || uploadProgress !== undefined) && <div className="drop-overlay"><div><Icon path={paths.folder} /><strong>{uploadProgress === undefined ? 'Drop media into the workspace' : 'Adding media…'}</strong><span>{uploadProgress === undefined ? 'Images become WebP · audio and video keep their format' : `${Math.round(uploadProgress * 100)}%`}</span>{uploadProgress !== undefined && <progress max={1} value={uploadProgress} />}</div></div>}
      {error && <div className="toast" role="alert">{error}</div>}
    </div>
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function blobAsFile(blob: Blob) { return new File([blob], 'assistant-face.webp', { type: blob.type || 'image/webp' }); }
