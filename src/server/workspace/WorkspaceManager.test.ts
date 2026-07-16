import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { canReuseInspectedPreview, sandboxRunArgs, shouldRemovePreviousContainer } from './WorkspaceManager.js';

describe('WorkspaceManager sandbox command', () => {
  it('uses the managed coding image with the existing isolation limits', () => {
    const args = sandboxRunArgs('C:\\workspace\\draft', 'node --version');

    expect(args).toContain(config.sandboxImage);
    expect(args).toEqual(expect.arrayContaining([
      '--rm', '--cpus', '2', '--memory', '2g', '--pids-limit', '256',
      '--network', 'none', '-v', 'C:\\workspace\\draft:/workspace',
      '-w', '/workspace', 'sh', '-lc', 'node --version',
    ]));
  });

  it('uses bridge networking only for dependency commands', () => {
    const args = sandboxRunArgs('C:\\workspace\\draft', 'npm install', true);
    const network = args.indexOf('--network');

    expect(args[network + 1]).toBe('bridge');
  });

  it('hardens Node-script containers and supports a read-only workspace mount', () => {
    const args = sandboxRunArgs('C:\\workspace\\draft', "node -- 'scripts/report.mjs'", false, true, true);
    expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-v', 'C:\\workspace\\draft:/workspace:ro']));
  });
});

describe('WorkspaceManager preview replacement', () => {
  it('does not remove a restarted release that reused its previous container name', () => {
    expect(shouldRemovePreviousContainer('cowork-preview-workspace-initial', 'cowork-preview-workspace-initial')).toBe(false);
    expect(shouldRemovePreviousContainer('cowork-preview-old', 'cowork-preview-new')).toBe(true);
  });

  it('reuses an inspected image only for the exact source and workspace mode', () => {
    const artifact = { fingerprint: 'source-a', mode: 'mixed' as const };
    expect(canReuseInspectedPreview(artifact, 'source-a', 'mixed')).toBe(true);
    expect(canReuseInspectedPreview(artifact, 'source-b', 'mixed')).toBe(false);
    expect(canReuseInspectedPreview(artifact, 'source-a', 'canvas')).toBe(false);
  });
});
