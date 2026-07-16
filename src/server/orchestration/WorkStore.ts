import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { TaskRequest, WorkEvent, WorkItemSnapshot, WorkRequest, WorkStatus, WorkStrategy } from '../../shared/protocol.js';

const TERMINAL = new Set<WorkStatus>(['completed', 'failed', 'cancelled', 'superseded']);

export class WorkStore {
  private readonly db: Database.Database;
  private readonly listeners = new Set<(event: WorkEvent) => void>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        client_request_id TEXT,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS work_client_request
        ON work_items(workspace_id, client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_workspace_status ON work_items(workspace_id, status, created_at);
      CREATE INDEX IF NOT EXISTS work_fingerprint ON work_items(workspace_id, fingerprint, status);
      CREATE TABLE IF NOT EXISTS work_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_events_workspace ON work_events(workspace_id, seq);
      CREATE TABLE IF NOT EXISTS work_operations (
        operation_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  recover() {
    const interrupted = this.listAll().filter((work) => !TERMINAL.has(work.status) && !['queued', 'awaiting_approval', 'needs_input'].includes(work.status));
    for (const work of interrupted) this.replace({ ...work, status: 'queued', updatedAt: now(), attempts: work.attempts.map((attempt) => ['running', 'cancelling'].includes(attempt.status) ? { ...attempt, status: 'failed', error: 'Interrupted by server restart.', updatedAt: now(), completedAt: now() } : attempt) });
    return interrupted.length;
  }

  submit(workspaceId: string, input: WorkRequest) {
    const request = normalizeRequest(input); const strategy: WorkStrategy = input.strategy || 'auto';
    const fingerprint = fingerprintFor(workspaceId, strategy, request);
    if (input.clientRequestId) {
      const replay = this.rowByClientId(workspaceId, input.clientRequestId);
      if (replay) return { work: replay, duplicate: true };
    }
    if (input.dedupeMode !== 'force') {
      const duplicate = this.findActiveFingerprint(workspaceId, fingerprint);
      if (duplicate) return { work: duplicate, duplicate: true };
    }
    const at = now(); const work: WorkItemSnapshot = {
      kind: 'work', id: randomUUID(), workspaceId, strategy, status: 'queued', specRevision: 1, request, fingerprint,
      createdAt: at, updatedAt: at, subtasks: [], attempts: [], questions: [],
    };
    this.db.prepare('INSERT INTO work_items (id, workspace_id, client_request_id, fingerprint, status, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(work.id, workspaceId, input.clientRequestId || null, fingerprint, work.status, JSON.stringify(work), at, at);
    this.publish(workspaceId, work.id, { type: 'work_snapshot', work });
    return { work, duplicate: false };
  }

  get(id: string) { const row = this.db.prepare('SELECT snapshot_json FROM work_items WHERE id = ?').get(id) as { snapshot_json: string } | undefined; return row ? JSON.parse(row.snapshot_json) as WorkItemSnapshot : undefined; }
  list(workspaceId: string, includeTerminal = true) {
    const rows = this.db.prepare(`SELECT snapshot_json FROM work_items WHERE workspace_id = ? ${includeTerminal ? '' : "AND status NOT IN ('completed','failed','cancelled','superseded')"} ORDER BY created_at`).all(workspaceId) as Array<{ snapshot_json: string }>;
    return withQueuePositions(rows.map((row) => JSON.parse(row.snapshot_json) as WorkItemSnapshot));
  }
  listAll() { return (this.db.prepare('SELECT snapshot_json FROM work_items ORDER BY created_at').all() as Array<{ snapshot_json: string }>).map((row) => JSON.parse(row.snapshot_json) as WorkItemSnapshot); }

  update(id: string, mutate: (current: WorkItemSnapshot) => WorkItemSnapshot) {
    const transaction = this.db.transaction(() => {
      const current = this.get(id); if (!current) throw statusError('Work item not found.', 404);
      const next = { ...mutate(structuredClone(current)), id: current.id, workspaceId: current.workspaceId, updatedAt: now() };
      this.write(next); return next;
    });
    const next = transaction(); this.publish(next.workspaceId, next.id, { type: 'work_snapshot', work: next }); return next;
  }

  replace(work: WorkItemSnapshot) { this.write(work); this.publish(work.workspaceId, work.id, { type: 'work_snapshot', work }); return work; }
  subscribe(listener: (event: WorkEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(workspaceId: string, workId: string, event: WorkEvent) { this.publish(workspaceId, workId, event); }
  close() { this.db.close(); }
  events(workspaceId: string, after = 0) {
    return (this.db.prepare('SELECT seq, payload_json FROM work_events WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT 2000').all(workspaceId, after) as Array<{ seq: number; payload_json: string }>).map((row) => ({ seq: row.seq, event: JSON.parse(row.payload_json) as WorkEvent }));
  }

  operation<T>(operationId: string, signatureValue: unknown, action: () => T): T {
    const signature = digest(JSON.stringify(signatureValue));
    const existing = this.db.prepare('SELECT signature, result_json FROM work_operations WHERE operation_id = ?').get(operationId) as { signature: string; result_json: string } | undefined;
    if (existing) { if (existing.signature !== signature) throw statusError('Operation ID was replayed with different arguments.', 409); return JSON.parse(existing.result_json) as T; }
    const result = action(); this.db.prepare('INSERT INTO work_operations (operation_id, signature, result_json, created_at) VALUES (?, ?, ?, ?)').run(operationId, signature, JSON.stringify(result), now()); return result;
  }

  private write(work: WorkItemSnapshot) {
    this.db.prepare('UPDATE work_items SET fingerprint = ?, status = ?, snapshot_json = ?, updated_at = ? WHERE id = ?').run(work.fingerprint, work.status, JSON.stringify(work), work.updatedAt, work.id);
  }
  private rowByClientId(workspaceId: string, id: string) { const row = this.db.prepare('SELECT snapshot_json FROM work_items WHERE workspace_id = ? AND client_request_id = ?').get(workspaceId, id) as { snapshot_json: string } | undefined; return row ? JSON.parse(row.snapshot_json) as WorkItemSnapshot : undefined; }
  private findActiveFingerprint(workspaceId: string, fingerprint: string) {
    const row = this.db.prepare("SELECT snapshot_json FROM work_items WHERE workspace_id = ? AND fingerprint = ? AND status NOT IN ('completed','failed','cancelled','superseded') ORDER BY created_at LIMIT 1").get(workspaceId, fingerprint) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as WorkItemSnapshot : undefined;
  }
  private publish(workspaceId: string, workId: string, event: WorkEvent) {
    this.db.prepare('INSERT INTO work_events (workspace_id, work_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(workspaceId, workId, event.type, JSON.stringify(event), now());
    for (const listener of this.listeners) listener(event);
  }
}

export function fingerprintFor(workspaceId: string, strategy: WorkStrategy, request: TaskRequest) {
  const canonical = {
    workspaceId, strategy: strategy === 'plan_only' ? strategy : 'change', objective: normalizeText(request.objective),
    successCriteria: [...(request.successCriteria || [])].map(normalizeText).sort(), selectedElement: request.selectedElement?.identifier,
    selectedFiles: [...(request.selectedFiles || [])].sort(), approvedPlan: request.approvedPlan?.hash, preferredAgentId: request.preferredAgentId,
  };
  return digest(JSON.stringify(canonical));
}

function normalizeRequest(input: WorkRequest): TaskRequest {
  if (!input.objective?.trim()) throw statusError('Work objective is required.', 400);
  return { objective: input.objective.trim(), successCriteria: input.successCriteria?.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30) || [], selectedElement: input.selectedElement, selectedFiles: input.selectedFiles?.map(String).slice(0, 50), includeCanvasImage: input.includeCanvasImage === true, referenceGrantId: input.referenceGrantId, approvedPlan: input.approvedPlan, preferredAgentId: input.preferredAgentId ? String(input.preferredAgentId) : undefined };
}
function withQueuePositions(items: WorkItemSnapshot[]) { let position = 0; return items.map((item) => item.status === 'queued' ? { ...item, queuePosition: ++position } : { ...item, queuePosition: undefined }); }
function normalizeText(value: string) { return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function now() { return new Date().toISOString(); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
