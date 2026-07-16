import { describe, expect, it } from 'vitest';
import { WorkspaceRegistry } from './WorkspaceRegistry.js';
import { WorkspaceReferenceGrants } from './WorkspaceReferenceGrants.js';

function registry() {
  const value = new WorkspaceRegistry();
  (value as any).catalog = {
    activeWorkspaceId: 'active',
    workspaces: [
      { id: 'active', name: 'Current Site', createdAt: '', updatedAt: '' },
      { id: 'art', name: 'Art', createdAt: '', updatedAt: '' },
      { id: 'board', name: 'Art Board', createdAt: '', updatedAt: '' },
      { id: 'marketing', name: 'Marketing', createdAt: '', updatedAt: '' },
    ],
  };
  return value;
}

describe('cross-workspace reference grants', () => {
  it('matches exact workspace-name phrases, case-insensitively, with longest-name precedence', () => {
    const value = registry();
    expect(value.explicitReferences('Import the logo from ART BOARD workspace.').map((item) => item.id)).toEqual(['board']);
    expect(value.explicitReferences('Use the cart icon.')).toEqual([]);
    expect(value.explicitReferences('Compare Marketing and Current Site.').map((item) => item.id)).toEqual(['marketing']);
  });

  it('replaces the prior turn grant and rejects it after switching active workspaces', () => {
    const value = registry(); const grants = new WorkspaceReferenceGrants(value);
    const first = grants.create('Read Marketing workspace'); expect(grants.resolve(first.id)).toEqual(['marketing']);
    const second = grants.create('No other workspace here', first.id); expect(() => grants.resolve(first.id)).toThrow(/missing, expired/); expect(grants.resolve(second.id)).toEqual([]);
    const third = grants.create('Read Art workspace'); (value as any).catalog.activeWorkspaceId = 'marketing'; expect(() => grants.resolve(third.id)).toThrow(/another request/);
  });
});
