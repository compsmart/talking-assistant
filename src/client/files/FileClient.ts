import type { AssetRecord, ImageAssetGenerationRequest, ImageAssetGenerationResult, WorkspaceEdit, WorkspaceFileDocument, WorkspaceFileNode } from '../../shared/protocol';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Workspace request failed (${response.status})`);
  return body as T;
}

export function listFiles(path = '.', optional = false) { return fetch(`/api/workspace/files?path=${encodeURIComponent(path)}${optional ? '&optional=1' : ''}`, { cache: 'no-store' }).then((response) => json<WorkspaceFileNode[]>(response)); }
export function readFile(path: string) { return fetch(`/api/workspace/files/read?path=${encodeURIComponent(path)}`, { cache: 'no-store' }).then((response) => json<WorkspaceFileDocument>(response)); }
export function searchFiles(query: string, path = '.') { return fetch(`/api/workspace/files/search?q=${encodeURIComponent(query)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' }).then((response) => json<Array<{ path: string; line?: number; text?: string }>>(response)); }
export function rawFileUrl(path: string) { return `/api/workspace/files/raw?path=${encodeURIComponent(path)}`; }
export function editFiles(edits: WorkspaceEdit[], operationId?: string) { return fetch('/api/workspace/files/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edits, operationId }) }).then((response) => json<{ version: string; previewUrl: string }>(response)); }
export interface WorkspaceFileMutationResult {
  value: { path: string; previousPath?: string; sourcePath?: string; bytes?: number };
  version: string;
  previewUrl: string;
}
export function createFile(directory: string, name: string) { return fetch('/api/workspace/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory, name }) }).then((response) => json<WorkspaceFileMutationResult>(response)); }
export function renameFile(path: string, newName: string) { return fetch('/api/workspace/files', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, newName }) }).then((response) => json<WorkspaceFileMutationResult>(response)); }
export function copyFile(sourcePath: string, destinationDirectory: string) { return fetch('/api/workspace/files/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourcePath, destinationDirectory }) }).then((response) => json<WorkspaceFileMutationResult>(response)); }
export function deleteFiles(paths: string[]) { return fetch('/api/workspace/files', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }).then((response) => json<{ value: string[]; version: string; previewUrl: string }>(response)); }
export function gitStatus() { return fetch('/api/workspace/git/status', { cache: 'no-store' }).then((response) => json<{ dirty: boolean; changes: Array<{ status: string; path: string }>; fingerprint: string }>(response)); }
export function commitWorkspace(actions: string[] = []) { return fetch('/api/workspace/git/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions }) }).then((response) => json<{ committed: boolean; hash?: string; files?: number; message: string }>(response)); }
export function generateImageAsset(request: ImageAssetGenerationRequest) { return fetch('/api/workspace/assets/images', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }).then((response) => json<ImageAssetGenerationResult>(response)); }
export interface UploadOptions {
  destination?: string;
  accept?: 'media' | 'image';
  onProgress?: (progress: number) => void;
}

export function uploadFiles(files: File[], options: UploadOptions = {}) {
  return new Promise<{ value: AssetRecord[]; version: string; previewUrl: string }>((resolve, reject) => {
    const form = new FormData();
    if (options.destination !== undefined) form.append('destination', options.destination);
    if (options.accept) form.append('accept', options.accept);
    files.forEach((file) => form.append('files', file, file.name));
    const request = new XMLHttpRequest();
    request.open('POST', '/api/workspace/uploads'); request.upload.onprogress = (event) => { if (event.lengthComputable) options.onProgress?.(event.loaded / event.total); };
    request.onerror = () => reject(new Error('Media upload failed.'));
    request.onload = () => { try { const body = JSON.parse(request.responseText || '{}'); if (request.status < 200 || request.status >= 300) throw new Error(body.error || `Upload failed (${request.status})`); resolve(body); } catch (error) { reject(error); } };
    request.send(form);
  });
}
