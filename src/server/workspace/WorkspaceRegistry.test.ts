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
      expect(await readFile(join(active.draftDir, 'index.html'), 'utf8')).toContain('<h1>New Mixed Workspace</h1>');
      expect(await readFile(join(active.draftDir, 'package.json'), 'utf8')).toContain('cowork-workspace');
      expect((await stat(active.stateDir)).isDirectory()).toBe(true);

      const dom = await registry.create('DOM workspace', 'dom');
      const domHtml = await readFile(join(dom.draftDir, 'index.html'), 'utf8');
      const domScript = await readFile(join(dom.draftDir, 'main.js'), 'utf8');
      expect(domHtml).toContain('<h1>New DOM Workspace</h1>');
      expect(domHtml).toContain('<h2>Build accessible interfaces with responsive, selectable HTML.</h2>');
      expect(domHtml).not.toContain('<canvas');
      expect(domScript).not.toContain('getContext');

      const canvas = await registry.create('Canvas workspace', 'canvas');
      const canvasHtml = await readFile(join(canvas.draftDir, 'index.html'), 'utf8');
      const canvasScript = await readFile(join(canvas.draftDir, 'main.js'), 'utf8');
      const canvasStyles = await readFile(join(canvas.draftDir, 'styles.css'), 'utf8');
      expect(canvasHtml).toContain('data-cowork-canvas-primary');
      expect(canvasHtml).not.toContain('<main');
      expect(canvasHtml).not.toContain('<h1>');
      expect(canvasScript).toContain("const title='New Canvas Workspace'");
      expect(canvasScript).toContain('ctx.fillText(title');
      expect(canvasScript).toContain('requestAnimationFrame(animate)');
      expect(canvasScript).toContain("id:'background-layer'");
      expect(canvasScript).toContain("id:'title-layer'");
      expect(canvasScript).toContain("id:'subtitle-layer'");
      expect(canvasScript).toContain('canvas.width=Math.round(width*dpr)');
      expect(canvasScript).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
      expect(canvasScript).toContain('getPrimaryCanvas:()=>canvas');
      expect(canvasScript).toContain('hitTest:point=>[...layers].reverse()');
      expect(canvasStyles).toContain('canvas{position:fixed;inset:0;width:100%;height:100%');

      const mixed = await registry.create('Mixed workspace', 'mixed');
      const mixedHtml = await readFile(join(mixed.draftDir, 'index.html'), 'utf8');
      const mixedScript = await readFile(join(mixed.draftDir, 'main.js'), 'utf8');
      const mixedStyles = await readFile(join(mixed.draftDir, 'styles.css'), 'utf8');
      expect(mixedHtml).toContain('<h1>New Mixed Workspace</h1>');
      expect(mixedHtml).toContain('<h2>Combine selectable HTML with an animated canvas backdrop.</h2>');
      expect(mixedHtml).toContain('<span>Semantic DOM</span>');
      expect(mixedHtml).toContain('data-cowork-canvas-primary');
      expect(mixedScript).not.toContain('New Mixed Workspace');
      expect(mixedScript).toContain("id:'background-layer'");
      expect(mixedScript).toContain('requestAnimationFrame(animate)');
      expect(mixedStyles).toContain('canvas{position:fixed;inset:0;width:100%;height:100%;z-index:0}');

      for (const project of [dom, canvas, mixed]) {
        const output = await Promise.all(['index.html', 'styles.css', 'main.js'].map((file) => readFile(join(project.draftDir, file), 'utf8')));
        const scaffold = output.join('\n');
        expect(scaffold).not.toContain('toDataURL');
        expect(scaffold).not.toContain('backgroundImage');
        expect(scaffold).not.toContain('display:none');
        expect(scaffold).not.toContain('visibility:hidden');
      }
    } finally {
      Object.assign(config, original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
