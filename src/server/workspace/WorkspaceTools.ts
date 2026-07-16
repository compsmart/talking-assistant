import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
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
  constructor(private readonly workspace: WorkspaceManager, private readonly activity: ActivityHub, private readonly registry: WorkspaceRegistry, private readonly assets?: AssetService, private readonly images?: ImageProcessingService, private readonly mediaJobs?: MediaJobManager, private readonly executionRoot?: string) {}

  scoped(root: string) { return new WorkspaceTools(this.workspace, this.activity, this.registry, this.assets, this.images, this.mediaJobs, root); }
  private root() { return this.executionRoot || this.registry.active().draftDir; }

  async execute(taskId: string, name: string, args: any, cancelled: () => boolean = () => false, policy?: WorkspaceSettings['codingAgent'], referenceWorkspaceIds: string[] = [], phase = 'coding', redactions: readonly string[] = []): Promise<any> {
    if (policy?.dependencies === 'existing-only' && name === 'install_dependencies') throw new Error('Installing or changing dependencies is disabled in Workspace Settings.');
    if (policy?.mediaGeneration === false && ['generate_image', 'generate_animation', 'delegate_media_task'].includes(name)) throw new Error('Media generation is disabled in Workspace Settings.');
    if (policy && policy.validation !== 'standard' && name === 'inspect_preview') throw new Error(`${policy.validation} validation mode skips coding-agent preview verification.`);
    if (policy && policy.validation !== 'standard' && name === 'run_command' && /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)(?:\s|$)/i.test(String(args.command || ''))) throw new Error(`${policy.validation} validation mode skips coding-agent verification commands.`);
    await this.activity.emit(taskId, 'tool_call', phase, `${name} ${summarize(redactValue(args, redactions))}`, { name, args: redactValue(args, redactions) });
    let result: any;
    switch (name) {
      case 'locate_code': result = await this.locateCode(args.queries); break;
      case 'read_files': result = await this.readFiles(args.files); break;
      case 'apply_edits': result = await this.applyEdits(args.edits); break;
      case 'list_files': result = await this.listFiles(this.root(), args.path || '.'); break;
      case 'read_file': result = await this.readFile(this.root(), args.path, args.startLine, args.endLine); break;
      case 'search_files': result = await this.searchFiles(this.root(), args.query, args.path || '.'); break;
      case 'list_reference_files': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path || '.'); result = await this.listFiles(source.draftDir, args.path || '.'); break; }
      case 'read_reference_file': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path); result = await this.readFile(source.draftDir, args.path, args.startLine, args.endLine); break; }
      case 'search_reference_files': { const source = this.reference(args.workspace, referenceWorkspaceIds); this.assertReferencePath(args.path || '.'); result = await this.searchFiles(source.draftDir, args.query, args.path || '.'); break; }
      case 'copy_reference_file': { const source = this.reference(args.workspace, referenceWorkspaceIds); result = await this.copyReference(source, args.sourcePath, args.destinationPath); break; }
      case 'write_file': result = await this.writeFile(args.path, args.content); break;
      case 'replace_in_file': result = await this.replaceInFile(args.path, args.search, args.replacement, args.all); break;
      case 'run_command': result = await this.runCommand(taskId, args.command, false); break;
      case 'project.run_tests': result = await this.runPackageScript(taskId, 'test'); break;
      case 'project.run_build': result = await this.runPackageScript(taskId, 'build'); break;
      case 'project.run_typecheck': result = await this.runPackageScript(taskId, 'typecheck'); break;
      case 'project.run_lint': result = await this.runPackageScript(taskId, 'lint'); break;
      case 'package.lookup': result = await this.packageLookup(args.name, cancelled); break;
      case 'workspace.http_request': result = await this.previewRequest(args, cancelled); break;
      case 'calculate': result = { value: calculate(String(args.expression || '')) }; break;
      case 'datetime': result = dateTime(args); break;
      case 'regex.test': result = await regexTest(args); break;
      case 'content.hash': result = hashContent(args); break;
      case 'image.inspect': result = await this.inspectImage(args.path); break;
      case 'install_dependencies': result = await this.runCommand(taskId, args.command || 'npm install --no-audit --no-fund', true); break;
      case 'inspect_preview': result = await this.workspace.inspectDraft(taskId, 'mixed', this.root()); break;
      case 'generate_image': if (!this.assets) throw new Error('Media generation is unavailable.'); result = await this.assets.generateImage(taskId, args, cancelled); break;
      case 'generate_animation': if (!this.assets) throw new Error('Media generation is unavailable.'); result = await this.assets.generateAnimation(taskId, args, cancelled); break;
      case 'delegate_media_task': if (!this.mediaJobs) throw new Error('Media Agent is unavailable.'); result = await this.mediaJobs.create({ ...args, parentRunId: taskId }, this.executionRoot); break;
      case 'remove_image_background': if (!this.images) throw new Error('Image processing is unavailable.'); result = await this.images.removeBackground(args, this.root()); break;
      case 'extract_image_regions': if (!this.images) throw new Error('Image processing is unavailable.'); result = await this.images.extractRegions(args, this.root()); break;
      case 'run_node_script': result = await this.runNodeScript(taskId, args, phase); break;
      default: throw new Error(`Unknown workspace tool: ${name}`);
    }
    await this.activity.emit(taskId, 'tool_result', phase, `${name}: ${formatResult(redactValue(result, redactions))}`, { name });
    return result;
  }

  async manifest(): Promise<Map<string, string>> {
    const root = this.root();
    const map = new Map<string, string>();
    for (const path of await walk(root)) {
      const data = await readFile(path); map.set(relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(data).digest('hex'));
    }
    return map;
  }

  async dependencyFingerprint() {
    const source = await readFile(resolve(this.root(), 'package.json'), 'utf8').catch(() => '{}');
    const value = JSON.parse(source); const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map((field) => [field, value[field] || {}])))).digest('hex');
  }

  private async inspectImage(pathValue: unknown) {
    const path = String(pathValue || ''); const source = await safePath(this.root(), path, true);
    const metadata = await sharp(source).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new Error('image.inspect supports PNG, JPEG, and WebP files.');
    const preview = await sharp(source).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
    return { path, width: metadata.width, height: metadata.height, format: metadata.format, channels: metadata.channels, hasAlpha: metadata.hasAlpha, screenshotBase64: preview.toString('base64') };
  }

  private async runPackageScript(taskId: string, script: string) {
    const source = await readFile(resolve(this.root(), 'package.json'), 'utf8').catch(() => { throw new Error('package.json is unavailable.'); });
    const manifest = JSON.parse(source);
    if (!manifest.scripts || typeof manifest.scripts[script] !== 'string') throw new Error(`The package script ${script} is not declared.`);
    return this.runCommand(taskId, `npm run ${script}`, false);
  }

  private async packageLookup(nameValue: unknown, cancelled: () => boolean) {
    const name = String(nameValue || '').trim();
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) || name.length > 214) throw new Error('Invalid npm package name.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      if (cancelled()) throw new Error('Package lookup cancelled.');
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
      const body: any = await response.json();
      return { name: body.name, version: body.version, description: String(body.description || '').slice(0, 2_000), license: body.license, homepage: body.homepage, repository: body.repository, dependencies: body.dependencies || {}, peerDependencies: body.peerDependencies || {} };
    } finally { clearTimeout(timeout); }
  }

  private async previewRequest(args: any, cancelled: () => boolean) {
    const base = new URL(this.workspace.previewUrl); const target = new URL(String(args.path || '/'), base);
    if (target.origin !== base.origin) throw new Error('Workspace HTTP requests may address only the active preview.');
    const method = String(args.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported preview request method.');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      if (cancelled()) throw new Error('Workspace HTTP request cancelled.');
      const response = await fetch(target, { method, body: ['GET', 'HEAD'].includes(method) ? undefined : String(args.body || ''), redirect: 'manual', signal: controller.signal });
      const body = (await response.text()).slice(0, 256 * 1024);
      return { status: response.status, headers: Object.fromEntries([...response.headers].slice(0, 100)), body, truncated: body.length === 256 * 1024 };
    } finally { clearTimeout(timeout); }
  }

  changed(before: Map<string, string>, after: Map<string, string>): FileReference[] {
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((path) => before.get(path) !== after.get(path)).sort().map((path) => ({ path, action: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified' }));
  }

  async findSourceMatches(visibleText: string) {
    const query = visibleText.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!query) return [];
    return (await this.searchFiles(this.root(), query, '.')).slice(0, 12);
  }

  async buildTaskContext(input: { objective: string; selectedElement?: any; selectedFiles?: string[] }) {
    const root = this.root();
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
    const root = this.root(); const files = (await walk(root)).filter((file) => isTextPath(relative(root, file))); const matches: any[] = [];
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
    return Promise.all(files.map((item: any) => this.readFile(this.root(), item.path, item.startLine, item.endLine)));
  }

  private async applyEdits(edits: unknown) {
    if (!Array.isArray(edits) || !edits.length) throw new Error('apply_edits requires at least one edit');
    if (edits.length > 20) throw new Error('apply_edits accepts at most 20 edits');
    type State = { file: string; existed: boolean; original: string; output: string };
    const root = this.root(); const states = new Map<string, State>();
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
    const file = await safePath(this.root(), path, false); await mkdir(dirname(file), { recursive: true }); await writeFile(file, String(content), 'utf8');
    return { ok: true, path, bytes: Buffer.byteLength(String(content)) };
  }

  private async replaceInFile(path: string, search: string, replacement: string, all = false) {
    if (!search) throw new Error('replace_in_file requires non-empty search text');
    const file = await safePath(this.root(), path, true); const source = await readFile(file, 'utf8');
    const occurrences = source.split(search).length - 1; if (!occurrences) throw new Error(`Text was not found in ${path}`);
    const output = all ? source.split(search).join(replacement) : source.replace(search, replacement); await writeFile(file, output, 'utf8');
    return { ok: true, path, replacements: all ? occurrences : 1 };
  }

  private async runCommand(taskId: string, command: string, network: boolean) {
    if (!command?.trim()) throw new Error('run_command requires a command');
    const result = await this.workspace.runInSandbox(command, network, 180_000, this.root());
    if (result.stdout.trim()) await this.activity.emit(taskId, 'stdout', 'coding', result.stdout.trim());
    if (result.stderr.trim()) await this.activity.emit(taskId, 'stderr', 'coding', result.stderr.trim());
    return result;
  }

  private async runNodeScript(taskId: string, args: any, phase: string) {
    const script = String(args?.script || '').replaceAll('\\', '/');
    if (!/^scripts\/(?:[^/]+\/)*[^/]+\.(?:js|mjs|cjs)$/.test(script) || script.split('/').includes('..')) {
      throw new Error('Media scripts must be workspace-relative .js, .mjs, or .cjs files beneath scripts/.');
    }
    await safePath(this.root(), script, true);
    const values = Array.isArray(args?.args) ? args.args.map(String) : [];
    if (values.length > 100 || values.some((value: string) => value.length > 4096 || value.includes('\0'))) throw new Error('Media script arguments exceed the allowed limits.');
    const command = ['node', '--', script, ...values].map(shellArgument).join(' ');
    const readOnly = ['planning', 'research', 'review'].includes(phase);
    const result = await this.workspace.runInSandbox(command, false, 180_000, this.root(), readOnly, true);
    if (result.stdout.trim()) await this.activity.emit(taskId, 'stdout', phase, result.stdout.trim());
    if (result.stderr.trim()) await this.activity.emit(taskId, 'stderr', phase, result.stderr.trim());
    if (result.code) throw new Error(`Node script failed with exit code ${result.code}: ${result.stderr || result.stdout}`);
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
    const destination = await safePath(this.root(), destinationPath, false); await mkdir(dirname(destination), { recursive: true }); await copyFile(sourceFile, destination);
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
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  return value;
}
function unique<T>(values: T[]) { return [...new Set(values)]; }
function isTextPath(path: string) { const normalized = path.toLowerCase(); const dot = normalized.lastIndexOf('.'); return dot < 0 || TEXT_EXTENSIONS.has(normalized.slice(dot)); }
function objectiveKeywords(value: string) { return unique(String(value).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((word) => !['change', 'make', 'with', 'from', 'that', 'this', 'please', 'should'].includes(word)).slice(0, 6); }
function truncateUtf8(value: string, bytes: number) { if (Buffer.byteLength(value) <= bytes) return value; let end = Math.min(value.length, bytes); while (end > 0 && Buffer.byteLength(value.slice(0, end)) > bytes) end -= Math.max(1, Math.ceil((Buffer.byteLength(value.slice(0, end)) - bytes) / 2)); return value.slice(0, end); }
function shellArgument(value: string) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

function calculate(expression: string) {
  if (!expression || expression.length > 4_096 || !/^[\d\s.eE+*/%^()-]+$/.test(expression)) throw new Error('Calculator expression contains unsupported input.');
  let index = 0;
  const skip = () => { while (/\s/.test(expression[index] || '')) index++; };
  const primary = (): number => { skip(); if (expression[index] === '(') { index++; const value = add(); skip(); if (expression[index++] !== ')') throw new Error('Unbalanced calculator parentheses.'); return value; } const match = expression.slice(index).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i); if (!match) throw new Error('Expected a number.'); index += match[0].length; return Number(match[0]); };
  const unary = (): number => { skip(); if (expression[index] === '+') { index++; return unary(); } if (expression[index] === '-') { index++; return -unary(); } return primary(); };
  const power = (): number => { let value = unary(); skip(); if (expression[index] === '^') { index++; value **= power(); } return value; };
  const multiply = (): number => { let value = power(); for (;;) { skip(); const operation = expression[index]; if (!['*', '/', '%'].includes(operation)) return value; index++; const right = power(); value = operation === '*' ? value * right : operation === '/' ? value / right : value % right; } };
  const add = (): number => { let value = multiply(); for (;;) { skip(); const operation = expression[index]; if (!['+', '-'].includes(operation)) return value; index++; const right = multiply(); value = operation === '+' ? value + right : value - right; } };
  const value = add(); skip(); if (index !== expression.length || !Number.isFinite(value)) throw new Error('Calculator result is invalid or non-finite.'); return value;
}

function dateTime(args: any) {
  const value = args.value ? new Date(String(args.value)) : new Date();
  if (Number.isNaN(value.getTime())) throw new Error('Invalid date/time value.');
  const adjusted = new Date(value.getTime() + Number(args.addMilliseconds || 0));
  const timeZone = String(args.timeZone || 'UTC');
  return { iso: adjusted.toISOString(), unixMilliseconds: adjusted.getTime(), formatted: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone }).format(adjusted), timeZone };
}

function hashContent(args: any) {
  const content = String(args.content || ''); if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Hash input exceeds 1 MiB.');
  const algorithm = args.algorithm === 'sha512' ? 'sha512' : 'sha256'; return { algorithm, digest: createHash(algorithm).update(content).digest('hex'), bytes: Buffer.byteLength(content) };
}

function regexTest(args: any): Promise<any> {
  const pattern = String(args.pattern || ''); const input = String(args.input || ''); const flags = String(args.flags || '');
  if (pattern.length > 2_000 || input.length > 200_000 || !/^[dgimsuvy]*$/.test(flags)) throw new Error('Regular expression input exceeds its bounds or uses invalid flags.');
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); try { const regex = new RegExp(workerData.pattern, workerData.flags); const match = regex.exec(workerData.input); parentPort.postMessage({ matched: !!match, match: match ? match[0].slice(0, 10000) : undefined, index: match?.index, groups: match?.groups }); } catch (error) { parentPort.postMessage({ error: error.message }); }`, { eval: true, workerData: { pattern, input, flags } });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('Regular expression timed out.')); }, 1_000);
    worker.once('message', (value) => { clearTimeout(timeout); void worker.terminate(); value.error ? reject(new Error(value.error)) : resolvePromise(value); });
    worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}
