export type AgentRoutingStage = 'planning' | 'research' | 'implementation' | 'review' | 'resolution' | 'media' | string;

export interface AgentRoutingRule {
  id: string;
  weight: number;
  stages?: string[];
  capabilities?: string[];
  keywords?: string[];
  fileGlobs?: string[];
  exclude?: boolean;
}

/** A deliberately structural view of an agent profile. Registry-owned profiles can be passed directly. */
export interface RoutableAgentProfile {
  id: string;
  name?: string;
  enabled: boolean;
  stages: string[];
  capabilities: string[];
  tools: string[];
  secrets: string[];
  priority?: number;
  routingRules?: AgentRoutingRule[];
  maxConcurrency?: number;
  model?: string;
  specialization?: string;
  costClass?: string;
  riskClass?: string;
  secretExposure?: 'none' | 'tool_only' | 'model_readable';
  configurationErrors?: string[];
}

export interface AgentRoutingState {
  active: number;
  reliability?: number;
}

export interface AgentRoutingRequest {
  stage: AgentRoutingStage;
  objective: string;
  requiredCapabilities?: string[];
  requiredTools?: string[];
  requiredSecrets?: string[];
  files?: string[];
  preferredAgentId?: string;
  semanticScores?: Readonly<Record<string, number>>;
}

export interface AgentScoreComponents {
  semantic: number;
  priority: number;
  rules: number;
  reliability: number;
  load: number;
  total: number;
}

export interface RankedAgent {
  id: string;
  name: string;
  score: AgentScoreComponents;
  matchedRules: string[];
}

export interface ExcludedAgent {
  id: string;
  name: string;
  reasons: string[];
}

export type AgentRoutingDecision =
  | { status: 'selected'; selected: RankedAgent; candidates: RankedAgent[]; excluded: ExcludedAgent[]; reason: string; preferred: boolean }
  | { status: 'tie'; candidates: RankedAgent[]; excluded: ExcludedAgent[]; reason: string }
  | { status: 'no_eligible'; candidates: []; excluded: ExcludedAgent[]; reason: string };

export interface AgentRouterOptions { tieThreshold?: number }

export class AgentRouter {
  private readonly tieThreshold: number;

  constructor(options: AgentRouterOptions = {}) {
    this.tieThreshold = Math.max(0, options.tieThreshold ?? 5);
  }

  route(
    request: AgentRoutingRequest,
    profiles: readonly RoutableAgentProfile[],
    states: Readonly<Record<string, AgentRoutingState>> = {},
  ): AgentRoutingDecision {
    const excluded: ExcludedAgent[] = [];
    const eligible: Array<{ profile: RoutableAgentProfile; state: AgentRoutingState }> = [];

    for (const profile of profiles) {
      const state = states[profile.id] ?? { active: 0 };
      const reasons = eligibilityReasons(profile, state, request);
      if (reasons.length) excluded.push({ id: profile.id, name: profile.name ?? profile.id, reasons });
      else eligible.push({ profile, state });
    }

    if (request.preferredAgentId) {
      const preferred = eligible.find(({ profile }) => profile.id === request.preferredAgentId);
      if (!preferred) {
        const known = profiles.some(({ id }) => id === request.preferredAgentId);
        const detail = excluded.find(({ id }) => id === request.preferredAgentId)?.reasons.join('; ');
        return {
          status: 'no_eligible', candidates: [], excluded,
          reason: known
            ? `Preferred agent ${request.preferredAgentId} is ineligible: ${detail || 'unknown eligibility failure'}.`
            : `Preferred agent ${request.preferredAgentId} does not exist.`,
        };
      }
      const ranked = rank(preferred.profile, preferred.state, request);
      const candidates = sortRanked(eligible.map(({ profile, state }) => rank(profile, state, request)), profiles, states);
      return { status: 'selected', selected: ranked, candidates, excluded, preferred: true, reason: `Selected explicitly preferred agent ${ranked.name}.` };
    }

    if (!eligible.length) {
      return { status: 'no_eligible', candidates: [], excluded, reason: summarizeExclusions(excluded) };
    }

    const candidates = sortRanked(eligible.map(({ profile, state }) => rank(profile, state, request)), profiles, states);
    const first = candidates[0]!;
    const second = candidates[1];
    if (second && first.score.total - second.score.total <= this.tieThreshold) {
      const firstProfile = profiles.find(({ id }) => id === first.id)!;
      const secondProfile = profiles.find(({ id }) => id === second.id)!;
      if (materiallyDifferent(firstProfile, secondProfile)) {
        return {
          status: 'tie', candidates, excluded,
          reason: `${first.name} and ${second.name} are within ${this.tieThreshold} points and differ materially; explicit selection is required.`,
        };
      }
    }

    return {
      status: 'selected', selected: first, candidates, excluded, preferred: false,
      reason: `Selected ${first.name} with score ${first.score.total}; ${scoreExplanation(first.score)}.`,
    };
  }
}

function eligibilityReasons(profile: RoutableAgentProfile, state: AgentRoutingState, request: AgentRoutingRequest): string[] {
  const reasons: string[] = [];
  reasons.push(...(profile.configurationErrors || []));
  if (!profile.enabled) reasons.push('disabled');
  if (!profile.stages.includes(request.stage) && !profile.stages.includes('*')) reasons.push(`does not support stage ${request.stage}`);
  missing(request.requiredCapabilities, profile.capabilities).forEach((item) => reasons.push(`missing capability ${item}`));
  missing(request.requiredTools, profile.tools).forEach((item) => reasons.push(`missing tool ${item}`));
  missing(request.requiredSecrets, profile.secrets).forEach((item) => reasons.push(`missing secret ${item}`));
  const limit = Math.max(0, profile.maxConcurrency ?? 1);
  if (state.active >= limit) reasons.push(`at concurrency limit ${limit}`);
  for (const rule of profile.routingRules ?? []) {
    if (rule.exclude && matchesRule(rule, request)) reasons.push(`excluded by rule ${rule.id}`);
  }
  return reasons;
}

function rank(profile: RoutableAgentProfile, state: AgentRoutingState, request: AgentRoutingRequest): RankedAgent {
  const matched = (profile.routingRules ?? []).filter((rule) => !rule.exclude && matchesRule(rule, request));
  const semantic = clamp(request.semanticScores?.[profile.id] ?? 0, 0, 100);
  const priority = clamp(profile.priority ?? 0, -50, 50);
  const rules = clamp(matched.reduce((sum, rule) => sum + rule.weight, 0), -100, 100);
  const reliability = clamp(((state.reliability ?? 0.5) - 0.5) * 20, -10, 10);
  const limit = Math.max(1, profile.maxConcurrency ?? 1);
  const load = clamp((state.active / limit) * 10, 0, 10);
  const total = round(semantic + priority + rules + reliability - load);
  return {
    id: profile.id,
    name: profile.name ?? profile.id,
    matchedRules: matched.map(({ id }) => id),
    score: { semantic: round(semantic), priority: round(priority), rules: round(rules), reliability: round(reliability), load: round(load), total },
  };
}

function sortRanked(
  candidates: RankedAgent[], profiles: readonly RoutableAgentProfile[], states: Readonly<Record<string, AgentRoutingState>>,
): RankedAgent[] {
  return candidates.sort((a, b) => b.score.total - a.score.total
    || (profiles.find(({ id }) => id === b.id)?.priority ?? 0) - (profiles.find(({ id }) => id === a.id)?.priority ?? 0)
    || (states[a.id]?.active ?? 0) - (states[b.id]?.active ?? 0)
    || a.id.localeCompare(b.id));
}

function matchesRule(rule: AgentRoutingRule, request: AgentRoutingRequest): boolean {
  if (rule.stages?.length && !rule.stages.includes(request.stage)) return false;
  if (rule.capabilities?.length && !rule.capabilities.every((item) => request.requiredCapabilities?.includes(item))) return false;
  if (rule.keywords?.length) {
    const objective = request.objective.toLocaleLowerCase();
    if (!rule.keywords.some((keyword) => objective.includes(keyword.toLocaleLowerCase()))) return false;
  }
  if (rule.fileGlobs?.length && !(request.files ?? []).some((file) => rule.fileGlobs!.some((glob) => globMatches(glob, file)))) return false;
  return true;
}

function globMatches(glob: string, file: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(file.replace(/\\/g, '/'));
}

function materiallyDifferent(a: RoutableAgentProfile, b: RoutableAgentProfile): boolean {
  return ['model', 'specialization', 'costClass', 'riskClass', 'secretExposure']
    .some((key) => a[key as keyof RoutableAgentProfile] !== b[key as keyof RoutableAgentProfile]);
}

function missing(required: readonly string[] | undefined, available: readonly string[]): string[] {
  return (required ?? []).filter((item) => !available.includes(item));
}

function summarizeExclusions(excluded: ExcludedAgent[]): string {
  if (!excluded.length) return 'No agent profiles are configured.';
  return `No eligible agent: ${excluded.map(({ name, reasons }) => `${name} (${reasons.join(', ')})`).join('; ')}.`;
}

function scoreExplanation(score: AgentScoreComponents): string {
  return `semantic ${score.semantic} + priority ${score.priority} + rules ${score.rules} + reliability ${score.reliability} - load ${score.load}`;
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0)); }
function round(value: number): number { return Math.round(value * 100) / 100; }
