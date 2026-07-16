import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { ActivityHub } from '../activity.js';
import type { WorkspaceManager } from './WorkspaceManager.js';
import type { FileReference, WorkspaceSettings } from '../../shared/protocol.js';
import type { AssetService } from './AssetService.js';
import type { ImageProcessingService } from './ImageProcessingService.js';
import type { WorkspaceContext, WorkspaceRegistry } from './WorkspaceRegistry.js';
import type { MediaJobManager } from '../media/MediaJobManager.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'plans']);
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.htm', '.js', '.jsx', '.json', '.md', '.mjs', '.cjs', '.scss', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml']);
const CONTEXT_LIMIT = 24 * 1024;

export class WorkspaceTools {
  constructor(private readonly workspace: WorkspaceManager, private readonly activity: ActivityHub, private readonly registry: WorkspaceRegistry, private readonly assets?: AssetService, private readonly images?: ImageProcessingService, private readonly mediaJobs?: MediaJobManager) {}

  async execute(taskId: string, name: string, args: any, cancelled: () => boolean = () => false, policy?: WorkspaceSettings['codingAgent'], referenceWorkspaceIds: string[] = [], phase = 'coding'): Promise<any> {
    if (policy?.dependencies === 'existing-only' && name === 'install_dependencies') throw new Error('Installing or changing dependencies is disabled in Workspace Settings.');
    if (policy?.mediaGeneration === false && ['generate_image', 'generate_animation', 'delegate_media_task'].includes(name)) throw new Error('Media generation is disabled in Workspace Settings.');
    if (policy && policy.validation !== 'standard' && name === 'inspect_preview') throw new Error(`${policy.validation} validation mode skips coding-agent preview verification.`);
    if (policy && policy.validation !== 'standard' && name === 'run_command' && /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)(?:\s|$)/i.test(String(args.command || ''))) throw new Error(`${policy.validation} validation mode skips coding-agent verification commands.`);
    await this.activity.emit(taskId, 'tool_call', phase, `${name} ${summarize(args)}`, { name, args });
    let result: any;
    switch (name) {
      case 'locate_code': result = await this.locateCode(args.queries); break;
      case 'read_files': result = await this.readFiles(args.files); break;
      case 'apply_edits': result = await this.applyEdits(args.edits); break;
      case 'list_files': result = await this.listFiles(this.registry.active().draftDir, args.path || '.'); break;
      case 'read_file': result = await this.readFile(this.registry.active().draftDir, args.path, args.startLine, args.endLine); break;
      case 'search_files': result = await this.searchFiles(this.registry.active().draftDir, args.query, args.path || '.'); break;
      case 'list_reference_files': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path || '.'); result = await this.listFiles(source.draftDir, args.path || '.'); break; }
      case 'read_reference_file': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path); result = await this.readFile(source.draftDir, args.path, args.startLine, args.endLine); break; }
      case 'search_reference_files': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path || '.'); result = await this.searchFiles(source.draftDir, args.query, args.path || '.'); break; }
      case 'copy_reference_file': { const source = this.reference(args.workspace, referenceWorkspaceIds); result = await this.copyReference(source, args.sourcePath, args.destinationPath); break; }
      case 'write_file': result = await this.writeFile(args.path, args.content); break;
      case 'replace_in_file': result = await this.replaceInFile(args.path, args.search, args.replacement, args.all); break;
      case 'run_command': result = await this.runCommand(taskId, args.command, false); break;
      case 'install_dependencies': result = await this.runCommand(taskId, args.command || 'npm install --no-audit --no-fund', true); break;
      case 'inspect_preview': result = await this.workspace.inspectDraft(taskId); break;
      case 'generate_image': if (!this.assets) throw new Error('Media generation is unavailable.'); result = await this.assets.generateImage(taskId, args, cancelled); break;
      case 'generate_animation': if (!this.assets) throw new Error('Media generation is unavailable.'); result = await this.assets.generateAnimation(taskId, args, cancelled); break;
      case 'delegate_media_task': if (!this.mediaJobs) throw new Error('Media Agent is unavailable.'); result = await this.mediaJobs.create({ ...args, parentRunId: taskId }); break;
      case 'remove_image_background': if (!this.images) throw new Error('Image processing is unavailable.'); result = await this.images.removeBackground(args); break;
      case 'extract_image_regions': if (!this.images) throw new Error('Image processing is unavailable.'); result = await this.images.extractRegions(args); break;
      default: throw new Error(`Unknown workspace tool: ${name}`);
    }
    await this.activity.emit(taskId, 'tool_result', phase, `${name}: ${formatResult(result)}`, { name });
    return result;
  }

  async manifest(): Promise<Map<string, string>> {
    const root = this.registry.active().draftDir;
    const map = new Map<string, string>();
    for (const path of await walk(root)) {
      const data = await readFile(path); map.set(relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(data).digest('hex'));
    }
    return map;
  }

  async dependencyFingerprint() {
    const source = await readFile(resolve(this.registry.active().draftDir, 'package.json'), 'utf8').catch(() => '{}');
    const value = JSON.parse(source); const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map((field) => [field, value[field] || {}])))).digest('hex');
  }

  changed(before: Map<string, string>, after: Map<string, string>): FileReference[] {
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((path) => before.get(path) !== after.get(path)).sort().map((path) => ({ path, action: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified' }));
  }

  async findSourceMatches(visibleText: string) {
    const query = visibleText.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!query) return [];
    return (await this.searchFiles(this.registry.active().draftDir, query, '.')).slice(0, 12);
  }

  async buildTaskContext(input: { objective: string; selectedElement?: any; selectedFiles?: string[] }) {
    const root = this.registry.active().draftDir;
    const paths = (await walk(root, 8)).map((file) => relative(root, file).replaceAll('\\', '/')).filter(isTextPath).slice(0, 1200);
    const packageJson = await readFile(resolve(root, 'package.json'), 'utf8').then((text) => JSON.parse(text)).catch(() => undefined);
    const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : undefined;
    const guidance = await readFile(resolve(root, 'AGENTS.md'), 'utf8').then((text) => text.slice(0, 12 * 1024)).catch(() => '');
    const selection = input.selectedElement;
    const rankedQueries = unique([
      selection?.attributes?.['data-cowork-id'], selection?.identifier, selection?.selector?.match(/#[A-Za-z][\w-]*/)?.[0],
      ...(selection?.attributes ? Object.entries(selection.attributes).filter(([key]) => key === 'id' || key === 'class').flatMap(([, value]) => String(value).split(/\s+/)) : []),
      selection?.layerId, selection?.canvasId, selection?.text && `"${String(selection.text).trim()}"`, ...objectiveKeywords(input.objective),
    ]).filter(Boolean).slice(0, 8) as string[];
    const located = rankedQueries.length ? await this.locateCode(rankedQueries, 12) : { matches: [] as any[] };
    const selectedReads = (input.selectedFiles || []).filter(isTextPath).length
      ? await this.readFiles((input.selectedFiles || []).filter(isTextPath).slice(0, 8).map((path) => ({ path, startLine: 1, endLine: 160 }))).catch(() => []) : [];
    const sections = [
      scripts ? `Package scripts:\n${JSON.stringify(scripts, null, 2)}` : '',
      `Source file map (${paths.length}${paths.length === 1200 ? '+' : ''} files):\n${paths.join('\n')}`,
      guidance ? `Root AGENTS.md guidance:\n${guidance}` : '',
      selectedReads.length ? `Selected file excerpts:\n${selectedReads.map((item: any) => `--- ${item.path}\n${item.content}`).join('\n')}` : '',
      located.matches.length ? `Ranked source matches:\n${located.matches.map((item: any) => `--- ${item.path}:${item.line} [${item.query}]\n${item.context}`).join('\n')}` : '',
    ].filter(Boolean);
    const complete = sections.join('\n\n'); const text = truncateUtf8(complete, CONTEXT_LIMIT);
    return { text, bytes: Buffer.byteLength(text), truncated: Buffer.byteLength(complete) > CONTEXT_LIMIT, fileCount: paths.length, matchCount: located.matches.length };
  }

  private async locateCode(queries: unknown, matchLimit = 200) {
    const values = unique((Array.isArray(queries) ? queries : []).map(String).map((item) => item.trim()).filter(Boolean)).slice(0, 8);
    if (!values.length) throw new Error('locate_code requires at least one query');
    const root = this.registry.active().draftDir; const files = (await walk(root)).filter((file) => isTextPath(relative(root, file))); const matches: any[] = [];
    for (const query of values) {
      const needle = query.replace(/^"|"$/g, '').toLowerCase();
      for (const file of files) {
        if (matches.length >= matchLimit) break;
        const path = relative(root, file).replaceAll('\\', '/');
        if (path.toLowerCase().includes(needle)) matches.push({ query, path, line: 1, kind: 'filename', context: path });
        const data = await readFile(file, 'utf8').catch(() => ''); const lines = data.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < matchLimit; index++) if (lines[index].toLowerCase().includes(needle)) {
          const start = Math.max(0, index - 4); const end = Math.min(lines.length, index + 5);
          matches.push({ query, path, line: index + 1, kind: 'text', context: lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join('\n') });
        }
      }
    }
    return { queries: values, matches, truncated: matches.length >= matchLimit, limit: matchLimit };
  }

  private async readFiles(files: unknown) {
    if (!Array.isArray(files) || !files.length) throw new Error('read_files requires at least one file range');
    if (files.length > 8) throw new Error('read_files accepts at most eight file ranges');
    return Promise.all(files.map((item: any) => this.readFile(this.registry.active().draftDir, item.path, item.startLine, item.endLine)));
  }

  private async applyEdits(edits: unknown) {
    if (!Array.isArray(edits) || !edits.length) throw new Error('apply_edits requires at least one edit');
    if (edits.length > 20) throw new Error('apply_edits accepts at most 20 edits');
    type State = { file: string; existed: boolean; original: string; output: string };
    const root = this.registry.active().draftDir; const states = new Map<string, State>();
    for (const edit of edits as any[]) {
      const path = String(edit.path || ''); const file = await safePath(root, path, false); let state = states.get(path);
      if (!state) {
        const original = await readFile(file, 'utf8').catch((error: any) => { if (error?.code === 'ENOENT') return ''; throw error; });
        const existed = await stat(file).then((info) => info.isFile()).catch(() => false); state = { file, existed, original, output: original }; states.set(path, state);
      }
      if (edit.mode === 'write') state.output = String(edit.content ?? '');
      else if (edit.mode === 'replace') {
        const search = String(edit.search ?? ''); if (!search) throw new Error(`Replacement in ${path} requires non-empty search text`);
        const count = state.output.split(search).length - 1; if (!count) throw new Error(`Text was not found in ${path}`);
        state.output = edit.all ? state.output.split(search).join(String(edit.replacement ?? '')) : state.output.replace(search, String(edit.replacement ?? ''));
      } else throw new Error(`Unsupported edit mode for ${path}`);
    }
    const committed: State[] = [];
    try {
      for (const state of states.values()) {
        await mkdir(dirname(state.file), { recursive: true }); const temporary = `${state.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        await writeFile(temporary, state.output, 'utf8'); await rename(temporary, state.file); committed.push(state);
      }
    } catch (error) {
      for (const state of committed.reverse()) { if (state.existed) await writeFile(state.file, state.original, 'utf8').catch(() => undefined); else await rm(state.file, { force: true }).catch(() => undefined); }
      throw error;
    }
    return { ok: true, files: [...states.keys()], edits: edits.length };
  }

  private async listFiles(draftRoot: string, path: string) {
    const root = await safePath(draftRoot, path, true);
    const entries = await walk(root, 4);
    return entries.map((item) => relative(draftRoot, item).replaceAll('\\', '/')).slice(0, 500);
  }

  private async readFile(draftRoot: string, path: string, startLine = 1, endLine = 400) {
    const file = await safePath(draftRoot, path, true);
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, Number(startLine)); const end = Math.min(lines.length, Math.max(start, Number(endLine)));
    return { path, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n') };
  }

  private async searchFiles(draftRoot: string, query: string, path: string) {
    if (!query) throw new Error('search_files requires a query');
    const root = await safePath(draftRoot, path, true); const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of await walk(root)) {
      const data = await readFile(file, 'utf8').catch(() => '');
      data.split(/\r?\n/).forEach((text, index) => { if (text.toLowerCase().includes(String(query).toLowerCase()) && matches.length < 200) matches.push({ path: relative(draftRoot, file).replaceAll('\\', '/'), line: index + 1, text: text.slice(0, 500) }); });
    }
    return matches;
  }

  private async writeFile(path: string, content: string) {
    const file = await safePath(this.registry.active().draftDir, path, false); await mkdir(dirname(file), { recursive: true }); await writeFile(file, String(content), 'utf8');
    return { ok: true, path, bytes: Buffer.byteLength(String(content)) };
  }

  private async replaceInFile(path: string, search: string, replacement: string, all = false) {
    if (!search) throw new Error('replace_in_file requires non-empty search text');
    const file = await safePath(this.registry.active().draftDir, path, true); const source = await readFile(file, 'utf8');
    const occurrences = source.split(search).length - 1; if (!occurrences) throw new Error(`Text was not found in ${path}`);
    const output = all ? source.split(search).join(replacement) : source.replace(search, replacement); await writeFile(file, output, 'utf8');
    return { ok: true, path, replacements: all ? occurrences : 1 };
  }

  private async runCommand(taskId: string, command: string, network: boolean) {
    if (!command?.trim()) throw new Error('run_command requires a command');
    const result = await this.workspace.runInSandbox(command, network, 180_000);
    if (result.stdout.trim()) await this.activity.emit(taskId, 'stdout', 'coding', result.stdout.trim());
    if (result.stderr.trim()) await this.activity.emit(taskId, 'stderr', 'coding', result.stderr.trim());
    return result;
  }

  private reference(value: unknown, allowed: string[]) {
    const requested = String(value || '').normalize('NFKC').toLocaleLowerCase();
    const context = allowed.map((id) => this.registry.get(id)).find((item) => item.id === value || item.name.normalize('NFKC').toLocaleLowerCase() === requested);
    if (!context) throw new Error('That workspace was not explicitly authorized by the current user request.');
    return context;
  }

  private async copyReference(source: WorkspaceContext, sourcePath: string, destinationPath: string) {
    this.assertReferencePath(sourcePath);
    const sourceFile = await safePath(source.draftDir, sourcePath, true); const info = await stat(sourceFile);
    if (!info.isFile()) throw new Error('Only regular workspace files can be copied.');
    const destination = await safePath(this.registry.active().draftDir, destinationPath, false); await mkdir(dirname(destination), { recursive: true }); await copyFile(sourceFile, destination);
    return { ok: true, workspace: source.name, sourcePath, destinationPath, bytes: info.size };
  }
  private assertReferencePath(path: string) { if (String(path || '').split(/[\\/]/).some((part) => IGNORED.has(part))) throw new Error('Ignored workspace directories cannot be accessed through a cross-workspace reference.'); }
}

async function safePath(rootInput: string, input: string, mustExist: boolean) {
  if (!input || input.includes('\0')) throw new Error('Invalid workspace path');
  const root = await realpath(rootInput); const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Path escapes the project workspace: ${input}`);
  let cursor = target;
  while (cursor !== root) {
    const info = await lstat(cursor).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in workspace paths: ${input}`);
    cursor = dirname(cursor);
  }
  if (mustExist) await lstat(target);
  return target;
}

async function walk(root: string, maxDepth = 20, depth = 0): Promise<string[]> {
  const info = await lstat(root); if (info.isFile()) return [root]; if (depth >= maxDepth) return [];
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name); if (entry.isDirectory()) output.push(...await walk(path, maxDepth, depth + 1)); else if (entry.isFile()) output.push(path);
  }
  return output;
}

function summarize(value: unknown) { const text = JSON.stringify(value); return text.length > 240 ? text.slice(0, 237) + '…' : text; }
function formatResult(value: unknown) { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > 600 ? text.slice(0, 597) + '…' : text; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function isTextPath(path: string) { const normalized = path.toLowerCase(); const dot = normalized.lastIndexOf('.'); return dot < 0 || TEXT_EXTENSIONS.has(normalized.slice(dot)); }
function objectiveKeywords(value: string) { return unique(String(value).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((word) => !['change', 'make', 'with', 'from', 'that', 'this', 'please', 'should'].includes(word)).slice(0, 6); }
function truncateUtf8(value: string, bytes: number) { if (Buffer.byteLength(value) <= bytes) return value; let end = Math.min(value.length, bytes); while (end > 0 && Buffer.byteLength(value.slice(0, end)) > bytes) end -= Math.max(1, Math.ceil((Buffer.byteLength(value.slice(0, end)) - bytes) / 2)); return value.slice(0, end); }
