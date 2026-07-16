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
  const scaffold = scaffoldFor(mode);
  const files: Record<string, string> = {
    'package.json': JSON.stringify(packageJson, null, 2) + '\n',
    'index.html': `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${scaffold.title}</title><link rel="stylesheet" href="/styles.css"></head><body>${scaffold.body}<script type="module" src="/main.js"></script></body></html>`,
    'styles.css': scaffold.styles,
    'main.js': scaffold.script,
    'server.mjs': scaffoldServerSource,
    'scripts/build.mjs': `import{cp,mkdir,rm}from'node:fs/promises';await rm('dist',{recursive:true,force:true});await mkdir('dist');for(const file of['index.html','styles.css','main.js'])await cp(file,'dist/'+file);\n`,
  };
  for (const [path, content] of Object.entries(files)) { const absolute = join(root, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, content, 'utf8'); }
}

function scaffoldFor(mode: WorkspaceMode) {
  if (mode === 'dom') return {
    title: 'New DOM Workspace',
    body: '<main class="hero" data-cowork-id="welcome"><span class="eyebrow">DOM mode</span><h1>New DOM Workspace</h1><h2>Build accessible interfaces with responsive, selectable HTML.</h2></main>',
    styles: `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07111f;color:#eef8ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 20% 20%,rgba(35,211,171,.16),transparent 35%),radial-gradient(circle at 82% 75%,rgba(125,92,255,.15),transparent 38%),#07111f}.hero{width:min(920px,calc(100% - 2rem));padding:clamp(2rem,8vw,6rem);text-align:center;border:1px solid rgba(151,229,255,.16);border-radius:clamp(1.5rem,4vw,3rem);background:linear-gradient(145deg,rgba(17,35,55,.88),rgba(8,20,35,.78));box-shadow:0 30px 90px rgba(0,0,0,.35)}.eyebrow{display:inline-block;margin-bottom:1.25rem;color:#72f0cf;font-size:.78rem;font-weight:750;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:clamp(2.75rem,8vw,6.75rem);line-height:.95;letter-spacing:-.055em;background:linear-gradient(115deg,#fff 20%,#8ef4db 58%,#7bdcff);-webkit-background-clip:text;background-clip:text;color:transparent}h2{max-width:680px;margin:1.5rem auto 0;color:#9fb2c6;font-size:clamp(1rem,2.2vw,1.35rem);font-weight:450;line-height:1.6}@media(max-width:520px){.hero{padding:2.5rem 1.25rem}}\n`,
    script: `document.querySelector('main').dataset.ready='true';\n`,
  };

  if (mode === 'mixed') return {
    title: 'New Mixed Workspace',
    body: '<canvas id="workspace-canvas" data-cowork-id="workspace-canvas" data-cowork-canvas-primary aria-label="Animated workspace background"></canvas><main class="hero" data-cowork-id="welcome"><span class="eyebrow">Mixed mode</span><h1>New Mixed Workspace</h1><h2>Combine selectable HTML with an animated canvas backdrop.</h2><div class="chips" aria-label="Workspace capabilities"><span>Semantic DOM</span><span>Native canvas</span><span>Responsive motion</span></div></main>',
    styles: `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07111f;color:#eef8ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:#07111f}canvas{position:fixed;inset:0;width:100%;height:100%;z-index:0}.hero{position:relative;z-index:1;width:min(940px,calc(100% - 2rem));padding:clamp(2rem,8vw,5.5rem);text-align:center;border:1px solid rgba(151,229,255,.18);border-radius:clamp(1.5rem,4vw,3rem);background:linear-gradient(145deg,rgba(8,24,41,.72),rgba(7,17,31,.48));box-shadow:0 32px 100px rgba(0,0,0,.38);backdrop-filter:blur(12px)}.eyebrow{display:inline-block;margin-bottom:1.25rem;color:#72f0cf;font-size:.78rem;font-weight:750;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:clamp(2.6rem,8vw,6.5rem);line-height:.96;letter-spacing:-.055em}h2{max-width:680px;margin:1.5rem auto 0;color:#a9bdd0;font-size:clamp(1rem,2.2vw,1.35rem);font-weight:450;line-height:1.6}.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:.65rem;margin-top:2rem}.chips span{padding:.55rem .85rem;border:1px solid rgba(114,240,207,.24);border-radius:999px;background:rgba(10,31,48,.7);color:#cbe8ed;font-size:.82rem}@media(max-width:520px){.hero{padding:2.5rem 1.25rem}.chips{margin-top:1.5rem}}\n`,
    script: mixedCanvasScript,
  };

  return {
    title: 'New Canvas Workspace',
    body: '<canvas id="workspace-canvas" data-cowork-id="workspace-canvas" data-cowork-canvas-primary aria-label="New Canvas Workspace"></canvas>',
    styles: `:root{color-scheme:dark;background:#07111f}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}canvas{position:fixed;inset:0;width:100%;height:100%;touch-action:none}\n`,
    script: canvasOnlyScript,
  };
}

const canvasOnlyScript = `const canvas=document.querySelector('[data-cowork-canvas-primary]');
const ctx=canvas.getContext('2d');
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const layers=[
  {id:'background-layer',label:'Animated grid background',type:'background',bounds:{x:0,y:0,width:0,height:0},properties:{animated:true}},
  {id:'title-layer',label:'New Canvas Workspace',type:'text',bounds:{x:0,y:0,width:0,height:0},properties:{text:'New Canvas Workspace'}},
  {id:'subtitle-layer',label:'Canvas workspace capability',type:'text',bounds:{x:0,y:0,width:0,height:0},properties:{text:'Draw responsive, animated experiences with native canvas APIs.'}}
];
let width=0,height=0,dpr=1,frame=0;
function resize(){const nextDpr=Math.max(1,window.devicePixelRatio||1);const nextWidth=innerWidth;const nextHeight=innerHeight;if(width===nextWidth&&height===nextHeight&&dpr===nextDpr)return false;width=nextWidth;height=nextHeight;dpr=nextDpr;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);layers[0].bounds={x:0,y:0,width:canvas.width,height:canvas.height};return true}
function textBounds(layer,text,x,baseline,size){const metrics=ctx.measureText(text);const ascent=metrics.actualBoundingBoxAscent||size*.76;const descent=metrics.actualBoundingBoxDescent||size*.24;layer.bounds={x:Math.round((x-metrics.width/2)*dpr),y:Math.round((baseline-ascent)*dpr),width:Math.round(metrics.width*dpr),height:Math.round((ascent+descent)*dpr)}}
function fitFont(text,weight,preferred,minimum,maxWidth){let size=preferred;do{ctx.font=weight+' '+size+'px system-ui, sans-serif';if(ctx.measureText(text).width<=maxWidth||size<=minimum)return size;size--}while(size>minimum);return size}
function draw(time=0){resize();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);const pulse=motion.matches?0:Math.sin(time*.0007)*.5+.5;const gradient=ctx.createRadialGradient(width*.5,height*.44,0,width*.5,height*.44,Math.max(width,height)*.68);gradient.addColorStop(0,'rgba(22,69,83,'+(0.32+pulse*.08)+')');gradient.addColorStop(.48,'#0b1a2b');gradient.addColorStop(1,'#07111f');ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);ctx.strokeStyle='rgba(103,215,221,.1)';ctx.lineWidth=1;const gap=Math.max(38,Math.min(64,width/18));const shift=motion.matches?0:(time*.006)%gap;ctx.beginPath();for(let x=-gap+shift;x<width+gap;x+=gap){ctx.moveTo(x,0);ctx.lineTo(x,height)}for(let y=-gap+shift;y<height+gap;y+=gap){ctx.moveTo(0,y);ctx.lineTo(width,y)}ctx.stroke();for(let i=0;i<26;i++){const speed=.00008+(i%5)*.000025;const angle=i*2.399+(motion.matches?0:time*speed);const radius=Math.min(width,height)*(.18+(i%7)*.035);const x=width*.5+Math.cos(angle)*radius;const y=height*.46+Math.sin(angle*1.17)*radius*.68;ctx.beginPath();ctx.fillStyle=i%3===0?'rgba(125,92,255,.48)':i%3===1?'rgba(114,240,207,.5)':'rgba(73,205,255,.44)';ctx.arc(x,y,1.5+(i%4),0,Math.PI*2);ctx.fill()}const title='New Canvas Workspace';const subtitle='Draw responsive, animated experiences with native canvas APIs.';const titleSize=fitFont(title,'750',Math.max(34,Math.min(78,width*.075)),18,width*.86);const subtitleSize=fitFont(subtitle,'450',Math.max(15,Math.min(22,width*.024)),8,width*.88);const titleY=height*.49+(motion.matches?0:Math.sin(time*.0012)*3);ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.font='750 '+titleSize+'px system-ui, sans-serif';ctx.shadowColor='rgba(114,240,207,'+(.24+pulse*.16)+')';ctx.shadowBlur=24+pulse*10;ctx.fillStyle='#eefcff';ctx.fillText(title,width/2,titleY);ctx.shadowBlur=0;textBounds(layers[1],title,width/2,titleY,titleSize);ctx.font='450 '+subtitleSize+'px system-ui, sans-serif';ctx.fillStyle='rgba(159,184,202,'+(.82+pulse*.18)+')';const subtitleY=titleY+Math.max(38,titleSize*.78);ctx.fillText(subtitle,width/2,subtitleY);textBounds(layers[2],subtitle,width/2,subtitleY,subtitleSize)}
function animate(time){draw(time);if(!motion.matches)frame=requestAnimationFrame(animate)}
function restart(){cancelAnimationFrame(frame);if(motion.matches)draw(0);else frame=requestAnimationFrame(animate)}
function contains(layer,point){const b=layer.bounds;return point.x>=b.x&&point.x<=b.x+b.width&&point.y>=b.y&&point.y<=b.y+b.height}
window.coworkCanvas={canvas,getPrimaryCanvas:()=>canvas,getLayer:id=>layers.find(layer=>layer.id===id)||null,hitTest:point=>[...layers].reverse().find(layer=>contains(layer,point))||null};
addEventListener('resize',restart);motion.addEventListener('change',restart);setInterval(()=>{if(resize()&&motion.matches)draw(0)},500);restart();dispatchEvent(new Event('cowork:canvas-adapter-ready'));
`;

const mixedCanvasScript = `const canvas=document.querySelector('[data-cowork-canvas-primary]');
const ctx=canvas.getContext('2d');const motion=matchMedia('(prefers-reduced-motion: reduce)');
const layer={id:'background-layer',label:'Animated canvas background',type:'background',bounds:{x:0,y:0,width:0,height:0},properties:{animated:true}};
let width=0,height=0,dpr=1,frame=0;
function resize(){const nextDpr=Math.max(1,devicePixelRatio||1);if(width===innerWidth&&height===innerHeight&&dpr===nextDpr)return false;width=innerWidth;height=innerHeight;dpr=nextDpr;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);layer.bounds={x:0,y:0,width:canvas.width,height:canvas.height};return true}
function draw(time=0){resize();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);const glow=ctx.createRadialGradient(width*(.2+Math.sin(time*.00018)*.04),height*.2,0,width*.3,height*.25,Math.max(width,height)*.72);glow.addColorStop(0,'rgba(42,221,178,.25)');glow.addColorStop(.48,'rgba(22,48,72,.32)');glow.addColorStop(1,'#07111f');ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);const gap=Math.max(42,Math.min(70,width/16));ctx.strokeStyle='rgba(111,218,225,.09)';ctx.beginPath();for(let x=0;x<width;x+=gap){ctx.moveTo(x,0);ctx.lineTo(x,height)}for(let y=0;y<height;y+=gap){ctx.moveTo(0,y);ctx.lineTo(width,y)}ctx.stroke();for(let i=0;i<18;i++){const phase=i*1.73+(motion.matches?0:time*(.00008+(i%4)*.00002));const x=width*.5+Math.cos(phase)*width*(.2+(i%5)*.055);const y=height*.5+Math.sin(phase*1.21)*height*(.16+(i%3)*.055);ctx.beginPath();ctx.fillStyle=i%2?'rgba(94,207,255,.4)':'rgba(142,101,255,.42)';ctx.arc(x,y,2+(i%3),0,Math.PI*2);ctx.fill()}}
function animate(time){draw(time);if(!motion.matches)frame=requestAnimationFrame(animate)}function restart(){cancelAnimationFrame(frame);if(motion.matches)draw(0);else frame=requestAnimationFrame(animate)}
window.coworkCanvas={canvas,getPrimaryCanvas:()=>canvas,getLayer:id=>id===layer.id?layer:null,hitTest:({x,y})=>x>=0&&y>=0&&x<=layer.bounds.width&&y<=layer.bounds.height?layer:null};
addEventListener('resize',restart);motion.addEventListener('change',restart);setInterval(()=>{if(resize()&&motion.matches)draw(0)},500);restart();dispatchEvent(new Event('cowork:canvas-adapter-ready'));
`;

export const scaffoldServerSource = `import http from 'node:http';import{readFile}from'node:fs/promises';import{extname,join}from'node:path';const types={'.html':'text/html','.css':'text/css','.js':'text/javascript'};http.createServer(async(req,res)=>{const pathname=new URL(req.url||'/','http://workspace').pathname;if(pathname==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return}const path=join(process.cwd(),pathname==='/'?'index.html':pathname.slice(1));try{const data=await readFile(path);res.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream'});res.end(data)}catch{res.writeHead(404);res.end('Not found')}}).listen(4173,'0.0.0.0');\n`;
