import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { ActivityHub } from '../activity.js';
import type { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import type { AnimationMediaJobRequest, AssetRecord, MediaArtifact, MediaJobRequest, MediaJobSnapshot, MediaStageName, MediaStageState } from '../../shared/protocol.js';
import { DEFAULT_ENCODING, DEFAULT_MATTE } from './AnimationPipeline.js';
import { MediaAgent } from './MediaAgent.js';
import { safeWorkspacePath } from '../workspace/WorkspaceFiles.js';
import { config } from '../config.js';
import { run } from '../process.js';

interface StoredArtifact extends Omit<MediaArtifact, 'url'> { path: string }
interface InternalJob extends Omit<MediaJobSnapshot, 'artifacts'> { artifacts: StoredArtifact[]; cancelled: boolean; jobDir: string }
type WorkspacePublisher = (taskId: string, workspaceId: string) => Promise<{ version: string }>;
const STAGES: MediaStageName[] = ['brief', 'normalize', 'generate', 'extract', 'matte', 'encode', 'publish'];

export class MediaJobManager {
  private jobs = new Map<string, InternalJob>(); private queues = new Map<string, Promise<void>>(); private agent = new MediaAgent();
  constructor(private readonly registry: WorkspaceRegistry, private readonly activity: ActivityHub, private readonly lock: WorkspaceMutationLock, private readonly publishWorkspace: WorkspacePublisher) {}

  async initialize() {
    for (const workspace of this.registry.records()) {
      const context = this.registry.get(workspace.id); for (const entry of await readdir(context.mediaJobsDir).catch(() => [])) {
        const jobDir = join(context.mediaJobsDir, entry); const stored = await readJson<InternalJob>(join(jobDir, 'job.json')); if (!stored?.id) continue;
        const job = { ...stored, jobDir, cancelled: false }; if (['queued', 'running', 'publishing'].includes(job.status)) { job.status = 'failed'; job.error = 'Media job was interrupted by a server restart.'; job.updatedAt = new Date().toISOString(); await this.persist(job); }
        this.jobs.set(job.id, job); this.activity.update(this.public(job));
      }
    }
    await this.prune();
  }

  async create(request: MediaJobRequest) {
    validateRequest(request); const context = this.registry.active(); const id = randomUUID(); const now = new Date().toISOString(); const jobDir = join(context.mediaJobsDir, id); await mkdir(jobDir, { recursive: true });
    const stablePaths = stablePathsFor(request); await this.createPlaceholders(context.draftDir, request, stablePaths);
    const stages: MediaStageState[] = STAGES.map((name) => ({ name, status: name === 'brief' ? 'ready' : 'pending', progress: name === 'brief' ? 100 : 0, attempt: 0, artifactIds: [] }));
    const job: InternalJob = { kind: 'media', id, workspaceId: context.id, parentRunId: request.parentRunId, status: 'queued', request: structuredClone(request), revision: 1, selectedRevision: 1, stablePaths, stages, artifacts: [], settings: { matte: { ...DEFAULT_MATTE, ...('matte' in request ? request.matte : {}) }, encoding: { ...DEFAULT_ENCODING, ...('encoding' in request ? request.encoding : {}), fps: 12, frameCount: 48 } }, createdAt: now, updatedAt: now, cancelled: false, jobDir };
    this.jobs.set(id, job); await this.persist(job); this.activity.update(this.public(job)); await this.activity.emit(id, 'status', 'media', `Queued ${request.kind} media job; placeholders are ready`, { paths: stablePaths, parentRunId: request.parentRunId }); this.enqueue(job); return this.public(job);
  }

  list(workspaceId = this.registry.active().id) { return [...this.jobs.values()].filter((job) => job.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((job) => this.public(job)); }
  get(id: string) { const job = this.require(id); this.assertWorkspace(job); return this.public(job); }
  cancel(id: string) { const job = this.require(id); this.assertWorkspace(job); if (['completed', 'failed', 'cancelled'].includes(job.status)) return false; job.cancelled = true; job.status = 'cancelled'; job.updatedAt = new Date().toISOString(); void this.persist(job); this.activity.update(this.public(job)); return true; }
  async discard(id: string) { const job = this.require(id); this.assertWorkspace(job); job.cancelled = true; this.jobs.delete(id); await rm(job.jobDir, { recursive: true, force: true }); return { ok: true }; }

  async updateSettings(id: string, expectedRevision: number, input: any) {
    const job = this.require(id); this.assertWorkspace(job); if (job.revision !== expectedRevision) throw statusError('The media job changed. Reload it before saving settings.', 409);
    if (input.matte) job.settings.matte = { ...job.settings.matte, ...input.matte }; if (input.encoding) job.settings.encoding = { ...job.settings.encoding, ...input.encoding, fps: 12, frameCount: 48 };
    job.revision++; job.updatedAt = new Date().toISOString(); const start = input.matte ? STAGES.indexOf('matte') : STAGES.indexOf('encode'); for (let index = start; index < STAGES.length; index++) { const stage = job.stages[index]; stage.status = 'stale'; stage.progress = 0; }
    await this.persist(job); this.activity.update(this.public(job)); return this.public(job);
  }

  async rerun(id: string, stageName: MediaStageName, expectedRevision: number) {
    const job = this.require(id); this.assertWorkspace(job); if (job.revision !== expectedRevision) throw statusError('The media job changed. Reload it before reprocessing.', 409);
    if (!STAGES.includes(stageName) || stageName === 'brief' || stageName === 'publish') throw statusError('That media stage cannot be rerun directly.', 400);
    if (STAGES.indexOf(stageName) <= STAGES.indexOf('generate')) throw statusError('Regenerating model output requires creating a confirmed new media job.', 409);
    // Deterministic revisions currently replay the locally retained animation inputs and never call Veo.
    job.revision++; job.selectedRevision = job.revision; job.status = 'queued'; job.error = undefined; for (let index = STAGES.indexOf(stageName); index < STAGES.length; index++) job.stages[index].status = 'stale';
    await this.persist(job); this.enqueue(job, true); return this.public(job);
  }

  async save(id: string, expectedRevision: number, selectedRevision?: number) {
    const job = this.require(id); this.assertWorkspace(job); if (job.revision !== expectedRevision) throw statusError('The media job changed. Reload it before publishing.', 409);
    if (selectedRevision) job.selectedRevision = selectedRevision; await this.publish(job, true); return this.public(job);
  }

  async artifact(id: string, artifactId: string) {
    const job = this.require(id); this.assertWorkspace(job); if (!/^[a-f0-9-]{36}$/i.test(artifactId)) throw statusError('Artifact not found.', 404);
    const artifact = job.artifacts.find((item) => item.id === artifactId); if (!artifact) throw statusError('Artifact not found.', 404);
    const path = resolve(artifact.path); if (path !== job.jobDir && !path.startsWith(resolve(job.jobDir) + sep)) throw statusError('Artifact access was rejected.', 403);
    return { data: await readFile(path), mimeType: artifact.mimeType, label: artifact.label };
  }

  notifyWorkspaceActivated(workspaceId: string) { for (const job of this.jobs.values()) if (job.workspaceId === workspaceId && job.status === 'review') void this.publish(job); }

  private enqueue(job: InternalJob, deterministic = false) {
    const previous = this.queues.get(job.workspaceId) || Promise.resolve(); const next = previous.catch(() => undefined).then(() => this.execute(job, deterministic)); this.queues.set(job.workspaceId, next); void next.finally(() => { if (this.queues.get(job.workspaceId) === next) this.queues.delete(job.workspaceId); });
  }

  private async execute(job: InternalJob, deterministic: boolean) {
    try {
      if (job.cancelled) return; job.status = 'running'; this.touch(job); this.activity.update(this.public(job));
      const report = async (event: { stage: MediaStageName; progress: number; message: string }) => {
        const stage = job.stages.find((item) => item.name === event.stage)!; stage.status = 'running'; stage.progress = event.progress; stage.attempt = Math.max(1, stage.attempt); this.touch(job); await this.persist(job); this.activity.update(this.public(job)); await this.activity.emit(job.id, 'status', event.stage, event.message);
      };
      if (deterministic && job.request.kind !== 'animation') throw new Error('Only animation jobs support deterministic frame reprocessing.');
      const result = job.request.kind !== 'animation'
        ? await this.agent.generateAsset(this.registry.get(job.workspaceId), job.request as any, job.jobDir, () => job.cancelled, report)
        : deterministic
        ? await this.agent.reprocessAnimation(job.jobDir, job.revision, job.settings.matte, job.settings.encoding, () => job.cancelled, report)
        : await this.agent.generateAnimation(this.registry.get(job.workspaceId), job.request as AnimationMediaJobRequest, job.jobDir, job.settings.matte, job.settings.encoding, () => job.cancelled, report);
      if (job.cancelled) return; job.artifacts = [...job.artifacts, ...result.artifacts.map((artifact) => ({ ...artifact, id: randomUUID(), revision: job.revision, createdAt: new Date().toISOString() }))];
      for (const stage of job.stages) { if (stage.name !== 'publish') { stage.status = 'ready'; stage.progress = 100; stage.artifactIds = job.artifacts.filter((artifact) => artifact.stage === stage.name).map((artifact) => artifact.id); } }
      (job as any).resultFiles = { output: result.output, audio: result.audio }; job.status = 'review'; this.touch(job); await this.persist(job); this.activity.update(this.public(job)); await this.publish(job);
    } catch (error) { job.status = job.cancelled ? 'cancelled' : 'failed'; job.error = (error as Error).message; this.touch(job); await this.persist(job); this.activity.update(this.public(job)); await this.activity.emit(job.id, job.cancelled ? 'complete' : 'error', 'media', job.error); }
  }

  private async publish(job: InternalJob, force = false) {
    if (!force && (!this.registry.isActive(job.workspaceId) || this.lock.busy)) { job.status = 'review'; this.touch(job); await this.persist(job); this.activity.update(this.public(job)); if (this.registry.isActive(job.workspaceId)) setTimeout(() => void this.publish(job).catch(() => undefined), 1000); return; }
    const files = (job as any).resultFiles as { output?: string; audio?: string } | undefined; if (!files?.output) throw statusError('This media job has no valid output to publish.', 409);
    job.status = 'publishing'; this.touch(job); this.activity.update(this.public(job));
    await this.lock.run('media publication', async () => {
      const context = this.registry.get(job.workspaceId); await atomicCopy(files.output!, join(context.draftDir, job.stablePaths[0])); if (files.audio && job.stablePaths[1]) await atomicCopy(files.audio, join(context.draftDir, job.stablePaths[1])); await upsertManifest(context.draftDir, job, files.audio ? job.stablePaths[1] : undefined);
      const published = await this.publishWorkspace(job.id, job.workspaceId); job.previewVersion = published.version;
    });
    job.status = 'completed'; const stage = job.stages.find((item) => item.name === 'publish')!; stage.status = 'ready'; stage.progress = 100; this.touch(job); await this.persist(job); this.activity.update(this.public(job)); await this.activity.emit(job.id, 'complete', 'publish', `Published ${job.stablePaths.join(' and ')}`, { paths: job.stablePaths });
  }

  private async createPlaceholders(draftDir: string, request: MediaJobRequest, paths: string[]) {
    const primary = join(draftDir, paths[0]); await mkdir(dirname(primary), { recursive: true });
    if (request.kind === 'animation' && request.startFrame) await sharp(await safeWorkspacePath(draftDir, request.startFrame, true)).ensureAlpha().webp({ lossless: true }).toFile(primary);
    else if (request.kind === 'image') await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp({ lossless: true }).toFile(primary);
    else if (request.kind === 'video') await placeholder(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', primary]);
    else await placeholder(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1', '-c:a', 'libmp3lame', '-q:a', '9', primary]);
    if (paths[1]) { await mkdir(dirname(join(draftDir, paths[1])), { recursive: true }); await placeholder(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1', '-c:a', 'libmp3lame', '-q:a', '9', join(draftDir, paths[1])]); }
  }
  private public(job: InternalJob): MediaJobSnapshot { const { cancelled: _cancelled, jobDir: _jobDir, artifacts, ...snapshot } = job; return { ...snapshot, artifacts: artifacts.map(({ path: _path, ...artifact }) => ({ ...artifact, url: `/api/media-jobs/${job.id}/artifacts/${artifact.id}` })) }; }
  private require(id: string) { const job = this.jobs.get(id); if (!job) throw statusError('Media job not found.', 404); return job; }
  private assertWorkspace(job: InternalJob) { if (job.workspaceId !== this.registry.active().id) throw statusError('Media job belongs to another workspace.', 404); }
  private touch(job: InternalJob) { job.updatedAt = new Date().toISOString(); }
  private async persist(job: InternalJob) { const path = join(job.jobDir, 'job.json'); await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; const { jobDir: _jobDir, ...stored } = job; await writeFile(temporary, JSON.stringify(stored, null, 2) + '\n'); await rename(temporary, path); }
  private async prune() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; const limit = 5 * 1024 * 1024 * 1024;
    for (const workspace of this.registry.records()) {
      let completed = [...this.jobs.values()].filter((job) => job.workspaceId === workspace.id && job.status === 'completed').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const job of completed.filter((item) => Date.parse(item.updatedAt) < cutoff)) { this.jobs.delete(job.id); await rm(job.jobDir, { recursive: true, force: true }); }
      completed = completed.filter((job) => this.jobs.has(job.id)); const sizes = new Map<string, number>(); for (const job of completed) sizes.set(job.id, await directorySize(job.jobDir)); let total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
      for (const job of completed) { if (total <= limit) break; total -= sizes.get(job.id) || 0; this.jobs.delete(job.id); await rm(job.jobDir, { recursive: true, force: true }); }
    }
  }
}

function stablePathsFor(request: MediaJobRequest) { const stem = basename(request.name, extname(request.name)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || request.kind; if (request.kind === 'animation') return [`assets/generated/animations/${stem}.webp`, ...(request.soundEffects ? [`assets/generated/audio/${stem}.mp3`] : [])]; if (request.kind === 'music' || request.kind === 'sound-effect') return [`assets/generated/audio/${stem}.mp3`]; if (request.kind === 'video') return [`assets/generated/videos/${stem}.mp4`]; return [`assets/generated/images/${stem}.webp`]; }
function validateRequest(request: MediaJobRequest) { if (!request?.prompt?.trim()) throw statusError('A media prompt is required.', 400); if (!request.name?.trim()) throw statusError('A media output name is required.', 400); if (request.kind === 'animation' && !request.startFrame) throw statusError('Animations require an explicit startFrame.', 400); if (request.kind === 'animation' && request.referenceImages?.length && (request.startFrame || request.endFrame)) throw statusError('referenceImages cannot be combined with animation endpoints.', 400); }
async function atomicCopy(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true }); const temporary = `${destination}.${randomUUID()}.tmp`; const backup = `${destination}.${randomUUID()}.previous`; await copyFile(source, temporary); let moved = false;
  try { await rename(destination, backup); moved = true; } catch (error: any) { if (error?.code !== 'ENOENT') { await rm(temporary, { force: true }); throw error; } }
  try { await rename(temporary, destination); if (moved) await rm(backup, { force: true }); }
  catch (error) { if (moved) await rename(backup, destination).catch(() => undefined); await rm(temporary, { force: true }); throw error; }
}
async function upsertManifest(root: string, job: InternalJob, audio?: string) { const path = join(root, 'assets', 'generated', 'manifest.json'); const records = await readJson<AssetRecord[]>(path) || []; const target = join(root, job.stablePaths[0]); const mimeTypes: Record<string,string> = { animation: 'image/webp', image: 'image/webp', video: 'video/mp4', music: 'audio/mpeg', 'sound-effect': 'audio/mpeg' }; const record: AssetRecord = { id: records.find((item) => item.path === job.stablePaths[0])?.id || randomUUID(), kind: job.request.kind, path: job.stablePaths[0], prompt: job.request.prompt, model: job.request.kind === 'animation' || job.request.kind === 'video' || job.request.kind === 'sound-effect' ? config.videoModel : job.request.kind === 'music' ? config.musicModel : config.imageModel, transparent: 'transparent' in job.request ? job.request.transparent !== false : undefined, referenceImages: job.request.referenceImages, startFrame: 'startFrame' in job.request ? job.request.startFrame : undefined, endFrame: 'endFrame' in job.request ? job.request.endFrame : undefined, durationSeconds: job.request.kind === 'animation' ? 4 : undefined, fps: job.request.kind === 'animation' ? 12 : undefined, mimeType: mimeTypes[job.request.kind], size: (await stat(target)).size, createdAt: new Date().toISOString(), mediaJobId: job.id, mediaRevision: job.selectedRevision, pairedAudioPath: audio }; const output = [...records.filter((item) => item.path !== record.path), record]; await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(output, null, 2) + '\n'); await rename(temporary, path); }
async function readJson<T>(path: string) { return readFile(path, 'utf8').then((value) => JSON.parse(value) as T).catch(() => undefined); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
async function directorySize(path: string): Promise<number> { const info = await stat(path).catch(() => undefined); if (!info) return 0; if (info.isFile()) return info.size; return (await Promise.all((await readdir(path).catch(() => [])).map((name) => directorySize(join(path, name))))).reduce((sum, value) => sum + value, 0); }
async function placeholder(args: string[]) { const result = await run(config.ffmpegPath, ['-y', ...args], { timeout: 30_000 }); if (result.code) throw statusError(`Could not create media placeholder: ${result.stderr}`, 500); }
