import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlanRequest } from '../../shared/protocol.js';
import type { WorkspaceRegistry } from '../workspace/WorkspaceRegistry.js';
import { safeWorkspacePath } from '../workspace/WorkspaceFiles.js';

export interface PlanRecord {
  id: string;
  workspaceId: string;
  path: string;
  hash: string;
  status: 'awaiting_review' | 'executing';
  request: PlanRequest;
  referenceWorkspaceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export class PlanStore {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async saveGenerated(id: string, request: PlanRequest, referenceWorkspaceIds: string[], content: string) {
    const context = this.registry.active();
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const path = `plans/${timestamp}-${slug(request.objective)}-${id.slice(0, 8)}.md`;
    content = normalize(content); await this.writePlan(path, content);
    const now = new Date().toISOString();
    const record: PlanRecord = {
      id, workspaceId: context.id, path, hash: digest(content), status: 'awaiting_review',
      request: structuredClone(request), referenceWorkspaceIds: referenceWorkspaceIds.slice(), createdAt: now, updatedAt: now,
    };
    const records = await this.records(context.id); records.push(record); await this.saveRecords(context.id, records);
    return record;
  }

  async pending(workspaceId = this.registry.active().id) {
    const records = await this.records(workspaceId);
    for (const record of records.filter((item) => item.status === 'awaiting_review').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (await this.read(record.path, workspaceId).then(() => true).catch(() => false)) return record;
    }
    return undefined;
  }

  async getByPath(path: string, workspaceId = this.registry.active().id) {
    assertPlanPath(path);
    return (await this.records(workspaceId)).find((item) => item.path === path);
  }

  async read(path: string, workspaceId = this.registry.active().id) {
    assertPlanPath(path);
    const context = this.registry.get(workspaceId);
    const file = await safeWorkspacePath(context.draftDir, path, true);
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content) > 256 * 1024) throw statusError('Plans cannot exceed 256 KB.', 413);
    return { content, hash: digest(content) };
  }

  async saveReview(path: string, content: string, expectedHash?: string) {
    assertPlanPath(path);
    if (Buffer.byteLength(content) > 256 * 1024) throw statusError('Plans cannot exceed 256 KB.', 413);
    const context = this.registry.active(); const record = await this.getByPath(path, context.id);
    const current = await this.read(path, context.id);
    if (expectedHash && current.hash !== expectedHash) throw statusError('The plan changed after it was opened. Reload it before saving.', 409);
    content = normalize(content); await this.writePlan(path, content); const nextHash = digest(content); const updatedAt = new Date().toISOString();
    if (record) { record.hash = nextHash; record.updatedAt = updatedAt; await this.replaceRecord(record); }
    return { path, hash: nextHash, updatedAt };
  }

  async markExecuting(record: PlanRecord, hash: string) {
    record.status = 'executing'; record.hash = hash; record.updatedAt = new Date().toISOString(); await this.replaceRecord(record);
  }

  async markAwaitingReview(record: PlanRecord) {
    record.status = 'awaiting_review'; record.updatedAt = new Date().toISOString(); await this.replaceRecord(record);
  }

  async removeCompleted(id: string, path: string, workspaceId: string, releaseVersion: string) {
    assertPlanPath(path);
    const context = this.registry.get(workspaceId);
    const release = await safeWorkspacePath(context.releasesDir, releaseVersion, true);
    const releaseFile = await safeWorkspacePath(release, path, false);
    const draftFile = await safeWorkspacePath(context.draftDir, path, false);
    await rm(releaseFile, { force: true });
    await rm(draftFile, { force: true });
    const records = await this.records(workspaceId);
    await this.saveRecords(workspaceId, records.filter((record) => record.id !== id && record.path !== path));
  }

  private async writePlan(path: string, content: string) {
    if (!content.trim()) throw statusError('The planning agent returned an empty plan.', 500);
    if (Buffer.byteLength(content) > 256 * 1024) throw statusError('Plans cannot exceed 256 KB.', 413);
    const file = await safeWorkspacePath(this.registry.active().draftDir, path, false); await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`; await writeFile(temporary, normalize(content), 'utf8'); await rename(temporary, file);
  }

  private async replaceRecord(record: PlanRecord) {
    const records = await this.records(record.workspaceId); const index = records.findIndex((item) => item.id === record.id);
    if (index < 0) throw statusError('Plan metadata is missing.', 404); records[index] = record; await this.saveRecords(record.workspaceId, records);
  }

  private async records(workspaceId: string): Promise<PlanRecord[]> {
    const path = join(this.registry.get(workspaceId).stateDir, 'plans.json');
    return readFile(path, 'utf8').then((value) => JSON.parse(value)).catch(() => []);
  }

  private async saveRecords(workspaceId: string, records: PlanRecord[]) {
    const path = join(this.registry.get(workspaceId).stateDir, 'plans.json'); await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8'); await rename(temporary, path);
  }
}

function assertPlanPath(path: string) {
  if (!/^plans\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/i.test(String(path)) || String(path).split('/').includes('..')) throw statusError('Plan paths must be Markdown files beneath plans/.', 400);
}
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'implementation-plan'; }
function normalize(value: string) { return value.endsWith('\n') ? value : `${value}\n`; }
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }
