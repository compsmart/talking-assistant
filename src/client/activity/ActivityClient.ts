import type { ActivityEvent, ActivityPage, ActivityRecord, RecoveryState, WorkspaceReleaseSummary } from '../../shared/protocol';

async function json<T>(response: Response): Promise<T> { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Activity request failed (${response.status})`); return body as T; }
export function getActivity(options: { scope?: 'active' | 'all'; severity?: string; source?: string; query?: string; cursor?: string } = {}) {
  const query = new URLSearchParams(); if (options.scope === 'all') query.set('scope', 'all'); if (options.severity) query.set('severity', options.severity); if (options.source) query.set('source', options.source); if (options.query) query.set('q', options.query); if (options.cursor) query.set('cursor', options.cursor);
  return fetch(`/api/activity?${query}`, { cache: 'no-store' }).then((response) => json<ActivityPage>(response));
}
export function getActivityEvents(id: string) { return fetch(`/api/activity/${encodeURIComponent(id)}/events`, { cache: 'no-store' }).then((response) => json<ActivityEvent[]>(response)); }
export function resolveActivity(id: string, resolution = 'Marked resolved') { return fetch(`/api/activity/${encodeURIComponent(id)}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution }) }).then((response) => json<ActivityRecord>(response)); }
export function getRecoveryState() { return fetch('/api/activity/state', { cache: 'no-store' }).then((response) => json<RecoveryState>(response)); }
export function getReleases() { return fetch('/api/workspace/releases', { cache: 'no-store' }).then((response) => json<WorkspaceReleaseSummary[]>(response)); }
export function restartPreview() { return fetch('/api/recovery/preview/restart', { method: 'POST' }).then((response) => json<{ version: string; previewUrl: string }>(response)); }
export function restoreDraft(state: RecoveryState) { return fetch('/api/recovery/draft/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: state.workspaceVersion, expectedFingerprint: state.git.fingerprint }) }).then((response) => json<{ version: string; previewUrl: string }>(response)); }
export function activateRelease(version: string, state: RecoveryState) { return fetch(`/api/workspace/releases/${encodeURIComponent(version)}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: state.workspaceVersion, expectedFingerprint: state.git.fingerprint }) }).then((response) => json<{ version: string; previewUrl: string }>(response)); }
export function watchActivity(onRecord: (record: ActivityRecord) => void) {
  let stopped = false; let socket: WebSocket | undefined; let timer: number | undefined; const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connect = () => { if (stopped) return; socket = new WebSocket(`${protocol}//${location.host}/api/activity?scope=feed`); socket.onmessage = (message) => { const payload = JSON.parse(String(message.data)); if (payload.type === 'activity') onRecord(payload.record); }; socket.onclose = () => { if (!stopped) timer = window.setTimeout(connect, 1500); }; };
  connect(); return () => { stopped = true; if (timer) window.clearTimeout(timer); socket?.close(); };
}
export function recordClientError(message: string, source: 'live' | 'system' = 'system') { return fetch('/api/activity/client', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, severity: 'error', status: 'failed', title: source === 'live' ? 'Live connection error' : 'Client error', message }) }).catch(() => undefined); }
