import type { WorkspaceSettings } from '../../shared/protocol';

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const response = await fetch('/api/workspace/settings', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load workspace settings (${response.status})`);
  return response.json();
}

export async function saveWorkspaceSettings(settings: WorkspaceSettings): Promise<WorkspaceSettings> {
  const response = await fetch('/api/workspace/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Could not save workspace settings (${response.status})`);
  return response.json();
}
