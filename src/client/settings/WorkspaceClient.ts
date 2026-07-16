import type { WorkspaceCatalog, WorkspaceMode, WorkspaceReferenceGrant, WorkspaceSettings } from '../../shared/protocol';

export interface WorkspaceLifecycleResult { workspaceId: string; version: string; previewUrl: string; catalog: WorkspaceCatalog; settings: WorkspaceSettings }
export interface ActiveWorkspaceResult { id: string; name: string; version: string; previewUrl: string }
export async function getActiveWorkspace(): Promise<ActiveWorkspaceResult> { return request('/api/workspace'); }
export async function getWorkspaces(): Promise<WorkspaceCatalog> { return request('/api/workspaces'); }
export async function createWorkspace(name: string, mode: WorkspaceMode): Promise<WorkspaceLifecycleResult> { return request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, mode }) }); }
export async function activateWorkspace(id: string): Promise<WorkspaceLifecycleResult> { return request(`/api/workspaces/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
export async function duplicateWorkspace(id: string, name: string): Promise<WorkspaceLifecycleResult> { return request(`/api/workspaces/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) }); }
export async function renameWorkspace(id: string, name: string): Promise<WorkspaceCatalog> { return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }); }
export async function deleteWorkspace(id: string): Promise<WorkspaceCatalog> { return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export async function createReferenceGrant(text: string, replaceId?: string): Promise<WorkspaceReferenceGrant> { return request('/api/workspace-reference-grants', { method: 'POST', body: JSON.stringify({ text, replaceId }) }); }
export async function referenceOperation<T>(action: 'list' | 'read' | 'search' | 'copy', body: Record<string, unknown>): Promise<T> { return request(`/api/workspace/references/${action}`, { method: 'POST', body: JSON.stringify(body) }); }

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', headers: { 'content-type': 'application/json', ...(init.headers || {}) }, ...init });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Workspace request failed (${response.status})`);
  return response.json();
}
