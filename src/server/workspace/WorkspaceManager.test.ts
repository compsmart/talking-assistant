import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sandboxRunArgs, shouldRemovePreviousContainer } from './WorkspaceManager.js';

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
});

describe('WorkspaceManager preview replacement', () => {
  it('does not remove a restarted release that reused its previous container name', () => {
    expect(shouldRemovePreviousContainer('cowork-preview-workspace-initial', 'cowork-preview-workspace-initial')).toBe(false);
    expect(shouldRemovePreviousContainer('cowork-preview-old', 'cowork-preview-new')).toBe(true);
  });
});
