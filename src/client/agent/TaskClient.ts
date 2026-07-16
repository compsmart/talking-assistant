import type { ActivityEvent, AgentRunResult, AgentRunSnapshot, PlanRequest, PlanningRunSnapshot, TaskRequest, TaskResult, TaskSnapshot } from '../../shared/protocol';

export async function createTask(request: TaskRequest): Promise<TaskSnapshot> {
  const response = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Task creation failed (${response.status})`);
  return response.json();
}

export async function cancelTask(id: string) { const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Could not cancel coding task (${response.status})`); }
export async function cancelPlan(id: string) { const response = await fetch(`/api/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Could not cancel planning run (${response.status})`); }
export async function continuePlan(id: string, proceed = true) {
  const response = await fetch(`/api/plans/${encodeURIComponent(id)}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ continue: proceed }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Could not continue planning (${response.status})`);
  return response.json() as Promise<{ ok: true }>;
}

export async function getActiveTask(): Promise<TaskSnapshot | null> {
  const response = await fetch('/api/tasks/active');
  if (!response.ok) throw new Error(`Could not read coding-task status (${response.status})`);
  return response.json();
}

export async function getActiveRun(): Promise<AgentRunSnapshot | null> {
  const response = await fetch('/api/agent-runs/active', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read agent status (${response.status})`);
  return response.json();
}

export async function createPlan(request: PlanRequest): Promise<PlanningRunSnapshot> {
  const response = await fetch('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Plan creation failed (${response.status})`);
  return response.json();
}

export interface PendingPlan { id: string; workspaceId: string; path: string; hash: string; status: 'awaiting_review' | 'executing'; updatedAt: string }
export async function getPendingPlan(): Promise<PendingPlan | null> {
  const response = await fetch('/api/plans/pending', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read pending plans (${response.status})`);
  return response.json();
}

export async function savePlan(path: string, content: string, expectedHash?: string) {
  const response = await fetch('/api/plans/content', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, expectedHash }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Plan save failed (${response.status})`);
  return response.json() as Promise<{ path: string; hash: string; updatedAt: string }>;
}

export async function executePlan(path: string, expectedHash?: string): Promise<TaskSnapshot> {
  const response = await fetch('/api/plans/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, expectedHash }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Plan execution failed (${response.status})`);
  return response.json();
}

export function watchTask(id: string, onEvent: (event: ActivityEvent) => void, onSnapshot: (task: TaskSnapshot) => void): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/activity?taskId=${encodeURIComponent(id)}`);
    socket.onmessage = (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.type === 'event') onEvent(payload.event);
      if (payload.type === 'snapshot') {
        onSnapshot(payload.task);
        if (payload.task.result) { socket.close(); resolve(payload.task.result); }
      }
    };
    socket.onerror = () => reject(new Error('Lost the coding-agent activity stream'));
  });
}

export function watchAgentRun(id: string, onEvent: (event: ActivityEvent) => void, onSnapshot: (run: AgentRunSnapshot) => void): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/activity?taskId=${encodeURIComponent(id)}`);
    socket.onmessage = (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.type === 'event') onEvent(payload.event);
      if (payload.type === 'snapshot') {
        onSnapshot(payload.task);
        if (payload.task.result) { socket.close(); resolve(payload.task.result); }
      }
    };
    socket.onerror = () => reject(new Error('Lost the agent activity stream'));
  });
}
