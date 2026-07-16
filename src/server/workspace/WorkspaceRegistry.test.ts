import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { scaffoldServerSource, WorkspaceRegistry } from './WorkspaceRegistry.js';

describe('generated workspace server', () => {
  it('routes by pathname so the preview version query still serves index.html', () => {
    expect(scaffoldServerSource).toContain("new URL(req.url||'/','http://workspace').pathname");
    expect(scaffoldServerSource).toContain("pathname==='/'?'index.html':pathname.slice(1)");
    expect(scaffoldServerSource).not.toContain("req.url==='/'");
  });

  it('creates a clean scaffold when a fresh checkout has no runtime workspace data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-fresh-workspace-'));
    const original = {
      projectsDir: config.projectsDir,
      draftDir: config.draftDir,
      releasesDir: config.releasesDir,
      failedDir: config.failedDir,
      stateDir: config.stateDir,
      workspaceGitDir: config.workspaceGitDir,
      mediaJobsDir: config.mediaJobsDir,
      workspacesStateDir: config.workspacesStateDir,
      workspaceCatalogPath: config.workspaceCatalogPath,
    };

    Object.assign(config, {
      projectsDir: join(root, 'workspace', 'projects'),
      draftDir: join(root, 'workspace', 'draft'),
      releasesDir: join(root, 'workspace', 'releases'),
      failedDir: join(root, 'workspace', 'failed'),
      stateDir: join(root, '.cowork'),
      workspaceGitDir: join(root, '.cowork', 'workspace-git'),
      mediaJobsDir: join(root, '.cowork', 'media-jobs'),
      workspacesStateDir: join(root, '.cowork', 'workspaces'),
      workspaceCatalogPath: join(root, '.cowork', 'workspaces.json'),
    });

    try {
      const registry = new WorkspaceRegistry();
      await registry.initialize();
      const active = registry.active();

      expect(registry.records()).toHaveLength(1);
      expect(active.name).toBe('Workspace 1');
      expect(await readFile(join(active.draftDir, 'index.html'), 'utf8')).toContain('New Workspace');
      expect(await readFile(join(active.draftDir, 'package.json'), 'utf8')).toContain('cowork-workspace');
      expect((await stat(active.stateDir)).isDirectory()).toBe(true);
    } finally {
      Object.assign(config, original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
