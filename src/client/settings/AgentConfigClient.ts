import type {
  AgentConfigurationSnapshot,
  AgentContextResource,
  AgentProfile,
  AgentSkill,
  AgentToolDescriptor,
  AgentToolDirectory,
  RoutingSimulation,
  SecretMetadata,
} from '../../shared/protocol';

export interface AgentConfigurationDraft {
  profiles: AgentProfile[];
  workspaceOverrides: AgentConfigurationSnapshot['overrides'];
  skills: AgentSkill[];
  contexts: AgentContextResource[];
  routing: AgentConfigurationSnapshot['routing'];
}

export interface SecretInput {
  name: string;
  kind: string;
  scope: 'global' | 'workspace';
  exposure: 'tool_only' | 'model_readable';
  value: string;
}

export interface SecretUpdate {
  name?: string;
  value?: string;
  exposure?: 'tool_only' | 'model_readable';
  grants?: string[];
}

export interface RoutingSimulationInput {
  objective: string;
  stage?: string;
  requiredCapabilities?: string[];
  requiredTools?: string[];
}

export function getAgentConfiguration(workspaceId?: string): Promise<AgentConfigurationSnapshot> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return request(`/api/agent-config${query}`);
}

export async function getAgentTools(): Promise<AgentToolDirectory> {
  const value = await request<AgentToolDirectory | AgentToolDescriptor[]>('/api/agents/tools');
  return Array.isArray(value) ? { categories: [], tools: value } : value;
}

export function saveAgentConfiguration(snapshot: AgentConfigurationSnapshot, draft: AgentConfigurationDraft): Promise<AgentConfigurationSnapshot> {
  return request('/api/agent-config', {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision: snapshot.revision, ...normalizeDraftRevisions(draft) }),
  });
}

export function normalizeDraftRevisions(draft: AgentConfigurationDraft): AgentConfigurationDraft {
  const revision = <T extends { revision: number }>(item: T): T => item.revision === 0 ? { ...item, revision: 1 } : item;
  return {
    ...draft,
    profiles: draft.profiles.map(revision),
    workspaceOverrides: draft.workspaceOverrides.map(revision),
    skills: draft.skills.map(revision),
    contexts: draft.contexts.map(revision),
  };
}

export function simulateAgentRouting(input: RoutingSimulationInput): Promise<RoutingSimulation> {
  return request('/api/agent-routing/simulate', { method: 'POST', body: JSON.stringify(input) });
}

export function createAgentSecret(input: SecretInput): Promise<SecretMetadata> {
  return request('/api/agent-secrets', { method: 'POST', body: JSON.stringify(input) });
}

export function updateAgentSecret(id: string, input: SecretUpdate): Promise<SecretMetadata> {
  return request(`/api/agent-secrets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function deleteAgentSecret(id: string): Promise<void> {
  return request(`/api/agent-secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await response.json().catch(() => undefined) as { error?: string } | T | undefined;
  if (!response.ok) throw new Error((body as { error?: string } | undefined)?.error || `Agent configuration request failed (${response.status})`);
  return body as T;
}
