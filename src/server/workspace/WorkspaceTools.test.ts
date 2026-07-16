import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTools } from './WorkspaceTools.js';
import { WorkspaceFiles } from './WorkspaceFiles.js';
import { WorkspaceMutationLock } from './WorkspaceMutationLock.js';
import { config } from '../config.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function registry() { const context = { id: 'test', name: 'Test', draftDir: config.draftDir }; return { active: () => context, get: () => context }; }

function subject() {
  const activity = { emit: vi.fn().mockResolvedValue(undefined) };
  const workspace = {};
  return new WorkspaceTools(workspace as any, activity as any, registry() as any);
}

describe('WorkspaceTools boundary', () => {
  it('lists files in the generated project', async () => {
    const files = await subject().execute('test', 'list_files', { path: '.' });
    expect(files).toContain('index.html');
    expect(files).toContain('server.mjs');
  });

  it('rejects paths outside the generated project', async () => {
    await expect(subject().execute('test', 'read_file', { path: '../package.json' })).rejects.toThrow(/escapes the project workspace/);
  });

  it('reports added, changed, and deleted files', () => {
    const tools = subject();
    const changes = tools.changed(new Map([['same.js', 'a'], ['changed.js', 'a'], ['gone.js', 'a']]), new Map([['same.js', 'a'], ['changed.js', 'b'], ['new.js', 'c']]));
    expect(changes).toEqual([
      { path: 'changed.js', action: 'modified' },
      { path: 'gone.js', action: 'deleted' },
      { path: 'new.js', action: 'added' },
    ]);
  });

  it('enforces dependency and media restrictions before tool execution', async () => {
    const tools = subject();
    const policy = { dependencies: 'existing-only', mediaGeneration: false, validation: 'standard', reasoningProfile: 'adaptive', maxParallelAgents: 3 } as const;
    await expect(tools.execute('test', 'install_dependencies', {}, () => false, policy)).rejects.toThrow(/dependencies is disabled/i);
    await expect(tools.execute('test', 'generate_image', {}, () => false, policy)).rejects.toThrow(/Media generation is disabled/);
  });

  it('keeps deterministic image processing separate from media-generation restrictions', async () => {
    const context = { id: 'test', name: 'Test', draftDir: config.draftDir }; const activity = { emit: vi.fn().mockResolvedValue(undefined) };
    const images = { removeBackground: vi.fn().mockResolvedValue({ path: 'assets/processed/backgrounds/a.webp' }), extractRegions: vi.fn() };
    const tools = new WorkspaceTools({} as any, activity as any, { active: () => context, get: () => context } as any, undefined, images as any);
    const policy = { dependencies: 'existing-only', mediaGeneration: false, validation: 'standard', reasoningProfile: 'adaptive', maxParallelAgents: 3 } as const;
    await expect(tools.execute('test', 'remove_image_background', { sourcePath: 'uploads/a.png', name: 'a' }, () => false, policy)).resolves.toMatchObject({ path: expect.stringContaining('processed') });
    expect(images.removeBackground).toHaveBeenCalledOnce();
  });

  it('blocks verification commands in fast validation mode', async () => {
    const policy = { dependencies: 'allow', mediaGeneration: true, validation: 'fast', reasoningProfile: 'adaptive', maxParallelAgents: 3 } as const;
    await expect(subject().execute('test', 'run_command', { command: 'npm test' }, () => false, policy)).rejects.toThrow(/skips coding-agent verification/);
  });

  it('runs only scripts-folder Node utilities with literal arguments and read-only role mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-node-script-')); await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts', 'inspect.mjs'), 'console.log(process.argv.slice(2))');
    const runInSandbox = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const context = { id: 'temp', name: 'Temp', draftDir: root }; const activity = { emit: vi.fn().mockResolvedValue(undefined) };
    const tools = new WorkspaceTools({ runInSandbox } as any, activity as any, { active: () => context, get: () => context } as any);
    try {
      await expect(tools.execute('test', 'run_node_script', { script: 'scripts/inspect.mjs', args: ['a b', "x'y", '; rm -rf /'] }, () => false, undefined, [], 'planning')).resolves.toMatchObject({ code: 0 });
      expect(runInSandbox).toHaveBeenCalledWith(expect.stringContaining("'scripts/inspect.mjs'"), false, 180_000, root, true, true);
      const command = runInSandbox.mock.calls[0][0]; expect(command).toContain("'a b'"); expect(command).toContain("'x'\"'\"'y'"); expect(command).toContain("'; rm -rf /'");
      await expect(tools.execute('test', 'run_node_script', { script: '../outside.mjs' })).rejects.toThrow(/beneath scripts/i);
      await expect(tools.execute('test', 'run_node_script', { script: 'scripts/inspect.py' })).rejects.toThrow(/beneath scripts/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs bounded utility operations without workspace mutation', async () => {
    await expect(subject().execute('test', 'calculate', { expression: '2 * (3 + 4)^2' })).resolves.toEqual({ value: 98 });
    await expect(subject().execute('test', 'calculate', { expression: 'process.exit()' })).rejects.toThrow(/unsupported/);
    await expect(subject().execute('test', 'content.hash', { content: 'hello', algorithm: 'sha256' })).resolves.toMatchObject({ algorithm: 'sha256', digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    await expect(subject().execute('test', 'regex.test', { pattern: '^hel+', input: 'hello' })).resolves.toMatchObject({ matched: true, index: 0 });
  });

  it('redacts disclosed credentials from persisted tool activity', async () => {
    const secret = 'sentinel-secret-value'; const activity = { emit: vi.fn().mockResolvedValue(undefined) };
    const context = { id: 'test', name: 'Test', draftDir: config.draftDir };
    const tools = new WorkspaceTools({} as any, activity as any, { active: () => context, get: () => context } as any);
    await tools.execute('test', 'search_files', { query: secret, path: '.' }, () => false, undefined, [], 'coding', [secret]);
    expect(JSON.stringify(activity.emit.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(activity.emit.mock.calls)).toContain('[REDACTED]');
  });

  it('batches reads and prevalidates atomic edits before mutating files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-tools-'));
    await Promise.all([writeFile(join(root, 'one.ts'), 'alpha\nsecond\n'), writeFile(join(root, 'two.ts'), 'bravo\n')]);
    const context = { id: 'temp', name: 'Temp', draftDir: root }; const activity = { emit: vi.fn().mockResolvedValue(undefined) };
    const tools = new WorkspaceTools({} as any, activity as any, { active: () => context, get: () => context } as any);
    try {
      const reads = await tools.execute('test', 'read_files', { files: [{ path: 'one.ts', startLine: 2 }, { path: 'two.ts' }] });
      expect(reads.map((item: any) => item.path)).toEqual(['one.ts', 'two.ts']);
      await expect(tools.execute('test', 'apply_edits', { edits: [
        { path: 'one.ts', mode: 'replace', search: 'alpha', replacement: 'changed' },
        { path: 'two.ts', mode: 'replace', search: 'missing', replacement: 'never' },
      ] })).rejects.toThrow(/not found/);
      expect(await readFile(join(root, 'one.ts'), 'utf8')).toContain('alpha');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('builds ranked capped context without ignored or binary paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-context-')); await mkdir(join(root, 'node_modules'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } })),
      writeFile(join(root, 'view.tsx'), '<h1 data-cowork-id="hero-title">Old title</h1>\n'),
      writeFile(join(root, 'photo.png'), Buffer.from([0, 1, 2])),
      writeFile(join(root, 'node_modules', 'hidden.ts'), 'hero-title'),
      writeFile(join(root, 'AGENTS.md'), 'Keep edits focused.'),
    ]);
    const context = { id: 'temp', name: 'Temp', draftDir: root }; const tools = new WorkspaceTools({} as any, { emit: vi.fn() } as any, { active: () => context, get: () => context } as any);
    try {
      const result = await tools.buildTaskContext({ objective: 'Change the title text', selectedElement: { identifier: 'hero-title', attributes: { 'data-cowork-id': 'hero-title' }, text: 'Old title' } });
      expect(result.bytes).toBeLessThanOrEqual(24 * 1024);
      expect(result.text).toContain('Package scripts'); expect(result.text).toContain('view.tsx'); expect(result.text).toContain('Keep edits focused.');
      expect(result.text).not.toContain('photo.png'); expect(result.text).not.toContain('hidden.ts');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('Workspace file explorer', () => {
  it('lists immediate project entries with preview metadata', async () => {
    const entries = await new WorkspaceFiles(registry() as any).list('.');
    expect(entries.find((entry) => entry.path === 'index.html')).toMatchObject({ kind: 'file', previewKind: 'text', mimeType: 'text/html' });
    expect(entries.some((entry) => entry.name === 'node_modules')).toBe(false);
    expect(entries.some((entry) => entry.name === 'dist')).toBe(false);
  });

  it('reads text with a stable content hash', async () => {
    const file = await new WorkspaceFiles(registry() as any).readText('package.json');
    expect(file.content).toContain('cowork-generated-workspace');
    expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('prevalidates and deletes multiple regular files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-delete-')); await mkdir(join(root, 'folder'));
    await Promise.all([writeFile(join(root, 'one.txt'), 'one'), writeFile(join(root, 'two.txt'), 'two')]);
    const context = { id: 'temp', name: 'Temp', draftDir: root }; const files = new WorkspaceFiles({ active: () => context, get: () => context } as any);
    try {
      await expect(files.remove(['one.txt', 'folder'])).rejects.toThrow(/Only regular files/);
      await expect(readFile(join(root, 'one.txt'), 'utf8')).resolves.toBe('one');
      await expect(files.remove(['one.txt', 'two.txt'])).resolves.toEqual(['one.txt', 'two.txt']);
      await expect(readFile(join(root, 'one.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, 'two.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects explorer paths outside the workspace', async () => {
    await expect(new WorkspaceFiles(registry() as any).list('..')).rejects.toThrow(/escapes the project workspace/);
  });
});

describe('Workspace mutation lock', () => {
  it('rejects overlapping writers and releases after completion', async () => {
    const lock = new WorkspaceMutationLock(); let release!: () => void;
    const first = lock.run('first operation', () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(lock.run('second operation', async () => undefined)).rejects.toThrow(/busy with first operation/);
    release(); await first;
    await expect(lock.run('third operation', async () => 'ok')).resolves.toBe('ok');
  });
});
