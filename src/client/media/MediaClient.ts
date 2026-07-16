import type { MediaJobRequest, MediaJobSnapshot, MediaStageName } from '../../shared/protocol';

async function json<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, { cache: 'no-store', ...init }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Media request failed (${response.status})`); return response.json(); }
export function createMediaJob(request: MediaJobRequest) { return json<MediaJobSnapshot>('/api/media-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }); }
export function listMediaJobs() { return json<MediaJobSnapshot[]>('/api/media-jobs'); }
export function getMediaJob(id: string) { return json<MediaJobSnapshot>(`/api/media-jobs/${encodeURIComponent(id)}`); }
export function cancelMediaJob(id: string) { return json(`/api/media-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
export function discardMediaJob(id: string) { return json(`/api/media-jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export function updateMediaSettings(id: string, revision: number, settings: Record<string, unknown>) { return json<MediaJobSnapshot>(`/api/media-jobs/${encodeURIComponent(id)}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, ...settings }) }); }
export function rerunMediaStage(id: string, stage: MediaStageName, revision: number) { return json<MediaJobSnapshot>(`/api/media-jobs/${encodeURIComponent(id)}/stages/${stage}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }) }); }
export function saveMediaJob(id: string, revision: number, selectedRevision: number) { return json<MediaJobSnapshot>(`/api/media-jobs/${encodeURIComponent(id)}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, selectedRevision }) }); }

export function watchMediaJob(id: string, onSnapshot: (job: MediaJobSnapshot) => void) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${location.host}/api/activity?taskId=${encodeURIComponent(id)}`);
  socket.onmessage = (message) => { const payload = JSON.parse(String(message.data)); if (payload.type === 'snapshot' && payload.task?.kind === 'media') onSnapshot(payload.task); };
  return () => socket.close();
}
