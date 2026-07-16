import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { WorkspaceCatalog, WorkspaceMode, WorkspaceSettings, WorkspaceSummary } from '../../shared/protocol.js';
import { DEFAULT_WORKSPACE_SETTINGS } from './WorkspaceSettingsService.js';

interface WorkspaceRecord { id: string; name: string; createdAt: string; updatedAt: string }
interface StoredCatalog { activeWorkspaceId: string; workspaces: WorkspaceRecord[] }

export interface WorkspaceContext extends WorkspaceRecord {
  rootDir: string;
  draftDir: string;
  releasesDir: string;
  failedDir: string;
  stateDir: string;
  gitDir: string;
  candidatesDir: string;
  mediaJobsDir: string;
  settingsPath: string;
  currentPath: string;
}

export class WorkspaceRegistry {
  private catalog: StoredCatalog = { activeWorkspaceId: '', workspaces: [] };

  async initialize() {
    await Promise.all([mkdir(config.projectsDir, { recursive: true }), mkdir(config.workspacesStateDir, { recursive: true })]);
    const stored = await readJson<StoredCatalog>(config.workspaceCatalogPath);
    if (stored?.activeWorkspaceId && Array.isArray(stored.workspaces) && stored.workspaces.length) this.catalog = stored;
    else await this.importLegacy();
    if (!this.catalog.workspaces.some((item) => item.id === this.catalog.activeWorkspaceId)) this.catalog.activeWorkspaceId = this.catalog.workspaces[0].id;
    await this.save();
  }

  active() { return this.get(this.catalog.activeWorkspaceId); }
  get(id: string) {
    const record = this.catalog.workspaces.find((item) => item.id === id);
    if (!record) throw statusError('Workspace not found.', 404);
    return contextFor(record);
  }
  records() { return this.catalog.workspaces.map((item) => ({ ...item })); }
  isActive(id: string) { return id === this.catalog.activeWorkspaceId; }

  async summaries(settingsFor: (id: string) => WorkspaceSettings): Promise<WorkspaceCatalog> {
    return {
      activeWorkspaceId: this.catalog.activeWorkspaceId,
      workspaces: this.catalog.workspaces.map((item): WorkspaceSummary => ({ ...item, mode: settingsFor(item.id).mode, active: item.id === this.catalog.activeWorkspaceId })),
    };
  }

  async create(name: string, mode: WorkspaceMode, source?: WorkspaceContext) {
    const normalizedName = this.validateName(name);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = { id: randomUUID(), name: normalizedName, createdAt: now, updatedAt: now };
    const context = contextFor(record);
    await Promise.all([mkdir(context.draftDir, { recursive: true }), mkdir(context.releasesDir, { recursive: true }), mkdir(context.failedDir, { recursive: true }), mkdir(context.stateDir, { recursive: true })]);
    if (source) await copyProject(source.draftDir, context.draftDir);
    else await writeScaffold(context.draftDir, mode);
    const settings = source ? await readJson<WorkspaceSettings>(source.settingsPath) || { ...DEFAULT_WORKSPACE_SETTINGS, mode } : { ...structuredClone(DEFAULT_WORKSPACE_SETTINGS), mode };
    await atomicJson(context.settingsPath, settings);
    this.catalog.workspaces.push(record); await this.save();
    return context;
  }

  async activate(id: string) { this.get(id); this.catalog.activeWorkspaceId = id; await this.touch(id); }
  async renameWorkspace(id: string, name: string) {
    const record = this.catalog.workspaces.find((item) => item.id === id); if (!record) throw statusError('Workspace not found.', 404);
    record.name = this.validateName(name, id); record.updatedAt = new Date().toISOString(); await this.save(); return this.get(id);
  }
  async touch(id: string) { const item = this.catalog.workspaces.find((entry) => entry.id === id); if (item) item.updatedAt = new Date().toISOString(); await this.save(); }
  async remove(id: string, allowActive = false) {
    if (this.catalog.workspaces.length <= 1) throw statusError('The final workspace cannot be deleted.', 409);
    if (!allowActive && this.isActive(id)) throw statusError('Switch to another workspace before deleting the active workspace.', 409);
    const context = this.get(id); this.catalog.workspaces = this.catalog.workspaces.filter((item) => item.id !== id); await this.save();
    await Promise.all([rm(context.rootDir, { recursive: true, force: true }), rm(context.stateDir, { recursive: true, force: true })]);
  }
  async rollbackCreate(id: string) {
    const record = this.catalog.workspaces.find((item) => item.id === id); if (!record) return;
    const context = contextFor(record); this.catalog.workspaces = this.catalog.workspaces.filter((item) => item.id !== id); await this.save();
    await Promise.all([rm(context.rootDir, { recursive: true, force: true }), rm(context.stateDir, { recursive: true, force: true })]);
  }

  explicitReferences(text: string) {
    const haystack = normalize(text); if (!haystack) return [];
    const candidates = this.catalog.workspaces.filter((item) => !this.isActive(item.id)).map((item) => ({ item, needle: normalize(item.name) })).sort((a, b) => b.needle.length - a.needle.length);
    const occupied: Array<[number, number]> = []; const matches: WorkspaceContext[] = [];
    for (const candidate of candidates) {
      let start = haystack.indexOf(candidate.needle);
      while (start >= 0) {
        const end = start + candidate.needle.length;
        const boundary = boundaryAt(haystack, start - 1) && boundaryAt(haystack, end);
        if (boundary && !occupied.some(([left, right]) => start >= left && end <= right)) { occupied.push([start, end]); matches.push(contextFor(candidate.item)); break; }
        start = haystack.indexOf(candidate.needle, start + 1);
      }
    }
    return matches;
  }

  private validateName(value: string, exceptId?: string) {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80) throw statusError('Workspace names must contain 1 to 80 characters.', 400);
    if (this.catalog.workspaces.some((item) => item.id !== exceptId && normalize(item.name) === normalize(name))) throw statusError('Workspace names must be unique.', 409);
    return name;
  }
  private async save() { await atomicJson(config.workspaceCatalogPath, this.catalog); }

  private async importLegacy() {
    const now = new Date().toISOString(); const record: WorkspaceRecord = { id: randomUUID(), name: 'Workspace 1', createdAt: now, updatedAt: now }; const context = contextFor(record);
    await Promise.all([mkdir(context.draftDir, { recursive: true }), mkdir(context.releasesDir, { recursive: true }), mkdir(context.failedDir, { recursive: true }), mkdir(context.stateDir, { recursive: true })]);
    if (await exists(config.draftDir)) await copyProject(config.draftDir, context.draftDir); else await writeScaffold(context.draftDir, 'mixed');
    if (await exists(config.releasesDir)) await cp(config.releasesDir, context.releasesDir, { recursive: true, force: true });
    if (await exists(config.failedDir)) await cp(config.failedDir, context.failedDir, { recursive: true, force: true });
    if (await exists(config.workspaceGitDir)) await cp(config.workspaceGitDir, context.gitDir, { recursive: true, force: true });
    const settings = await readJson<WorkspaceSettings>(join(config.stateDir, 'workspace-settings.json')) || DEFAULT_WORKSPACE_SETTINGS;
    const current = await readJson<{ version: string }>(join(config.stateDir, 'current.json'));
    await atomicJson(context.settingsPath, settings); if (current) await atomicJson(context.currentPath, current);
    this.catalog = { activeWorkspaceId: record.id, workspaces: [record] };
  }
}

function contextFor(record: WorkspaceRecord): WorkspaceContext {
  const rootDir = join(config.projectsDir, record.id); const stateDir = join(config.workspacesStateDir, record.id);
  return { ...record, rootDir, draftDir: join(rootDir, 'draft'), releasesDir: join(rootDir, 'releases'), failedDir: join(rootDir, 'failed'), stateDir, gitDir: join(stateDir, 'git'), candidatesDir: join(stateDir, 'candidates'), mediaJobsDir: join(stateDir, 'media-jobs'), settingsPath: join(stateDir, 'settings.json'), currentPath: join(stateDir, 'current.json') };
}
async function atomicJson(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); await rename(temporary, path); }
async function readJson<T>(path: string) { return readFile(path, 'utf8').then((value) => JSON.parse(value) as T).catch(() => undefined); }
async function exists(path: string) { return stat(path).then(() => true).catch(() => false); }
async function copyProject(source: string, target: string) { await mkdir(target, { recursive: true }); await cp(source, target, { recursive: true, force: true, filter: (path) => !['node_modules', '.git', 'releases', 'failed'].includes(path.split(/[\\/]/).at(-1) || '') }); }
function normalize(value: string) { return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(); }
function boundaryAt(value: string, index: number) { return index < 0 || index >= value.length || !/[\p{L}\p{N}_]/u.test(value[index]); }
function statusError(message: string, status: number) { const error = new Error(message) as Error & { status?: number }; error.status = status; return error; }

async function writeScaffold(root: string, mode: WorkspaceMode) {
  const packageJson = { name: 'cowork-workspace', version: '0.0.1', private: true, type: 'module', scripts: { start: 'node server.mjs', build: 'node scripts/build.mjs', test: 'node --test' } };
  const canvas = mode !== 'dom'; const dom = mode !== 'canvas';
  const body = `${dom ? '<main data-cowork-id="welcome"><h1>New Workspace</h1><p>Ask your cowork agent to start building.</p></main>' : ''}${canvas ? '<canvas id="workspace-canvas" data-cowork-id="workspace-canvas" data-cowork-canvas-primary width="960" height="540"></canvas>' : ''}`;
  const canvasScript = canvas ? `const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');const layer={id:'welcome-layer',label:'Welcome canvas',type:'text',bounds:{x:180,y:220,width:600,height:100},properties:{}};function draw(){ctx.fillStyle='#0b1220';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#7cf3ce';ctx.font='48px system-ui';ctx.textAlign='center';ctx.fillText('New ${mode === 'canvas' ? 'Canvas' : 'Mixed'} Workspace',480,270)}draw();window.coworkCanvas={canvas,getPrimaryCanvas:()=>canvas,getLayer:id=>id===layer.id?layer:null,hitTest:({x,y})=>x>=layer.bounds.x&&x<=layer.bounds.x+layer.bounds.width&&y>=layer.bounds.y&&y<=layer.bounds.y+layer.bounds.height?layer:null};dispatchEvent(new Event('cowork:canvas-adapter-ready'));` : '';
  const files: Record<string, string> = {
    'package.json': JSON.stringify(packageJson, null, 2) + '\n',
    'index.html': `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New Workspace</title><link rel="stylesheet" href="/styles.css"></head><body>${body}<script type="module" src="/main.js"></script></body></html>`,
    'styles.css': `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e8f0fa;font-family:system-ui}main{text-align:center}p{color:#94a3b8}canvas{max-width:100%;height:auto}\n`,
    'main.js': canvasScript || `document.querySelector('main').dataset.ready='true';\n`,
    'server.mjs': scaffoldServerSource,
    'scripts/build.mjs': `import{cp,mkdir,rm}from'node:fs/promises';await rm('dist',{recursive:true,force:true});await mkdir('dist');for(const file of['index.html','styles.css','main.js'])await cp(file,'dist/'+file);\n`,
  };
  for (const [path, content] of Object.entries(files)) { const absolute = join(root, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, content, 'utf8'); }
}

export const scaffoldServerSource = `import http from 'node:http';import{readFile}from'node:fs/promises';import{extname,join}from'node:path';const types={'.html':'text/html','.css':'text/css','.js':'text/javascript'};http.createServer(async(req,res)=>{const pathname=new URL(req.url||'/','http://workspace').pathname;if(pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return}const path=join(process.cwd(),pathname==='/'?'index.html':pathname.slice(1));try{const data=await readFile(path);res.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream'});res.end(data)}catch{res.writeHead(404);res.end('Not found')}}).listen(4173,'0.0.0.0');\n`;
