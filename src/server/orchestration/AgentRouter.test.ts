import { describe, expect, it } from 'vitest';
import { AgentRouter, type RoutableAgentProfile } from './AgentRouter.js';

const base = (overrides: Partial<RoutableAgentProfile> = {}): RoutableAgentProfile => ({
  id: 'coder', name: 'Coder', enabled: true, stages: ['implementation'], capabilities: ['typescript'],
  tools: ['read', 'edit'], secrets: [], maxConcurrency: 2, ...overrides,
});

describe('AgentRouter', () => {
  it('hard-filters every eligibility constraint and explains exclusions', () => {
    const profiles = [
      base({ id: 'disabled', enabled: false }),
      base({ id: 'wrong-stage', stages: ['review'] }),
      base({ id: 'missing-cap', capabilities: [] }),
      base({ id: 'missing-tool', tools: ['read'] }),
      base({ id: 'missing-secret' }),
      base({ id: 'busy' }),
    ];
    const decision = new AgentRouter().route({
      stage: 'implementation', objective: 'ship it', requiredCapabilities: ['typescript'], requiredTools: ['edit'], requiredSecrets: ['deploy-key'],
    }, profiles.map((profile) => profile.id === 'missing-secret' ? profile : { ...profile, secrets: ['deploy-key'] }), { busy: { active: 2 } });

    expect(decision.status).toBe('no_eligible');
    expect(decision.excluded.flatMap(({ reasons }) => reasons)).toEqual(expect.arrayContaining([
      'disabled', 'does not support stage implementation', 'missing capability typescript', 'missing tool edit', 'missing secret deploy-key', 'at concurrency limit 2',
    ]));
  });

  it('combines bounded score components and exposes matched rules', () => {
    const profiles = [base({
      priority: 20, model: 'same', routingRules: [{ id: 'frontend', weight: 15, keywords: ['react'], fileGlobs: ['src/client/**'] }],
    }), base({ id: 'general', name: 'General', model: 'same' })];
    const decision = new AgentRouter().route({
      stage: 'implementation', objective: 'Fix React view', files: ['src/client/App.tsx'], semanticScores: { coder: 70, general: 80 },
    }, profiles, { coder: { active: 1, reliability: 0.9 }, general: { active: 0, reliability: 0.5 } });

    expect(decision.status).toBe('selected');
    if (decision.status !== 'selected') return;
    expect(decision.selected.id).toBe('coder');
    expect(decision.selected.matchedRules).toEqual(['frontend']);
    expect(decision.selected.score).toEqual({ semantic: 70, priority: 20, rules: 15, reliability: 8, load: 5, total: 108 });
    expect(decision.reason).toContain('semantic 70 + priority 20');
  });

  it('honors an eligible preferred agent regardless of score', () => {
    const decision = new AgentRouter().route({
      stage: 'implementation', objective: 'work', preferredAgentId: 'slow', semanticScores: { coder: 100, slow: 0 },
    }, [base(), base({ id: 'slow', name: 'Slow' })]);
    expect(decision.status).toBe('selected');
    if (decision.status === 'selected') expect({ id: decision.selected.id, preferred: decision.preferred }).toEqual({ id: 'slow', preferred: true });
  });

  it('fails explicitly instead of falling back from an ineligible preferred agent', () => {
    const decision = new AgentRouter().route({ stage: 'implementation', objective: 'work', preferredAgentId: 'busy' },
      [base(), base({ id: 'busy', name: 'Busy', maxConcurrency: 1 })], { busy: { active: 1 } });
    expect(decision.status).toBe('no_eligible');
    expect(decision.reason).toMatch(/preferred agent busy is ineligible.*concurrency limit/i);
  });

  it('returns a tie only for close materially different candidates', () => {
    const profiles = [base({ id: 'cheap', name: 'Cheap', model: 'flash', costClass: 'low' }), base({ id: 'deep', name: 'Deep', model: 'pro', costClass: 'high' })];
    const decision = new AgentRouter().route({ stage: 'implementation', objective: 'work', semanticScores: { cheap: 80, deep: 78 } }, profiles);
    expect(decision.status).toBe('tie');
    expect(decision.reason).toMatch(/within 5 points and differ materially/i);
  });

  it('resolves equivalent ties deterministically by priority, load, then id', () => {
    const profiles = [base({ id: 'b', model: 'same' }), base({ id: 'a', model: 'same' })];
    const decision = new AgentRouter().route({ stage: 'implementation', objective: 'work' }, profiles);
    expect(decision.status).toBe('selected');
    if (decision.status === 'selected') expect(decision.selected.id).toBe('a');
  });

  it('applies excluding rules during eligibility filtering', () => {
    const decision = new AgentRouter().route({ stage: 'implementation', objective: 'touch generated output', files: ['dist/app.js'] }, [
      base({ routingRules: [{ id: 'no-dist', weight: 0, exclude: true, fileGlobs: ['dist/**'] }] }),
    ]);
    expect(decision.status).toBe('no_eligible');
    expect(decision.excluded[0]?.reasons).toContain('excluded by rule no-dist');
  });
});
