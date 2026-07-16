import type { AssistantIntakeRequest, AssistantIntakeResult, WorkCommandResult, WorkEvent, WorkItemSnapshot, WorkRequest, WorkUpdateMode } from '../../shared/protocol';

async function json<T>(response: Response): Promise<T> { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Work request failed (${response.status})`); return response.json(); }

export function submitWork(request: WorkRequest) { return fetch('/api/work', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }).then((response) => json<WorkCommandResult>(response)); }
export function delegateToAssistant(request: AssistantIntakeRequest) { return fetch('/api/assistant/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }).then((response) => json<AssistantIntakeResult>(response)); }
export function listWork(): Promise<WorkItemSnapshot[]> { return fetch('/api/work', { cache: 'no-store' }).then((response) => json(response)); }
export function getWork(id: string): Promise<WorkItemSnapshot> { return fetch(`/api/work/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((response) => json(response)); }
export function updateWork(id: string, change: Record<string, unknown>, mode: WorkUpdateMode, expectedRevision?: number) { return fetch(`/api/work/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ change, mode, expectedRevision }) }).then((response) => json<WorkCommandResult>(response)); }
export function cancelWork(id: string) { return fetch(`/api/work/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((response) => json<WorkCommandResult>(response)); }
export function approveWorkPlan(id: string, path: string, hash?: string) { return fetch(`/api/work/${encodeURIComponent(id)}/plan/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, hash }) }).then((response) => json<WorkCommandResult>(response)); }
export function answerWorkQuestion(id: string, questionId: string, answer: string) { return fetch(`/api/work/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) }).then((response) => json<WorkCommandResult>(response)); }

export function watchWork(workspaceId: string, initial: (works: WorkItemSnapshot[]) => void, event: (event: WorkEvent) => void) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${location.host}/api/work/events?workspaceId=${encodeURIComponent(workspaceId)}`);
  socket.onmessage = (message) => { const payload = JSON.parse(String(message.data)); if (payload.type === 'work_initial') { initial(payload.works); for (const historical of payload.events || []) event(historical as WorkEvent); } else event(payload as WorkEvent); };
  return () => socket.close();
}
