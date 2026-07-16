import type { AssistantProfile, AssistantSettings } from '../../shared/protocol';

export async function getAssistantProfile(): Promise<AssistantProfile> {
  const response = await fetch('/api/assistant/profile', { cache: 'no-store' });
  return jsonResponse(response, `Could not load assistant settings (${response.status})`);
}

export async function getAssistantPhoto(version?: string): Promise<Blob> {
  const response = await fetch(`/api/assistant/photo${version ? `?v=${encodeURIComponent(version)}` : ''}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not restore the assistant portrait.');
  return response.blob();
}

export async function saveAssistantProfile(settings: AssistantSettings, photoAction: 'keep' | 'replace' | 'remove', photo?: File): Promise<AssistantProfile> {
  const body = new FormData(); body.set('settings', JSON.stringify(settings)); body.set('photoAction', photoAction);
  if (photoAction === 'replace' && photo) body.set('photo', photo, photo.name);
  const response = await fetch('/api/assistant/profile', { method: 'PUT', body });
  return jsonResponse(response, `Could not save assistant settings (${response.status})`);
}

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('The assistant profile API returned the app page instead of JSON. Restart the Cowork server and try again.');
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || fallback);
  return body as T;
}
