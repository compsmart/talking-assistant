import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceGit } from './WorkspaceGit.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-git-')); temporary.push(root);
  const context = { id: 'test', draftDir: join(root, 'draft'), gitDir: join(root, 'git') };
  await mkdir(context.draftDir, { recursive: true });
  await writeFile(join(context.draftDir, 'tracked.txt'), 'original', 'utf8');
  const registry = { active: () => context, get: () => context };
  const git = new WorkspaceGit(registry as never);
  await git.initialize();
  return { git, context };
}

describe('WorkspaceGit status fingerprint', () => {
  it('pins generated workspace line endings to LF', async () => {
    const { context } = await fixture();
    const config = await readFile(join(context.gitDir, 'config'), 'utf8');
    expect(config).toMatch(/autocrlf = false/);
    expect(config).toMatch(/eol = lf/);
  });

  it('stays stable while files are only inspected', async () => {
    const { git, context } = await fixture();
    const before = await git.status();
    await readFile(join(context.draftDir, 'tracked.txt'), 'utf8');
    const after = await git.status();
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.dirty).toBe(false);
  });

  it('changes when tracked or already-untracked file content changes', async () => {
    const { git, context } = await fixture();
    const clean = await git.status();
    await writeFile(join(context.draftDir, 'tracked.txt'), 'changed', 'utf8');
    const tracked = await git.status();
    expect(tracked.fingerprint).not.toBe(clean.fingerprint);

    await writeFile(join(context.draftDir, 'new.txt'), 'first', 'utf8');
    const untracked = await git.status();
    await writeFile(join(context.draftDir, 'new.txt'), 'second', 'utf8');
    expect((await git.status()).fingerprint).not.toBe(untracked.fingerprint);
  });
});
