import { describe, expect, it } from 'vitest';
import { normalizeDraftRevisions, type AgentConfigurationDraft } from './AgentConfigClient.js';

describe('agent configuration drafts', () => {
  it('upgrades newly-created zero revisions before saving', () => {
    const now = new Date().toISOString();
    const draft = {
      profiles: [], workspaceOverrides: [], contexts: [], routing: { mode: 'automatic', tieThreshold: 5, semanticWeight: 1, reliabilityWeight: 1 },
      skills: [{ id: 'new-skill', name: 'New skill', description: '', instructions: '', capabilities: [], requiredToolIds: [], requiredSecretKinds: [], contextIds: [], enabled: true, revision: 0, createdAt: now, updatedAt: now }],
    } satisfies AgentConfigurationDraft;

    expect(normalizeDraftRevisions(draft).skills[0].revision).toBe(1);
  });
});
