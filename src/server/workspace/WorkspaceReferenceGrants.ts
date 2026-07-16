import { randomUUID } from 'node:crypto';
import type { WorkspaceReferenceGrant } from '../../shared/protocol.js';
import type { WorkspaceRegistry } from './WorkspaceRegistry.js';

interface StoredGrant extends WorkspaceReferenceGrant { activeWorkspaceId: string }

export class WorkspaceReferenceGrants {
  private grants = new Map<string, StoredGrant>();
  constructor(private readonly registry: WorkspaceRegistry) {}

  create(text: string, replaceId?: string): WorkspaceReferenceGrant {
    if (replaceId) this.grants.delete(replaceId);
    this.prune(); const references = this.registry.explicitReferences(String(text || ''));
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const grant: StoredGrant = { id: randomUUID(), activeWorkspaceId: this.registry.active().id, workspaceIds: references.map((item) => item.id), workspaceNames: references.map((item) => item.name), expiresAt };
    this.grants.set(grant.id, grant); return publicGrant(grant);
  }

  resolve(id?: string) {
    this.prune(); if (!id) return [];
    const grant = this.grants.get(id);
    if (!grant || grant.activeWorkspaceId !== this.registry.active().id) throw statusError('The cross-workspace reference grant is missing, expired, or belongs to another request.', 403);
    return grant.workspaceIds.slice();
  }

  revoke(id?: string) { if (id) this.grants.delete(id); }
  revokeAll() { this.grants.clear(); }
  private prune() { const now = Date.now(); for (const [id, grant] of this.grants) if (Date.parse(grant.expiresAt) <= now) this.grants.delete(id); }
}

function publicGrant(grant: StoredGrant): WorkspaceReferenceGrant { return { id: grant.id, workspaceIds: grant.workspaceIds.slice(), workspaceNames: grant.workspaceNames.slice(), expiresAt: grant.expiresAt }; }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
