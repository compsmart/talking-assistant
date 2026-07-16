import { describe, expect, it, vi } from 'vitest';
import { WorkspaceChangeService } from './WorkspaceChangeService.js';
import { WorkspaceMutationLock } from './WorkspaceMutationLock.js';

describe('direct edit validation profiles', () => {
  it.each(['standard', 'fast', 'unchecked'] as const)('skips the coding-agent test pipeline in %s validation mode', async (validation) => {
    const workspace = { validate: vi.fn().mockResolvedValue([]), publish: vi.fn().mockResolvedValue({ version: 'v1' }), restoreDraft: vi.fn() };
    const tools = { manifest: vi.fn().mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([['a.ts', 'hash']])), changed: vi.fn().mockReturnValue([{ path: 'a.ts', action: 'added' }]) };
    const files = { apply: vi.fn().mockResolvedValue({ ok: true }) };
    const settings = { get: () => ({ mode: 'dom', codingAgent: { validation } }) };
    const service = new WorkspaceChangeService(workspace as any, tools as any, files as any, new WorkspaceMutationLock(), settings as any);
    await service.edit([{ path: 'a.ts', mode: 'write', content: 'ok' }]);
    expect(workspace.validate).not.toHaveBeenCalled();
    expect(workspace.publish).toHaveBeenCalledWith(expect.any(String), { mode: 'dom', browserGuard: validation === 'fast' });
  });

  it('verifies deletion with one publish build instead of the full test pipeline', async () => {
    const workspace = { validate: vi.fn(), publish: vi.fn().mockResolvedValue({ version: 'v1' }), restoreDraft: vi.fn() };
    const tools = { manifest: vi.fn().mockResolvedValueOnce(new Map([['a.ts', 'hash']])).mockResolvedValueOnce(new Map()), changed: vi.fn().mockReturnValue([{ path: 'a.ts', action: 'deleted' }]) };
    const files = { remove: vi.fn().mockResolvedValue(['a.ts']) };
    const settings = { get: () => ({ mode: 'dom', codingAgent: { validation: 'standard' } }) };
    const service = new WorkspaceChangeService(workspace as any, tools as any, files as any, new WorkspaceMutationLock(), settings as any);

    await expect(service.remove(['a.ts'])).resolves.toMatchObject({ value: ['a.ts'], version: 'v1' });
    expect(workspace.validate).not.toHaveBeenCalled();
    expect(workspace.publish).toHaveBeenCalledWith(expect.any(String), { mode: 'dom', browserGuard: true });
  });

  it('publishes a file copy as one guarded workspace mutation', async () => {
    const workspace = { validate: vi.fn(), publish: vi.fn().mockResolvedValue({ version: 'v2' }), restoreDraft: vi.fn() };
    const tools = { manifest: vi.fn().mockResolvedValueOnce(new Map([['a.bin', 'one']])).mockResolvedValueOnce(new Map([['a.bin', 'one'], ['a copy.bin', 'one']])), changed: vi.fn().mockReturnValue([{ path: 'a copy.bin', action: 'added' }]) };
    const files = { copyFile: vi.fn().mockResolvedValue({ sourcePath: 'a.bin', path: 'a copy.bin', bytes: 4 }) };
    const settings = { get: () => ({ mode: 'dom', codingAgent: { validation: 'standard' } }) };
    const service = new WorkspaceChangeService(workspace as any, tools as any, files as any, new WorkspaceMutationLock(), settings as any);

    await expect(service.copyFile('a.bin', '.')).resolves.toMatchObject({ value: { path: 'a copy.bin' }, version: 'v2' });
    expect(files.copyFile).toHaveBeenCalledWith('a.bin', '.');
    expect(workspace.publish).toHaveBeenCalledWith(expect.any(String), { mode: 'dom', browserGuard: true });
  });

  it('deduplicates direct-edit operation IDs and rejects mismatched replays', async () => {
    const workspace = { validate: vi.fn(), publish: vi.fn().mockResolvedValue({ version: 'v1' }), restoreDraft: vi.fn() };
    const tools = { manifest: vi.fn().mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([['a.ts', 'hash']])), changed: vi.fn().mockReturnValue([{ path: 'a.ts', action: 'added' }]) };
    const files = { apply: vi.fn().mockResolvedValue({ ok: true }) }; const settings = { get: () => ({ mode: 'dom', codingAgent: { validation: 'standard' } }) };
    const service = new WorkspaceChangeService(workspace as any, tools as any, files as any, new WorkspaceMutationLock(), settings as any);
    const edit = [{ path: 'a.ts', mode: 'write' as const, content: 'ok' }];
    await service.edit(edit, 'a direct file edit', 'call-1'); await service.edit(edit, 'a direct file edit', 'call-1');
    expect(files.apply).toHaveBeenCalledTimes(1);
    await expect(service.edit([{ ...edit[0], content: 'different' }], 'a direct file edit', 'call-1')).rejects.toThrow(/reused with different edits/);
  });
});
