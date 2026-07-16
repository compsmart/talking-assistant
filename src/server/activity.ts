import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WebSocket } from 'ws';
import type {
  ActivityEvent, ActivityKind, ActivityPage, ActivityRecord, ActivitySeverity, ActivitySource, ActivityStatus, AgentRunSnapshot, MediaJobSnapshot,
} from '../shared/protocol.js';
type ActivitySnapshot = AgentRunSnapshot | MediaJobSnapshot;
import { config } from './config.js';

type JournalLine = { type: 'record'; record: ActivityRecord } | { type: 'resolve'; id: string; at: string; resolution: string };

export class ActivityHub {
  private sequences = new Map<string, number>();
  private history = new Map<string, ActivityEvent[]>();
  private sockets = new Map<string, Set<WebSocket>>();
  private feedSockets = new Set<WebSocket>();
  private eventListeners = new Set<(event: ActivityEvent) => void>();
  private snapshots = new Map<string, ActivitySnapshot>();
  private records = new Map<string, ActivityRecord>();
  private pendingWrites = new Map<string, string[]>();
  private pendingJournal: string[] = [];
  private flushTimer?: NodeJS.Timeout;
  private writeChain: Promise<void> = Promise.resolve();

  async initialize() {
    await mkdir(join(config.stateDir, 'tasks'), { recursive: true });
    await this.loadJournal();
    for (const record of [...this.records.values()]) if (record.status === 'running') this.finish(record.id, 'failed', 'Operation was interrupted by a Cowork server restart.', { severity: 'error' });
    await this.loadLegacyRecords();
  }

  async emit(taskId: string, kind: ActivityKind, phase: string, message: string, data?: unknown) {
    const event: ActivityEvent = { taskId, seq: (this.sequences.get(taskId) || 0) + 1, at: new Date().toISOString(), kind, phase, message, data };
    this.sequences.set(taskId, event.seq);
    for (const listener of this.eventListeners) listener(event);
    const events = this.history.get(taskId) || []; events.push(event); this.history.set(taskId, events);
    this.broadcast(taskId, { type: 'event', event });
    const pending = this.pendingWrites.get(taskId) || []; pending.push(`${JSON.stringify(event)}\n`); this.pendingWrites.set(taskId, pending);
    const record = this.records.get(taskId);
    if (record) {
      record.updatedAt = event.at;
      if (kind === 'error') { record.severity = 'error'; record.status = 'failed'; record.message = message; }
      this.broadcastFeed({ type: 'activity', record });
    }
    this.scheduleFlush();
    return event;
  }

  register(input: Omit<ActivityRecord, 'startedAt' | 'updatedAt' | 'status' | 'severity' | 'message'> & { startedAt?: string; status?: ActivityStatus; severity?: ActivitySeverity; message?: string }) {
    const now = input.startedAt || new Date().toISOString();
    const existing = this.records.get(input.id);
    const record: ActivityRecord = existing ? { ...existing, ...input, updatedAt: now } : {
      ...input, startedAt: now, updatedAt: now, status: input.status || 'running', severity: input.severity || 'info', message: input.message || input.title,
    };
    this.records.set(record.id, record); this.appendJournal({ type: 'record', record }); this.broadcastFeed({ type: 'activity', record });
    return record;
  }

  finish(id: string, status: ActivityStatus, message: string, details: Partial<Pick<ActivityRecord, 'severity' | 'httpStatus' | 'paths' | 'requestId'>> = {}) {
    const current = this.records.get(id);
    if (!current) return undefined;
    const updatedAt = new Date().toISOString();
    const record: ActivityRecord = { ...current, ...details, status, message, updatedAt, durationMs: Date.parse(updatedAt) - Date.parse(current.startedAt) };
    if (status === 'failed' && !details.severity) record.severity = 'error';
    this.records.set(id, record); this.appendJournal({ type: 'record', record }); this.broadcastFeed({ type: 'activity', record });
    return record;
  }

  recordFailure(input: { id: string; workspaceId?: string; source: ActivitySource; title: string; message: string; requestId?: string; httpStatus?: number; paths?: string[] }) {
    const record = this.register({ ...input, severity: 'error', status: 'failed' });
    void this.emit(record.id, 'error', input.source, input.message, { requestId: input.requestId, httpStatus: input.httpStatus, paths: input.paths });
    return this.finish(record.id, 'failed', input.message, { severity: 'error', requestId: input.requestId, httpStatus: input.httpStatus, paths: input.paths });
  }

  update(task: ActivitySnapshot) {
    this.snapshots.set(task.id, task);
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    const source = task.kind === 'planning' ? 'planning' : task.kind === 'media' ? 'media' : 'coding';
    const current = this.records.get(task.id);
    if (!current) this.register({ id: task.id, runId: task.id, workspaceId: task.workspaceId, source, title: task.kind === 'media' ? task.request.prompt : task.request.objective, message: `${task.kind} agent ${task.status}` });
    if (terminal) this.finish(task.id, task.status === 'completed' ? 'succeeded' : task.status === 'failed' ? 'failed' : 'cancelled', task.kind === 'media' ? `${task.request.kind} job ${task.status}` : task.result?.summary || `${task.kind} agent ${task.status}`);
    else if (current) { const record = { ...current, updatedAt: task.updatedAt, message: `${task.kind} agent ${task.status}` }; this.records.set(task.id, record); this.broadcastFeed({ type: 'activity', record }); }
    this.broadcast(task.id, { type: 'snapshot', task });
  }

  list(options: { workspaceId?: string; all?: boolean; severity?: string; source?: string; query?: string; cursor?: string; limit?: number } = {}): ActivityPage {
    const query = (options.query || '').trim().toLocaleLowerCase();
    const scoped = [...this.records.values()].filter((item) => options.all || !options.workspaceId || item.workspaceId === options.workspaceId);
    const filtered = scoped.filter((item) => {
      if (options.severity && item.severity !== options.severity) return false;
      if (options.source && item.source !== options.source) return false;
      return !query || `${item.title}\n${item.message}\n${item.paths?.join('\n') || ''}`.toLocaleLowerCase().includes(query);
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const offset = Math.max(0, Number(options.cursor) || 0); const limit = Math.min(200, Math.max(1, options.limit || 60));
    const items = filtered.slice(offset, offset + limit);
    return { items, ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}), unresolved: scoped.filter((item) => item.severity === 'error' && !item.resolvedAt).length };
  }

  async events(id: string) {
    if (this.history.has(id)) return this.history.get(id)!;
    const path = join(config.stateDir, 'tasks', `${safeId(id)}.jsonl`);
    const events = await readFile(path, 'utf8').then((text) => text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ActivityEvent)).catch(() => []);
    if (events.length) { this.history.set(id, events); this.sequences.set(id, events.at(-1)?.seq || 0); }
    return events;
  }

  resolve(id: string, resolution = 'Marked resolved') {
    const current = this.records.get(id); if (!current) return undefined;
    const at = new Date().toISOString(); const record = { ...current, resolvedAt: at, resolution: resolution.slice(0, 500) };
    this.records.set(id, record); this.appendJournal({ type: 'resolve', id, at, resolution: record.resolution! }); this.broadcastFeed({ type: 'activity', record }); return record;
  }

  async clearWorkspace(workspaceId: string, persist = true) {
    if (!workspaceId) throw new Error('A workspace ID is required to clear activity.');
    // Drain all scheduled appends before rewriting the journal, otherwise a
    // pending batch could recreate records immediately after they are cleared.
    if (persist) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
      this.flush(); await this.writeChain;
    }
    const ids = [...this.records.values()].filter((record) => record.workspaceId === workspaceId).map((record) => record.id);
    for (const id of ids) { this.records.delete(id); this.snapshots.delete(id); this.history.delete(id); this.sequences.delete(id); this.pendingWrites.delete(id); }
    if (persist) {
      await mkdir(join(config.stateDir, 'tasks'), { recursive: true });
      await Promise.all(ids.map((id) => rm(join(config.stateDir, 'tasks', `${safeId(id)}.jsonl`), { force: true })));
      const journal = [...this.records.values()].map((record) => `${JSON.stringify({ type: 'record', record } satisfies JournalLine)}\n`).join('');
      await writeFile(join(config.stateDir, 'activity.jsonl'), journal, 'utf8');
    }
    this.broadcastFeed({ type: 'activity-clear', workspaceId });
    return { cleared: ids.length, workspaceId };
  }

  getTask(id: string) { return this.snapshots.get(id); }
  attach(taskId: string, socket: WebSocket) {
    const set = this.sockets.get(taskId) || new Set<WebSocket>(); set.add(socket); this.sockets.set(taskId, set);
    void this.events(taskId).then((events) => { for (const event of events) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'event', event })); });
    const task = this.snapshots.get(taskId); if (task) socket.send(JSON.stringify({ type: 'snapshot', task }));
    socket.on('close', () => set.delete(socket));
  }
  attachFeed(socket: WebSocket) { this.feedSockets.add(socket); socket.on('close', () => this.feedSockets.delete(socket)); }
  subscribeEvents(listener: (event: ActivityEvent) => void) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  private broadcast(taskId: string, payload: unknown) { const message = JSON.stringify(payload); for (const socket of this.sockets.get(taskId) || []) if (socket.readyState === socket.OPEN) socket.send(message); }
  private broadcastFeed(payload: unknown) { const message = JSON.stringify(payload); for (const socket of this.feedSockets) if (socket.readyState === socket.OPEN) socket.send(message); }
  private appendJournal(line: JournalLine) { this.pendingJournal.push(`${JSON.stringify(line)}\n`); this.scheduleFlush(); }
  private scheduleFlush() { if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 15); }
  private flush() {
    this.flushTimer = undefined; const batches = this.pendingWrites; this.pendingWrites = new Map(); const journal = this.pendingJournal; this.pendingJournal = [];
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(join(config.stateDir, 'tasks'), { recursive: true });
      await Promise.all([...batches].map(([taskId, lines]) => appendFile(join(config.stateDir, 'tasks', `${safeId(taskId)}.jsonl`), lines.join('')).catch(() => undefined)));
      if (journal.length) await appendFile(join(config.stateDir, 'activity.jsonl'), journal.join('')).catch(() => undefined);
    });
  }
  private async loadJournal() {
    const lines = await readFile(join(config.stateDir, 'activity.jsonl'), 'utf8').then((text) => text.split(/\r?\n/).filter(Boolean)).catch(() => []);
    for (const text of lines) try {
      const line = JSON.parse(text) as JournalLine;
      if (line.type === 'record') this.records.set(line.record.id, line.record);
      else { const current = this.records.get(line.id); if (current) this.records.set(line.id, { ...current, resolvedAt: line.at, resolution: line.resolution }); }
    } catch { /* retain readable journal entries even if one line is corrupt */ }
  }
  private async loadLegacyRecords() {
    const directory = join(config.stateDir, 'tasks'); const files = await readdir(directory).catch(() => []);
    for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
      const id = basename(file, '.jsonl'); if (this.records.has(id)) continue;
      const path = join(directory, file); const [info, events] = await Promise.all([stat(path).catch(() => undefined), this.events(id)]); if (!info || !events.length) continue;
      const first = events[0]; const last = events.at(-1)!; const completed = last.kind === 'complete'; const failed = events.findLast((event) => event.kind === 'error') || (!completed ? events.findLast((event) => event.kind === 'stderr') : undefined);
      this.records.set(id, { id, source: 'legacy', severity: failed ? 'error' : 'info', status: failed ? 'failed' : completed ? 'succeeded' : 'cancelled', title: id.startsWith('manual-') ? 'Legacy workspace operation' : 'Legacy agent run', message: failed?.message || last.message, startedAt: first.at, updatedAt: last.at, durationMs: Date.parse(last.at) - Date.parse(first.at), legacy: true });
    }
  }
}

function safeId(value: string) { if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('Invalid activity ID.'); return value; }
