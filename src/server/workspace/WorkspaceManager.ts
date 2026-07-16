import http from 'node:http';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import httpProxy from 'http-proxy';
import { chromium } from 'playwright-core';
import { config } from '../config.js';
import { run, type CommandResult } from '../process.js';
import type { ActivityHub } from '../activity.js';
import type { CheckResult, FileReference, WorkspaceMode, WorkspaceSelection } from '../../shared/protocol.js';
import { selectionBridge } from './selectionBridge.js';
import type { WorkspaceContext, WorkspaceRegistry } from './WorkspaceRegistry.js';

interface PreviewInspection { errors: string[]; screenshotBase64?: string; url?: string }
interface SelectionCapture { data: string; width: number; height: number }

export class WorkspaceManager {
  version = 'initial';
  previewUrl = `http://127.0.0.1:${config.previewPort}`;
  private proxy = httpProxy.createProxyServer({ ws: true });
  private gateway?: http.Server;
  private target = '';
  private activeContainer = '';
  private dockerAvailable = true;
  private snapshotCache?: { version: string; data: string };
  private inspectedScreenshots = new Map<string, string>();
  private context!: WorkspaceContext;

  constructor(private readonly activity: ActivityHub, private readonly registry: WorkspaceRegistry) {}
  get workspaceId() { return this.context?.id || this.registry.active().id; }

  async initialize() {
    this.context = this.registry.active();
    await Promise.all([mkdir(this.context.releasesDir, { recursive: true }), mkdir(this.context.failedDir, { recursive: true }), mkdir(this.context.stateDir, { recursive: true })]);
    const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5_000 });
    this.dockerAvailable = docker.code === 0;
    if (this.dockerAvailable) {
      const network = await run('docker', ['network', 'inspect', 'cowork-sandbox'], { timeout: 20_000 });
      if (network.code) {
        const created = await run('docker', ['network', 'create', '--driver', 'bridge', '--internal', 'cowork-sandbox'], { timeout: 20_000 });
        if (created.code) throw new Error(`Could not create the Docker sandbox network: ${created.stderr || created.stdout}`);
      }
      const built = await run('docker', ['build', '-f', config.sandboxDockerfile, '-t', config.sandboxImage, dirname(config.sandboxDockerfile)], { timeout: 300_000 });
      if (built.code) throw new Error(`Could not build the coding sandbox image: ${built.stderr || built.stdout}`);
    } else console.warn('Docker Desktop is not running. The last release will be served statically; coding tasks remain disabled until Docker is available and the server restarts.');
    this.version = await this.ensureInitialRelease(this.context);
    this.startGateway();
    if (this.dockerAvailable) await this.activateRelease(this.context, this.version, 'startup');
  }

  async activateWorkspace(context: WorkspaceContext, mode: WorkspaceMode) {
    const version = await this.ensureInitialRelease(context);
    if (this.dockerAvailable) await this.activateRelease(context, version, 'switch', true, mode);
    else { this.target = ''; this.activeContainer = ''; }
    this.context = context; this.version = version; this.snapshotCache = undefined;
    return { workspaceId: context.id, version, previewUrl: `${this.previewUrl}/?workspace=${context.id}&v=${version}` };
  }

  async prepareWorkspace(context: WorkspaceContext) { return this.ensureInitialRelease(context); }

  async runInSandbox(command: string, network = false, timeout = 120_000): Promise<CommandResult> {
    if (!this.dockerAvailable) return { code: 1, stdout: '', stderr: 'Docker Desktop is not running. Start Docker Desktop and restart the cowork server.' };
    return run('docker', sandboxRunArgs(this.context.draftDir, command, network), { timeout });
  }

  async validate(taskId: string, changedFiles: FileReference[] = [], mode: WorkspaceMode = 'mixed'): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const dependenciesChanged = changedFiles.some((file) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json)$/.test(file.path));
    if (dependenciesChanged || !await exists(join(this.context.draftDir, 'node_modules'))) {
      await this.activity.emit(taskId, 'validation', 'validate', 'Installing dependencies in the isolated workspace container');
      const install = await this.runInSandbox('npm install --no-audit --no-fund', true, 180_000);
      this.emitCommand(taskId, install); checks.push(resultCheck('dependencies', install));
      if (install.code) return checks;
    } else {
      checks.push({ name: 'dependencies', status: 'skipped', details: 'Package manifests were unchanged; reused the existing isolated install.' });
      await this.activity.emit(taskId, 'validation', 'validate', 'Skipping dependency install because package manifests are unchanged');
    }
    for (const [name, command] of [['tests', 'npm test --if-present'], ['build', 'npm run build --if-present']] as const) {
      await this.activity.emit(taskId, 'validation', 'validate', `Running ${name}`);
      const result = await this.runInSandbox(command, false, 180_000); this.emitCommand(taskId, result); checks.push(resultCheck(name, result));
      if (result.code) return checks;
    }
    const inspection = await this.inspectDraft(taskId, mode);
    checks.push({ name: 'browser smoke test', status: inspection.errors.length ? 'failed' : 'passed', details: inspection.errors.join('\n') || 'Workspace loaded without browser errors.' });
    return checks;
  }

  async captureCurrentCanvas(useCache = false): Promise<string | undefined> {
    if (useCache && this.snapshotCache?.version === this.version) return this.snapshotCache.data;
    if (!this.target) return undefined;
    const executablePath = await findChrome(); if (!executablePath) return undefined;
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(this.target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(150);
      const data = (await page.screenshot({ type: 'jpeg', quality: 72 })).toString('base64');
      if (useCache) this.snapshotCache = { version: this.version, data };
      return data;
    } finally { await browser.close(); }
  }

  async captureSelection(selection: WorkspaceSelection, viewport: { width?: number; height?: number } = {}, padding = 24): Promise<SelectionCapture> {
    if (!this.target) throw new Error('The persisted workspace preview is not ready.');
    if (!selection || !['dom', 'canvas'].includes(selection.kind)) throw new Error('A valid workspace selection is required.');
    const executablePath = await findChrome(); if (!executablePath) throw new Error('Chrome or Edge was not found.');
    const width = clamp(Number(viewport.width) || 1280, 320, 2560);
    const height = clamp(Number(viewport.height) || 800, 240, 1600);
    const margin = clamp(Number(padding) || 24, 0, 160);
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(this.target, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      let box: { x: number; y: number; width: number; height: number } | null;
      if (selection.kind === 'dom') {
        if (!selection.selector || selection.selector.length > 2000) throw new Error('A valid selected-element selector is required.');
        const locator = page.locator(selection.selector).first(); await locator.waitFor({ state: 'visible', timeout: 5_000 }); await locator.scrollIntoViewIfNeeded(); box = await locator.boundingBox();
        if (!box) throw new Error(`The selected element is no longer visible: ${selection.selector}`);
      } else {
        await page.waitForFunction(() => {
          const adapter = (window as any).coworkCanvas; return adapter && typeof adapter.getLayer === 'function';
        }, undefined, { timeout: 5_000 });
        box = await page.evaluate((layerId) => {
          const adapter = (window as any).coworkCanvas;
          const canvas = typeof adapter.getPrimaryCanvas === 'function' ? adapter.getPrimaryCanvas() : adapter.canvas;
          const layer = adapter.getLayer(layerId); const bounds = layer && (layer.bounds || layer.rect);
          if (!(canvas instanceof HTMLCanvasElement) || !bounds) return null;
          const rect = canvas.getBoundingClientRect(); return {
            x: rect.left + bounds.x * rect.width / canvas.width, y: rect.top + bounds.y * rect.height / canvas.height,
            width: bounds.width * rect.width / canvas.width, height: bounds.height * rect.height / canvas.height,
          };
        }, selection.layerId);
        if (!box) throw new Error(`The selected canvas layer is no longer available: ${selection.layerId}`);
      }
      const x = Math.max(0, box.x - margin); const y = Math.max(0, box.y - margin);
      const clipWidth = Math.max(1, Math.min(width - x, box.width + margin * 2));
      const clipHeight = Math.max(1, Math.min(height - y, box.height + margin * 2));
      const data = (await page.screenshot({ type: 'jpeg', quality: 78, clip: { x, y, width: clipWidth, height: clipHeight } })).toString('base64');
      return { data, width: Math.round(clipWidth), height: Math.round(clipHeight) };
    } finally { await browser.close(); }
  }

  async inspectDraft(taskId: string, mode: WorkspaceMode = 'mixed'): Promise<PreviewInspection> {
    if (!this.dockerAvailable) return { errors: ['Docker Desktop is not running.'] };
    const candidate = join(this.context.candidatesDir, taskId);
    await rm(candidate, { recursive: true, force: true }); await this.copyProject(this.context.draftDir, candidate);
    const name = `cowork-inspect-${safeName(this.context.id)}-${safeName(taskId)}`;
    const started = await this.buildAndRun(candidate, name, `cowork-preview:${safeName(taskId)}`);
    if (!started.target) { await rm(candidate, { recursive: true, force: true }); return { errors: [started.error || 'Could not start preview'] }; }
    try {
      const inspection = await this.browserInspect(started.target, mode);
      if (!inspection.errors.length && inspection.screenshotBase64) this.inspectedScreenshots.set(taskId, inspection.screenshotBase64);
      return inspection;
    } finally {
      await run('docker', ['rm', '-f', name], { timeout: 20_000 });
      await rm(candidate, { recursive: true, force: true });
    }
  }

  async publish(taskId: string, options: { browserGuard?: boolean; mode?: WorkspaceMode } = {}) {
    const version = `${Date.now()}-${taskId.slice(0, 6)}`; const release = join(this.context.releasesDir, version);
    await this.copyProject(this.context.draftDir, release);
    await this.activity.emit(taskId, 'status', 'publishing', `Building immutable preview ${version}`);
    await this.activateRelease(this.context, version, taskId, options.browserGuard !== false, options.mode); this.version = version;
    const inspected = this.inspectedScreenshots.get(taskId); this.snapshotCache = inspected ? { version, data: inspected } : undefined; this.inspectedScreenshots.delete(taskId);
    await writeFile(this.context.currentPath, JSON.stringify({ version })); await this.registry.touch(this.context.id);
    return { workspaceId: this.context.id, version, previewUrl: `${this.previewUrl}/?workspace=${this.context.id}&v=${version}` };
  }

  async listReleases(): Promise<import('../../shared/protocol.js').WorkspaceReleaseSummary[]> {
    const names = await readdir(this.context.releasesDir).catch(() => []); const current = await projectManifest(this.context.draftDir);
    const releases = await Promise.all(names.filter(safeVersion).map(async (version) => {
      const root = join(this.context.releasesDir, version); const info = await stat(root).catch(() => undefined); if (!info?.isDirectory()) return undefined;
      const target = await projectManifest(root); const paths = new Set([...current.keys(), ...target.keys()]);
      const changedFiles = [...paths].filter((path) => current.get(path) !== target.get(path)).sort().map((path): FileReference => ({ path, action: !current.has(path) ? 'added' : !target.has(path) ? 'deleted' : 'modified' }));
      return { version, active: version === this.version, createdAt: info.mtime.toISOString(), changedFiles };
    }));
    return releases.filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restartPreview(taskId: string, mode: WorkspaceMode) {
    await this.activity.emit(taskId, 'status', 'recovery', `Restarting preview ${this.version}`);
    await this.activateRelease(this.context, this.version, taskId, true, mode); this.snapshotCache = undefined;
    return { workspaceId: this.context.id, version: this.version, previewUrl: `${this.previewUrl}/?workspace=${this.context.id}&v=${this.version}` };
  }

  async restoreActiveDraft() {
    await this.restoreDraft(); this.snapshotCache = undefined;
    return { workspaceId: this.context.id, version: this.version, previewUrl: `${this.previewUrl}/?workspace=${this.context.id}&v=${this.version}` };
  }

  async rollbackToRelease(taskId: string, version: string, mode: WorkspaceMode) {
    if (!safeVersion(version)) throw Object.assign(new Error('Invalid workspace release.'), { status: 400 });
    const release = join(this.context.releasesDir, version); if (!await stat(release).then((item) => item.isDirectory()).catch(() => false)) throw Object.assign(new Error('Workspace release not found.'), { status: 404 });
    const previousVersion = this.version; const backup = join(this.context.failedDir, `recovery-${Date.now()}-${taskId.slice(0, 6)}`);
    await this.copyProject(this.context.draftDir, backup);
    await this.activity.emit(taskId, 'status', 'recovery', `Backed up the current draft and activating ${version}`);
    try {
      await rm(this.context.draftDir, { recursive: true, force: true }); await this.copyProject(release, this.context.draftDir);
      await this.activateRelease(this.context, version, taskId, true, mode); this.version = version; this.snapshotCache = undefined;
      await writeFile(this.context.currentPath, JSON.stringify({ version })); await this.registry.touch(this.context.id);
      return { workspaceId: this.context.id, version, previousVersion, backup, previewUrl: `${this.previewUrl}/?workspace=${this.context.id}&v=${version}` };
    } catch (error) {
      await rm(this.context.draftDir, { recursive: true, force: true }); await this.copyProject(backup, this.context.draftDir); this.version = previousVersion;
      throw error;
    }
  }

  async restoreDraft() { await rm(this.context.draftDir, { recursive: true, force: true }); await this.copyProject(join(this.context.releasesDir, this.version), this.context.draftDir); }
  async preserveFailed(taskId: string) { await this.copyProject(this.context.draftDir, join(this.context.failedDir, taskId)); }

  private startGateway() {
    this.gateway = http.createServer((request, response) => {
      if (new URL(request.url || '/', 'http://workspace').pathname === '/__cowork_bridge.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); response.end(selectionBridge); return;
      }
      if (!this.target && !this.dockerAvailable) { void this.serveStaticFallback(request, response); return; }
      if (!this.target) { response.writeHead(503, { 'content-type': 'text/plain' }); response.end('Workspace preview is starting'); return; }
      this.proxyHttp(request, response);
    });
    this.gateway.on('upgrade', (request, socket, head) => this.target ? this.proxy.ws(request, socket, head, { target: this.target }) : socket.destroy());
    this.gateway.listen(config.previewPort, '127.0.0.1');
  }

  private proxyHttp(request: http.IncomingMessage, response: http.ServerResponse) {
    const target = new URL(this.target);
    const upstream = http.request({
      hostname: target.hostname, port: target.port, method: request.method, path: request.url,
      headers: { ...request.headers, host: target.host, 'accept-encoding': 'identity' },
    }, (incoming) => {
      const contentType = String(incoming.headers['content-type'] || '');
      if (!contentType.includes('text/html')) {
        response.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(response); return;
      }
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8');
        const tag = '<script src="/__cowork_bridge.js"></script>';
        const html = source.includes('</body>') ? source.replace('</body>', `${tag}</body>`) : source + tag;
        const headers = { ...incoming.headers, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' };
        delete headers['content-encoding']; delete headers['transfer-encoding'];
        response.writeHead(incoming.statusCode || 200, headers); response.end(html);
      });
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Workspace preview unavailable'); });
    request.pipe(upstream);
  }

  private async serveStaticFallback(request: http.IncomingMessage, response: http.ServerResponse) {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://workspace').pathname);
    if (pathname === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true,"static":true}'); return; }
    const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1)); if (relative.startsWith('..')) { response.writeHead(403); response.end(); return; }
    const file = join(this.context.releasesDir, this.version, relative);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
    try { const data = await readFile(file); response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); response.end(data); }
    catch { response.writeHead(404); response.end('Not found'); }
  }

  private async activateRelease(context: WorkspaceContext, version: string, taskId: string, browserGuard = true, mode: WorkspaceMode = 'mixed') {
    if (!this.dockerAvailable) throw new Error('Docker Desktop is required to validate and publish generated code.');
    const container = `cowork-preview-${safeName(context.id)}-${safeName(version)}`;
    const started = await this.buildAndRun(join(context.releasesDir, version), container, `cowork-preview:${safeName(context.id)}-${safeName(version)}`);
    if (!started.target) throw new Error(started.error || 'Preview container failed to start');
    if (browserGuard) {
      const inspection = await this.browserInspect(started.target, mode);
      if (inspection.errors.length) { await run('docker', ['rm', '-f', container]); throw new Error(`Preview failed health check: ${inspection.errors.join('; ')}`); }
    }
    const previous = this.activeContainer; this.target = started.target; this.activeContainer = container;
    if (shouldRemovePreviousContainer(previous, container)) await run('docker', ['rm', '-f', previous], { timeout: 20_000 });
    if (taskId !== 'startup') await this.activity.emit(taskId, 'validation', 'publishing', browserGuard ? `Preview ${version} is healthy and live` : `Preview ${version} was published without browser inspection`);
  }

  private async buildAndRun(context: string, container: string, image: string): Promise<{ target?: string; error?: string }> {
    await run('docker', ['rm', '-f', container], { timeout: 20_000 });
    const built = await run('docker', ['build', '-f', config.dockerfile, '-t', image, context], { timeout: 300_000 });
    if (built.code) return { error: built.stderr || built.stdout };
    const launched = await run('docker', ['run', '-d', '--rm', '--name', container, '--network', 'bridge', '--cpus', '2', '--memory', '2g', '--pids-limit', '256', '-p', '127.0.0.1::4173', image], { timeout: 30_000 });
    if (launched.code) return { error: launched.stderr || launched.stdout };
    const mapped = await run('docker', ['port', container, '4173/tcp']); const match = mapped.stdout.match(/127\.0\.0\.1:(\d+)/);
    if (!match) return { error: `Could not resolve preview port: ${mapped.stderr}` };
    const target = `http://127.0.0.1:${match[1]}`;
    for (let attempt = 0; attempt < 40; attempt++) { if (await fetch(`${target}/health`).then((response) => response.ok).catch(() => false)) return { target }; await new Promise((done) => setTimeout(done, 250)); }
    return { error: 'Preview did not become healthy within 10 seconds' };
  }

  private async browserInspect(url: string, mode: WorkspaceMode = 'mixed'): Promise<PreviewInspection> {
    const executablePath = await findChrome(); if (!executablePath) return { errors: ['Chrome or Edge executable was not found for the browser smoke test.'] };
    const browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`console: ${message.text()}`); });
    page.on('response', (response) => { const path = new URL(response.url()).pathname; if (response.status() >= 400 && path !== '/favicon.ico') errors.push(`response: HTTP ${response.status()} ${path}`); });
    page.on('requestfailed', (request) => errors.push(`request: ${request.url()} ${request.failure()?.errorText || ''}`));
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); if (!response?.ok()) errors.push(`HTTP ${response?.status() || 'no response'}`); await page.waitForTimeout(750);
      if (mode === 'canvas') {
        const canvasContract = await page.evaluate(() => {
          const adapter = (window as any).coworkCanvas;
          const canvas = adapter && (typeof adapter.getPrimaryCanvas === 'function' ? adapter.getPrimaryCanvas() : adapter.canvas);
          return canvas instanceof HTMLCanvasElement && canvas.matches('[data-cowork-canvas-primary]') && typeof adapter.hitTest === 'function' && typeof adapter.getLayer === 'function';
        });
        if (!canvasContract) errors.push('Canvas mode requires a visible data-cowork-canvas-primary canvas and window.coworkCanvas hitTest/getLayer adapter.');
      }
    }
    catch (error) { errors.push((error as Error).message); }
    const screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'); await browser.close();
    return { errors: [...new Set(errors)], screenshotBase64, url };
  }

  private async copyProject(source: string, target: string) { await mkdir(target, { recursive: true }); await cp(source, target, { recursive: true, force: true, filter: (path) => !['node_modules', '.git', 'releases', 'failed'].includes(basename(path)) }); }
  private async ensureInitialRelease(context: WorkspaceContext) {
    await Promise.all([mkdir(context.releasesDir, { recursive: true }), mkdir(context.failedDir, { recursive: true }), mkdir(context.stateDir, { recursive: true })]);
    const current = await readFile(context.currentPath, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.version && await exists(join(context.releasesDir, current.version))) return String(current.version);
    const version = 'initial'; await this.copyProject(context.draftDir, join(context.releasesDir, version)); await writeFile(context.currentPath, JSON.stringify({ version })); return version;
  }
  private emitCommand(taskId: string, result: CommandResult) { if (result.stdout.trim()) void this.activity.emit(taskId, 'stdout', 'validate', result.stdout.trim()); if (result.stderr.trim()) void this.activity.emit(taskId, 'stderr', 'validate', result.stderr.trim()); }
}

export function sandboxRunArgs(draftDir: string, command: string, network = false) {
  return ['run', '--rm', '--cpus', '2', '--memory', '2g', '--pids-limit', '256', '--network', network ? 'bridge' : 'none', '-v', `${draftDir}:/workspace`, '-w', '/workspace', config.sandboxImage, 'sh', '-lc', command];
}

export function shouldRemovePreviousContainer(previous: string, current: string) { return !!previous && previous !== current; }

function resultCheck(name: string, result: CommandResult): CheckResult { return { name, status: result.code ? 'failed' : 'passed', details: (result.code ? result.stderr || result.stdout : result.stdout).trim().slice(-4000) }; }
function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 45); }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
async function exists(path: string) { return stat(path).then(() => true).catch(() => false); }
async function findChrome() { const candidates = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean) as string[]; for (const candidate of candidates) if (await exists(resolve(candidate))) return candidate; return ''; }
function safeVersion(value: string) { return /^[a-zA-Z0-9_.-]+$/.test(value); }
async function projectManifest(root: string) { const map = new Map<string, string>(); for (const file of await walkProject(root)) { const data = await readFile(file); map.set(relative(root, file).replaceAll('\\', '/'), createHash('sha256').update(data).digest('hex')); } return map; }
async function walkProject(root: string): Promise<string[]> { const output: string[] = []; for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) { if (['node_modules', '.git', 'dist', 'failed', 'releases'].includes(item.name)) continue; const path = join(root, item.name); if (item.isDirectory()) output.push(...await walkProject(path)); else if (item.isFile()) output.push(path); } return output; }
