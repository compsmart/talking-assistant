import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFiles } from './WorkspaceFiles.js';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cowork-files-')); cleanup.push(root);
  const draftDir = join(root, 'draft'); await mkdir(draftDir, { recursive: true });
  return { root, draftDir, files: new WorkspaceFiles({ active: () => ({ draftDir }) } as any) };
}

describe('workspace file management', () => {
  it('treats an absent optional library directory as empty without hiding ordinary missing-path errors', async () => {
    const { files } = await fixture();
    await expect(files.list('assets/generated', undefined, true)).resolves.toEqual([]);
    await expect(files.list('assets/generated')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates an empty file exclusively in the requested directory', async () => {
    const { draftDir, files } = await fixture(); await mkdir(join(draftDir, 'src'));
    await expect(files.createFile('src', 'notes.md')).resolves.toEqual({ path: 'src/notes.md' });
    expect(await readFile(join(draftDir, 'src', 'notes.md'), 'utf8')).toBe('');
    await expect(files.createFile('src', 'notes.md')).rejects.toThrow(/already exists/i);
    await expect(files.createFile('src', '../escape.md')).rejects.toThrow(/valid file name/i);
  });

  it('renames only regular files without overwriting another path', async () => {
    const { draftDir, files } = await fixture(); await mkdir(join(draftDir, 'src'));
    await writeFile(join(draftDir, 'src', 'old.txt'), 'original'); await writeFile(join(draftDir, 'src', 'taken.txt'), 'taken');
    await expect(files.renameFile('src/old.txt', 'new.txt')).resolves.toEqual({ previousPath: 'src/old.txt', path: 'src/new.txt' });
    expect(await readFile(join(draftDir, 'src', 'new.txt'), 'utf8')).toBe('original');
    await expect(files.renameFile('src/new.txt', 'taken.txt')).rejects.toThrow(/already exists/i);
    await expect(files.renameFile('src', 'renamed')).rejects.toThrow(/regular files/i);
  });

  it('copies binary files and generates stable keep-both names', async () => {
    const { draftDir, files } = await fixture(); await mkdir(join(draftDir, 'assets'));
    const bytes = Buffer.from([0, 1, 2, 250, 251]); await writeFile(join(draftDir, 'assets', 'sprite.webp'), bytes);
    await expect(files.copyFile('assets/sprite.webp', 'assets')).resolves.toMatchObject({ path: 'assets/sprite copy.webp', bytes: bytes.length });
    await expect(files.copyFile('assets/sprite.webp', 'assets')).resolves.toMatchObject({ path: 'assets/sprite copy 2.webp' });
    expect(await readFile(join(draftDir, 'assets', 'sprite copy.webp'))).toEqual(bytes);
    expect(await readFile(join(draftDir, 'assets', 'sprite.webp'))).toEqual(bytes);
  });

  it('protects ignored and generated-plan destinations', async () => {
    const { draftDir, files } = await fixture(); await Promise.all([mkdir(join(draftDir, 'plans')), mkdir(join(draftDir, 'node_modules'))]);
    await writeFile(join(draftDir, 'plans', 'review.md'), '# Review');
    await expect(files.createFile('plans', 'manual.md')).rejects.toThrow(/managed automatically/i);
    await expect(files.renameFile('plans/review.md', 'renamed.md')).rejects.toThrow(/cannot be renamed/i);
    await expect(files.copyFile('plans/review.md', '.')).resolves.toMatchObject({ path: 'review.md' });
    await expect(files.createFile('node_modules', 'hidden.txt')).rejects.toThrow(/ignored/i);
  });
});
