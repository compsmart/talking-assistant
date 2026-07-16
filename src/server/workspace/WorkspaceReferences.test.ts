import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFiles } from './WorkspaceFiles.js';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('cross-workspace files', () => {
  it('copies binary bytes into the active workspace without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-references-')); cleanup.push(root);
    const source = join(root, 'source'); const active = join(root, 'active'); await Promise.all([mkdir(join(source, 'assets'), { recursive: true }), mkdir(active, { recursive: true })]);
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]); await writeFile(join(source, 'assets', 'logo.webp'), bytes);
    const contexts: Record<string, any> = { source: { id: 'source', draftDir: source }, active: { id: 'active', draftDir: active } };
    const files = new WorkspaceFiles({ active: () => contexts.active, get: (id: string) => contexts[id] } as any);
    const result = await files.copyFrom('source', 'assets/logo.webp', 'public/logo.webp');
    expect(result.bytes).toBe(bytes.length); expect(await readFile(join(active, 'public', 'logo.webp'))).toEqual(bytes); expect(await readFile(join(source, 'assets', 'logo.webp'))).toEqual(bytes);
  });

  it('rejects traversal and ignored source directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-references-')); cleanup.push(root);
    const source = join(root, 'source'); const active = join(root, 'active'); await Promise.all([mkdir(join(source, 'node_modules'), { recursive: true }), mkdir(active, { recursive: true })]);
    await writeFile(join(source, 'node_modules', 'secret.txt'), 'no');
    const contexts: Record<string, any> = { source: { id: 'source', draftDir: source }, active: { id: 'active', draftDir: active } };
    const files = new WorkspaceFiles({ active: () => contexts.active, get: (id: string) => contexts[id] } as any);
    await expect(files.copyFrom('source', '../outside.txt', 'copy.txt')).rejects.toThrow(/escapes|outside/i);
    await expect(files.copyFrom('source', 'node_modules/secret.txt', 'copy.txt')).rejects.toThrow(/Ignored workspace directories/);
  });
});
