import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkspaceMutationLock } from '../workspace/WorkspaceMutationLock.js';
import { MediaJobManager } from './MediaJobManager.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cowork-media-job-')); temporary.push(root); const draftDir = join(root, 'draft'); const mediaJobsDir = join(root, 'media-jobs'); await Promise.all([mkdir(draftDir), mkdir(mediaJobsDir)]);
  const start = join(draftDir, 'idle.png'); await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 10, g: 80, b: 20, alpha: 1 } } }).png().toFile(start);
  const context = { id: 'workspace-a', name: 'Test', draftDir, mediaJobsDir }; const registry = { active: () => context, get: () => context, records: () => [context], isActive: (id: string) => id === context.id };
  const activity = { update: vi.fn(), emit: vi.fn().mockResolvedValue(undefined) }; const publishWorkspace = vi.fn().mockResolvedValue({ version: 'media-release-1' }); const manager = new MediaJobManager(registry as any, activity as any, new WorkspaceMutationLock(), publishWorkspace);
  (manager as any).agent = { generateAnimation: async (_context: unknown, _request: unknown, jobDir: string) => { const output = join(jobDir, 'result.webp'); await sharp(start).webp({ lossless: true }).toFile(output); return { output, artifacts: [{ stage: 'encode', path: output, label: 'Final', mimeType: 'image/webp', type: 'animation' }] }; } };
  return { root, draftDir, manager, publishWorkspace };
}

describe('persistent media jobs', () => {
  test('creates a valid stable placeholder immediately and atomically upserts publication metadata', async () => {
    const { draftDir, manager, publishWorkspace } = await fixture(); const request = { kind: 'animation' as const, name: 'dance', prompt: 'Dance in place', startFrame: 'idle.png', endFrame: 'idle.png' };
    const job = await manager.create(request); const destination = join(draftDir, job.stablePaths[0]); expect((await sharp(await readFile(destination)).metadata()).format).toBe('webp');
    await waitFor(() => { const value = manager.get(job.id); if (value.status === 'failed') throw new Error(value.error); return value.status === 'completed'; }); expect(manager.get(job.id).previewVersion).toBe('media-release-1'); expect(publishWorkspace).toHaveBeenCalledWith(job.id, 'workspace-a'); const manifest = JSON.parse(await readFile(join(draftDir, 'assets', 'generated', 'manifest.json'), 'utf8')); expect(manifest).toHaveLength(1); expect(manifest[0]).toMatchObject({ path: job.stablePaths[0], mediaJobId: job.id, durationSeconds: 4, fps: 12 });
    const second = await manager.create(request); await waitFor(() => manager.get(second.id).status === 'completed'); const updated = JSON.parse(await readFile(join(draftDir, 'assets', 'generated', 'manifest.json'), 'utf8')); expect(updated).toHaveLength(1); expect(updated[0].mediaJobId).toBe(second.id);
  });

  test('rejects traversal and stale revision updates', async () => {
    const { manager } = await fixture(); await expect(manager.create({ kind: 'animation', name: 'bad', prompt: 'Bad', startFrame: '../outside.png' })).rejects.toThrow(/escapes/i);
    const job = await manager.create({ kind: 'animation', name: 'dance', prompt: 'Dance', startFrame: 'idle.png' }); await expect(manager.updateSettings(job.id, 99, { matte: { tolerance: 10 } })).rejects.toMatchObject({ status: 409 }); await waitFor(() => ['completed', 'failed'].includes(manager.get(job.id).status));
  });
});

async function waitFor(condition: () => boolean) { for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for media job'); }
