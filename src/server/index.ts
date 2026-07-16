import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { ActivityHub } from './activity.js';
import { WorkspaceManager } from './workspace/WorkspaceManager.js';
import { WorkspaceTools } from './workspace/WorkspaceTools.js';
import { CodingAgent } from './agent/CodingAgent.js';
import { TaskManager } from './agent/TaskManager.js';
import { PlanningAgent } from './agent/PlanningAgent.js';
import { PlanManager } from './agent/PlanManager.js';
import { PlanStore } from './agent/PlanStore.js';
import { LiveProxy } from './live/LiveProxy.js';
import type { TaskRequest, WorkspaceMode } from '../shared/protocol.js';
import { AssetService } from './workspace/AssetService.js';
import { WorkspaceFiles } from './workspace/WorkspaceFiles.js';
import { WorkspaceGit } from './workspace/WorkspaceGit.js';
import { WorkspaceMutationLock } from './workspace/WorkspaceMutationLock.js';
import { WorkspaceChangeService } from './workspace/WorkspaceChangeService.js';
import { UploadService } from './workspace/UploadService.js';
import { WorkspaceSettingsService } from './workspace/WorkspaceSettingsService.js';
import { AssistantSettingsService } from './assistant/AssistantSettingsService.js';
import { WorkspaceRegistry, type WorkspaceContext } from './workspace/WorkspaceRegistry.js';
import { WorkspaceReferenceGrants } from './workspace/WorkspaceReferenceGrants.js';
import { ImageProcessingService } from './workspace/ImageProcessingService.js';
import { MediaJobManager } from './media/MediaJobManager.js';
import type { MediaJobRequest, MediaStageName } from '../shared/protocol.js';

const activity = new ActivityHub();
const registry = new WorkspaceRegistry();
const workspace = new WorkspaceManager(activity, registry);
const assets = new AssetService(activity, registry);
const imageProcessing = new ImageProcessingService(registry);
const files = new WorkspaceFiles(registry);
const git = new WorkspaceGit(registry);
const lock = new WorkspaceMutationLock();
const uploads = new UploadService(registry);
const settings = new WorkspaceSettingsService(registry);
const mediaJobs = new MediaJobManager(registry, activity, lock, async (taskId, workspaceId) => {
  if (!registry.isActive(workspaceId)) throw statusError('The media workspace is no longer active.', 409);
  return workspace.publish(taskId, { mode: settings.get(workspaceId).mode });
});
const assistantSettings = new AssistantSettingsService();
const grants = new WorkspaceReferenceGrants(registry);
const tools = new WorkspaceTools(workspace, activity, registry, assets, imageProcessing, mediaJobs);
const changes = new WorkspaceChangeService(workspace, tools, files, lock, settings, activity);
const codingAgent = new CodingAgent(tools, activity);
const planStore = new PlanStore(registry);
const tasks = new TaskManager(codingAgent, tools, workspace, activity, lock, settings, grants, registry, planStore);
const planningAgent = new PlanningAgent(tools, activity);
const plans = new PlanManager(planningAgent, planStore, tools, activity, lock, settings, grants, registry);
const live = new LiveProxy();
const serverStartedAt = new Date().toISOString();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use((request, response, next) => {
  const requestId = randomUUID(); response.setHeader('x-request-id', requestId);
  const sendJson = response.json.bind(response);
  response.json = ((body: unknown) => {
    if (response.statusCode >= 400) activity.recordFailure({
      id: `http-${requestId}`, workspaceId: safeWorkspaceId(), source: 'http', title: `${request.method} ${request.path}`,
      message: String((body as any)?.error || `HTTP ${response.statusCode}`), requestId, httpStatus: response.statusCode,
    });
    return sendJson(body);
  }) as typeof response.json;
  next();
});

app.get('/api/health', async (_request, response) => response.json({ ok: true, liveConfigured: !!config.geminiKey, workspaceId: workspace.workspaceId, workspaceVersion: workspace.version, media: await assets.readiness(), gitAvailable: true }));
app.get('/api/workspace', (_request, response) => { const active = registry.active(); response.json({ id: active.id, name: active.name, version: workspace.version, previewUrl: workspace.previewUrl }); });
app.get('/api/workspaces', async (_request, response) => response.json(await catalog()));
app.post('/api/workspaces', (request, response) => route(response, () => createAndActivate(String(request.body?.name || ''), request.body?.mode as WorkspaceMode)));
app.post('/api/workspaces/:id/activate', (request, response) => route(response, () => activate(request.params.id)));
app.post('/api/workspaces/:id/duplicate', (request, response) => route(response, () => { const source = registry.get(request.params.id); return createAndActivate(String(request.body?.name || ''), settings.get(source.id).mode, source); }));
app.patch('/api/workspaces/:id', (request, response) => route(response, () => lock.run('a workspace rename', async () => { await registry.renameWorkspace(request.params.id, String(request.body?.name || '')); grants.revokeAll(); return catalog(); })));
app.delete('/api/workspaces/:id', (request, response) => route(response, () => lock.run('a workspace deletion', async () => { await registry.remove(request.params.id); settings.forget(request.params.id); grants.revokeAll(); return catalog(); })));
app.post('/api/workspace-reference-grants', (request, response) => response.json(grants.create(String(request.body?.text || ''), request.body?.replaceId ? String(request.body.replaceId) : undefined)));
app.get('/api/workspace/settings', (_request, response) => response.json(settings.get()));
app.put('/api/workspace/settings', (request, response) => route(response, () => settings.update(request.body)));
app.get('/api/assistant/profile', (_request, response) => route(response, () => assistantSettings.getProfile()));
app.put('/api/assistant/profile', (request, response) => route(response, () => assistantSettings.updateProfile(request)));
app.get('/api/assistant/photo', async (_request, response) => {
  try { response.setHeader('cache-control', 'no-store'); response.type('image/webp').send(await assistantSettings.getPhoto()); }
  catch { response.status(404).json({ error: 'No assistant portrait is configured.' }); }
});
app.get('/api/workspace/files', async (request, response) => route(response, async () => files.list(String(request.query.path || '.'), undefined, request.query.optional === '1')));
app.get('/api/workspace/files/read', async (request, response) => route(response, async () => files.readText(String(request.query.path || ''))));
app.get('/api/workspace/files/raw', async (request, response) => {
  try {
    const file = await files.raw(String(request.query.path || '')); response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.type(file.mimeType).send(file.data);
  } catch (error) { response.status((error as any).status || 400).json({ error: (error as Error).message }); }
});
app.get('/api/workspace/files/search', async (request, response) => route(response, async () => files.search(String(request.query.q || ''), String(request.query.path || '.'))));
app.post('/api/workspace/files', async (request, response) => routeStatus(response, 201, () => changes.createFile(String(request.body?.directory || '.'), String(request.body?.name || ''))));
app.patch('/api/workspace/files', async (request, response) => route(response, () => changes.renameFile(String(request.body?.path || ''), String(request.body?.newName || ''))));
app.post('/api/workspace/files/copy', async (request, response) => route(response, () => changes.copyFile(String(request.body?.sourcePath || ''), String(request.body?.destinationDirectory || '.'))));
app.delete('/api/workspace/files', async (request, response) => route(response, async () => changes.remove(request.body?.paths)));
app.post('/api/workspace/references/list', (request, response) => route(response, () => files.list(String(request.body?.path || '.'), authorizedReference(request.body))));
app.post('/api/workspace/references/read', (request, response) => route(response, () => files.readText(String(request.body?.path || ''), authorizedReference(request.body))));
app.post('/api/workspace/references/search', (request, response) => route(response, () => files.search(String(request.body?.query || ''), String(request.body?.path || '.'), authorizedReference(request.body))));
app.post('/api/workspace/references/copy', (request, response) => route(response, () => {
  if (!settings.get().liveAgent.directFileEdits) throw statusError('Direct Live-agent file edits are disabled in Workspace Settings.', 403);
  const id = authorizedReference(request.body);
  return changes.transaction('a cross-workspace file copy', () => files.copyFrom(id, String(request.body?.sourcePath || ''), String(request.body?.destinationPath || '')));
}));
app.post('/api/workspace/files/edit', async (request, response) => route(response, async () => changes.edit(request.body?.edits, 'a direct file edit', request.body?.operationId ? String(request.body.operationId) : undefined)));
app.post('/api/workspace/uploads', async (request, response) => route(response, async () => changes.transaction('a media upload', () => uploads.receive(request))));
app.post('/api/workspace/assets/images', async (request, response) => route(response, async () => {
  const prompt = String(request.body?.prompt || '').trim(); const name = String(request.body?.name || '').trim();
  if (!prompt) throw statusError('An image prompt is required.', 400);
  if (!name) throw statusError('An image name is required.', 400);
  return changes.transaction('a Canvas image generation', () => tools.execute(`canvas-${randomUUID()}`, 'generate_image', {
    prompt, name, transparent: request.body?.transparent === true,
    referenceImages: Array.isArray(request.body?.referenceImages) ? request.body.referenceImages.map(String) : [],
    aspectRatio: request.body?.aspectRatio,
  }, () => false, settings.get().codingAgent));
}));
app.post('/api/media-jobs', (request, response) => routeStatus(response, 202, () => mediaJobs.create(request.body as MediaJobRequest)));
app.get('/api/media-jobs', (_request, response) => response.json(mediaJobs.list()));
app.get('/api/media-jobs/:id', (request, response) => route(response, () => Promise.resolve(mediaJobs.get(request.params.id))));
app.post('/api/media-jobs/:id/cancel', (request, response) => { try { response.status(mediaJobs.cancel(request.params.id) ? 202 : 409).json({ ok: true }); } catch (error) { response.status((error as any).status || 400).json({ error: (error as Error).message }); } });
app.delete('/api/media-jobs/:id', (request, response) => route(response, () => mediaJobs.discard(request.params.id)));
app.patch('/api/media-jobs/:id/settings', (request, response) => route(response, () => mediaJobs.updateSettings(request.params.id, Number(request.body?.revision), request.body)));
app.post('/api/media-jobs/:id/stages/:stage/rerun', (request, response) => routeStatus(response, 202, () => mediaJobs.rerun(request.params.id, request.params.stage as MediaStageName, Number(request.body?.revision))));
app.post('/api/media-jobs/:id/save', (request, response) => route(response, () => mediaJobs.save(request.params.id, Number(request.body?.revision), request.body?.selectedRevision ? Number(request.body.selectedRevision) : undefined)));
app.get('/api/media-jobs/:id/artifacts/:artifactId', async (request, response) => {
  try { const artifact = await mediaJobs.artifact(request.params.id, request.params.artifactId); response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.type(artifact.mimeType).send(artifact.data); }
  catch (error) { response.status((error as any).status || 400).json({ error: (error as Error).message }); }
});
app.get('/api/workspace/git/status', async (_request, response) => route(response, () => git.status()));
app.post('/api/workspace/git/commit', async (_request, response) => route(response, () => lock.run('a workspace commit', () => git.commit())));
app.get('/api/workspace/snapshot', async (_request, response) => {
  try {
    const data = await workspace.captureCurrentCanvas(true);
    if (!data) { response.status(503).json({ error: 'The persisted workspace preview is not ready.' }); return; }
    response.setHeader('x-workspace-version', workspace.version);
    response.setHeader('x-workspace-id', workspace.workspaceId);
    response.setHeader('cache-control', 'no-store');
    response.type('image/jpeg').send(Buffer.from(data, 'base64'));
  } catch (error) { response.status(500).json({ error: (error as Error).message }); }
});
app.post('/api/workspace/selection-snapshot', async (request, response) => {
  try {
    if ((request.body?.workspaceId && request.body.workspaceId !== workspace.workspaceId) || (request.body?.version && request.body.version !== workspace.version)) { response.status(409).json({ error: 'The selection belongs to another workspace or an older release.' }); return; }
    const capture = await workspace.captureSelection(request.body?.selection, request.body?.viewport, request.body?.padding);
    response.setHeader('x-workspace-version', workspace.version);
    response.setHeader('x-workspace-id', workspace.workspaceId);
    response.setHeader('x-capture-width', capture.width);
    response.setHeader('x-capture-height', capture.height);
    response.setHeader('cache-control', 'no-store');
    response.type('image/jpeg').send(Buffer.from(capture.data, 'base64'));
  } catch (error) { response.status(400).json({ error: (error as Error).message }); }
});
app.get('/api/tasks/active', (_request, response) => response.json(tasks.getActive() || null));
app.get('/api/agent-runs/active', (_request, response) => response.json(plans.getActive() || tasks.getActive() || null));
app.get('/api/activity', (request, response) => response.json(activity.list({
  workspaceId: registry.active().id, all: request.query.scope === 'all', severity: stringQuery(request.query.severity), source: stringQuery(request.query.source),
  query: stringQuery(request.query.q), cursor: stringQuery(request.query.cursor), limit: Number(request.query.limit) || undefined,
})));
app.delete('/api/activity', (_request, response) => route(response, () => activity.clearWorkspace(registry.active().id)));
app.get('/api/activity/:id/events', (request, response) => route(response, () => activity.events(request.params.id)));
app.get('/api/activity/:id/export', async (request, response) => {
  try { const events = await activity.events(request.params.id); response.setHeader('content-disposition', `attachment; filename="${request.params.id}.jsonl"`); response.type('application/x-ndjson').send(events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')); }
  catch (error) { response.status(400).json({ error: (error as Error).message }); }
});
app.post('/api/activity/:id/resolve', (request, response) => {
  const record = activity.resolve(request.params.id, String(request.body?.resolution || 'Marked resolved'));
  response.status(record ? 200 : 404).json(record || { error: 'Activity record not found.' });
});
app.post('/api/activity/client', (request, response) => {
  const source = request.body?.source === 'live' ? 'live' : 'system'; const message = String(request.body?.message || '').trim();
  if (!message) { response.status(400).json({ error: 'An activity message is required.' }); return; }
  const operationId = String(request.body?.operationId || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
  const id = operationId ? `client-${operationId}` : `client-${randomUUID()}`; const status = ['running', 'succeeded', 'failed', 'cancelled'].includes(request.body?.status) ? request.body.status : request.body?.severity === 'error' ? 'failed' : 'succeeded';
  let record = activity.register({ id, operationId: operationId || undefined, workspaceId: registry.active().id, source, title: String(request.body?.title || (source === 'live' ? 'Live connection' : 'Client event')).slice(0, 160), message: message.slice(0, 4000), severity: status === 'failed' ? 'error' : 'info', status, paths: Array.isArray(request.body?.paths) ? request.body.paths.map(String).slice(0, 50) : undefined });
  void activity.emit(id, status === 'failed' ? 'error' : 'status', source, message.slice(0, 4000), { operationId: operationId || undefined, paths: record.paths });
  if (status !== 'running') record = activity.finish(id, status, message.slice(0, 4000), { severity: status === 'failed' ? 'error' : 'info' }) || record;
  response.status(202).json(record);
});
app.get('/api/activity/state', (_request, response) => route(response, async () => ({
  workspaceId: registry.active().id, workspaceVersion: workspace.version, lockOwner: lock.currentOwner || undefined,
  activeRun: plans.getActive() || tasks.getActive() || undefined, serverStartedAt, restartRequired: await sourceChangedSinceStart(), restartCommand: 'npm start', git: await git.status(),
})));
app.get('/api/workspace/releases', (_request, response) => route(response, () => workspace.listReleases()));
app.post('/api/recovery/preview/restart', (request, response) => route(response, () => recoveryOperation('a preview restart', (id) => workspace.restartPreview(id, settings.get().mode))));
app.post('/api/recovery/draft/restore', (request, response) => route(response, async () => {
  await assertRecoveryState(request.body); return recoveryOperation('a draft restore', () => workspace.restoreActiveDraft());
}));
app.post('/api/workspace/releases/:version/activate', (request, response) => route(response, async () => {
  await assertRecoveryState(request.body); return recoveryOperation('a release rollback', (id) => workspace.rollbackToRelease(id, request.params.version, settings.get().mode));
}));
app.get('/api/plans/pending', (_request, response) => route(response, async () => await planStore.pending() || null));
app.post('/api/plans', (request, response) => {
  try { response.status(202).json(plans.create(request.body)); }
  catch (error) { response.status((error as Error & { status?: number }).status || 400).json({ error: (error as Error).message, activeRun: plans.getActive() || tasks.getActive() }); }
});
app.put('/api/plans/content', (request, response) => route(response, () => lock.run('a plan edit', () => planStore.saveReview(String(request.body?.path || ''), String(request.body?.content || ''), request.body?.expectedHash ? String(request.body.expectedHash) : undefined))));
app.post('/api/plans/execute', (request, response) => {
  void route(response, async () => {
    const path = String(request.body?.path || ''); const record = await planStore.getByPath(path);
    const current = await planStore.read(path);
    if (request.body?.expectedHash && String(request.body.expectedHash) !== current.hash) throw statusError('The plan changed after approval. Reload it before proceeding.', 409);
    if (record) await planStore.markExecuting(record, current.hash);
    try {
      const planId = record?.id || `manual-${current.hash.slice(0, 12)}`;
      const task = tasks.create({ ...(record?.request || { objective: `Execute the reviewed implementation plan at ${path}` }), referenceGrantId: undefined, approvedPlan: { id: planId, path, hash: current.hash } }, { referenceWorkspaceIds: record?.referenceWorkspaceIds || [], approvedPlanContent: current.content });
      response.status(202); return task;
    } catch (error) { if (record) await planStore.markAwaitingReview(record).catch(() => undefined); throw error; }
  });
});
app.post('/api/plans/:id/cancel', (request, response) => response.status(plans.cancel(request.params.id) ? 202 : 404).json({ ok: true }));
app.post('/api/plans/:id/continue', (request, response) => {
  const accepted = plans.continue(request.params.id, request.body?.continue !== false);
  response.status(accepted ? 202 : 409).json(accepted ? { ok: true } : { error: 'That planning run is not waiting for a continuation decision.' });
});
app.post('/api/tasks', (request, response) => {
  try { response.status(202).json(tasks.create(request.body as TaskRequest)); }
  catch (error) { response.status((error as Error & { status?: number }).status || 400).json({ error: (error as Error).message, activeTask: tasks.getActive() }); }
});
app.get('/api/tasks/:id', (request, response) => { const task = tasks.get(request.params.id); if (!task) response.status(404).json({ error: 'Task not found' }); else response.json(task); });
app.post('/api/tasks/:id/cancel', (request, response) => response.status(tasks.cancel(request.params.id) ? 202 : 404).json({ ok: true }));

app.use('/api', (_request, response) => response.status(404).json({ error: 'API endpoint not found. The client and server may be out of date; restart the Cowork server.' }));

const clientDist = resolve('dist/client');
app.use(express.static(clientDist));
app.use((_request, response) => response.sendFile(resolve(clientDist, 'index.html')));

const server = http.createServer(app);
const activityServer = new WebSocketServer({ noServer: true });
activityServer.on('connection', (socket, request) => {
  const parameters = new URL(request.url || '/', 'http://localhost').searchParams;
  if (parameters.get('scope') === 'feed') { activity.attachFeed(socket); return; }
  const taskId = parameters.get('taskId');
  if (!taskId) { socket.close(1008, 'taskId required'); return; }
  activity.attach(taskId, socket);
});
server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  if (path === '/api/live') live.upgrade(request, socket, head);
  else if (path === '/api/activity') activityServer.handleUpgrade(request, socket, head, (ws) => activityServer.emit('connection', ws, request));
  else socket.destroy();
});

async function start() {
  await registry.initialize();
  await Promise.all([settings.initialize(), assistantSettings.initialize(), activity.initialize()]);
  await mediaJobs.initialize();
  await workspace.initialize();
  await git.initialize();
  server.listen(config.appPort, '127.0.0.1', () => {
    activity.register({ id: `system-${randomUUID()}`, workspaceId: registry.active().id, source: 'system', title: 'Cowork server started', message: `Listening on 127.0.0.1:${config.appPort}`, status: 'succeeded' });
    console.log(`Cowork server: http://127.0.0.1:${config.appPort}`);
    console.log(`Workspace preview: ${workspace.previewUrl}`);
    if (!config.geminiKey) console.warn('GEMINI_API_KEY is missing; the UI will run but Gemini features are disabled.');
  });
}

async function catalog() { return registry.summaries((id) => settings.get(id)); }
async function activate(id: string) {
  return lock.run('a workspace switch', async () => {
    const context = registry.get(id); const activated = await workspace.activateWorkspace(context, settings.get(id).mode);
    await registry.activate(id); mediaJobs.notifyWorkspaceActivated(id); grants.revokeAll(); return { ...activated, catalog: await catalog(), settings: settings.get(id) };
  });
}
async function createAndActivate(name: string, mode: WorkspaceMode, source?: WorkspaceContext) {
  if (!['dom', 'canvas', 'mixed'].includes(mode)) throw statusError('A DOM, Canvas, or Mixed workspace type is required.', 400);
  return lock.run(source ? 'a workspace duplication' : 'a new workspace', async () => {
    const context = await registry.create(name, mode, source);
    try {
      await settings.initialize(context.id); await git.initialize(context.id); await workspace.prepareWorkspace(context);
      const activated = await workspace.activateWorkspace(context, settings.get(context.id).mode); await registry.activate(context.id); grants.revokeAll();
      return { ...activated, catalog: await catalog(), settings: settings.get(context.id) };
    } catch (error) { settings.forget(context.id); await registry.rollbackCreate(context.id); throw error; }
  });
}
function authorizedReference(body: any) {
  const allowed = grants.resolve(String(body?.grantId || '')); const requested = String(body?.workspace || ''); const normalized = requested.normalize('NFKC').toLocaleLowerCase();
  const context = allowed.map((id) => registry.get(id)).find((item) => item.id === requested || item.name.normalize('NFKC').toLocaleLowerCase() === normalized);
  if (!context) throw statusError('That workspace was not explicitly authorized by the current user request.', 403); return context.id;
}
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
function stringQuery(value: unknown) { return typeof value === 'string' && value ? value : undefined; }
function safeWorkspaceId() { try { return registry.active().id; } catch { return undefined; } }
async function assertRecoveryState(body: any) {
  if (body?.expectedVersion && String(body.expectedVersion) !== workspace.version) throw statusError('The workspace version changed. Refresh recovery state before continuing.', 409);
  if (body?.expectedFingerprint) { const current = await git.status(); if (String(body.expectedFingerprint) !== current.fingerprint) throw statusError('Workspace files changed. Review them before continuing.', 409); }
}
async function recoveryOperation<T>(title: string, operation: (id: string) => Promise<T>) {
  const id = `recovery-${randomUUID()}`; activity.register({ id, workspaceId: registry.active().id, source: 'workspace', title, message: `Started ${title}` });
  try { return await lock.run(title, async () => { const result = await operation(id); activity.finish(id, 'succeeded', `Completed ${title}`); return result; }); }
  catch (error) { await activity.emit(id, 'error', 'recovery', (error as Error).message); activity.finish(id, 'failed', (error as Error).message, { severity: 'error' }); throw error; }
}
async function sourceChangedSinceStart() {
  const cutoff = Date.parse(serverStartedAt); const roots = [resolve('src/server'), resolve('package.json'), resolve('package-lock.json'), resolve('docker')];
  async function newest(path: string): Promise<number> { const info = await stat(path).catch(() => undefined); if (!info) return 0; if (!info.isDirectory()) return info.mtimeMs; const children = await readdir(path).catch(() => []); return Math.max(info.mtimeMs, ...(await Promise.all(children.map((name) => newest(resolve(path, name)))))); }
  return Math.max(...await Promise.all(roots.map(newest))) > cutoff;
}

async function route(response: express.Response, operation: () => Promise<unknown>) {
  try { response.json(await operation()); }
  catch (error) { response.status((error as Error & { status?: number }).status || 400).json({ error: (error as Error).message }); }
}
async function routeStatus(response: express.Response, status: number, operation: () => Promise<unknown>) { try { response.status(status).json(await operation()); } catch (error) { response.status((error as Error & { status?: number }).status || 400).json({ error: (error as Error).message }); } }

start().catch((error) => { activity.recordFailure({ id: `system-${randomUUID()}`, source: 'system', title: 'Cowork server failed to start', message: (error as Error).message }); console.error(error); process.exitCode = 1; });

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
