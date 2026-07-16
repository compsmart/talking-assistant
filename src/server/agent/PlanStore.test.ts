import { afterEach, describe, expect, it } from 'vitest';
import { access, cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanStore } from './PlanStore.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function subject() {
  const root = await mkdtemp(join(tmpdir(), 'cowork-plans-')); roots.push(root);
  const context = { id: 'workspace-1', draftDir: join(root, 'draft'), stateDir: join(root, 'state'), releasesDir: join(root, 'releases') };
  await mkdir(context.draftDir, { recursive: true });
  const registry = { active: () => context, get: (id: string) => { if (id !== context.id) throw new Error('missing'); return context; } };
  return { store: new PlanStore(registry as any), context };
}

describe('PlanStore', () => {
  it('persists generated plans and review edits with optimistic hashes', async () => {
    const { store, context } = await subject();
    const record = await store.saveGenerated('12345678-abcd', { objective: 'Add account settings' }, [], '# Initial plan');
    expect(record.path).toMatch(/^plans\/.+add-account-settings-12345678\.md$/);
    expect(await readFile(join(context.draftDir, record.path), 'utf8')).toBe('# Initial plan\n');
    const edited = await store.saveReview(record.path, '# Reviewed plan', record.hash);
    expect((await store.read(record.path)).content).toBe('# Reviewed plan\n');
    await expect(store.saveReview(record.path, '# Stale edit', record.hash)).rejects.toThrow(/changed after it was opened/);
    expect((await store.pending())?.hash).toBe(edited.hash);
  });

  it('rejects paths outside the plans directory', async () => {
    const { store } = await subject();
    await expect(store.read('../secret.md')).rejects.toThrow(/beneath plans/);
    await expect(store.read('src/plan.md')).rejects.toThrow(/beneath plans/);
  });

  it('removes a completed plan from the draft, published release, and pending records', async () => {
    const { store, context } = await subject();
    const record = await store.saveGenerated('12345678-abcd', { objective: 'Add account settings' }, [], '# Plan');
    const release = join(context.releasesDir, 'release-1');
    await mkdir(context.releasesDir, { recursive: true });
    await cp(context.draftDir, release, { recursive: true });

    await store.removeCompleted(record.id, record.path, context.id, 'release-1');

    await expect(access(join(context.draftDir, record.path))).rejects.toThrow();
    await expect(access(join(release, record.path))).rejects.toThrow();
    expect(await store.getByPath(record.path)).toBeUndefined();
    expect(await store.pending()).toBeUndefined();
  });
});
