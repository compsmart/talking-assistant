import { useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceCatalog, WorkspaceMode, WorkspaceSettings } from '../../shared/protocol';
import { DEFAULT_CLIENT_SETTINGS } from '../settings/defaults';
import { FloatingWindow } from './FloatingWindow';

interface Props {
  settings: WorkspaceSettings;
  canvasCompatible: boolean;
  taskBusy: boolean;
  catalog: WorkspaceCatalog;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onCreate: (name: string, mode: WorkspaceMode) => Promise<void>;
  onActivate: (id: string) => Promise<void>;
  onDuplicate: (id: string, name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

export function WorkspaceSettingsPanel({ settings, canvasCompatible, taskBusy, catalog, onSave, onCreate, onActivate, onDuplicate, onRename, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [action, setAction] = useState<{ kind: 'create' | 'duplicate' | 'rename'; id?: string }>();
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('dom');
  useEffect(() => setDraft(settings), [settings]);
  const update = <K extends keyof WorkspaceSettings>(section: K, value: WorkspaceSettings[K]) => setDraft((current) => ({ ...current, [section]: value }));
  const save = async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } };
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const mayLeave = () => !dirty || window.confirm('Discard unsaved settings changes and change workspaces?');
  const manage = async (operation: () => Promise<void>) => { setWorkspaceBusy(true); setWorkspaceError(''); try { await operation(); setAction(undefined); } catch (error) { setWorkspaceError((error as Error).message); } finally { setWorkspaceBusy(false); } };
  const begin = (kind: 'create' | 'duplicate' | 'rename', id?: string, name = '') => { setAction({ kind, id }); setWorkspaceName(name); setWorkspaceError(''); };
  const submitAction = () => {
    if (!workspaceName.trim()) { setWorkspaceError('Enter a workspace name.'); return Promise.resolve(); }
    if (['create', 'duplicate'].includes(action?.kind || '') && !mayLeave()) return Promise.resolve();
    return manage(async () => {
      if (action?.kind === 'create') await onCreate(workspaceName, workspaceMode);
      if (action?.kind === 'duplicate' && action.id) await onDuplicate(action.id, workspaceName);
      if (action?.kind === 'rename' && action.id) await onRename(action.id, workspaceName);
    });
  };
  return <FloatingWindow id="workspace-settings" title="Workspace Settings" initial={{ x: 72, y: 72, width: 580, height: 640 }} minWidth={460} minHeight={420} className="settings-window" onClose={onClose}>
    <div className="settings-page">
      <section className="workspace-manager"><div className="workspace-manager-title"><div><h2>Workspaces</h2><p>Each workspace is saved automatically with isolated code, releases, settings, and Git history.</p></div><button disabled={taskBusy || workspaceBusy} onClick={() => begin('create')}>New workspace</button></div>
        <div className="workspace-list">{catalog.workspaces.map((item) => <div className={`workspace-row ${item.active ? 'active' : ''}`} key={item.id}>
          <div><strong>{item.name}</strong><span>{item.mode.toUpperCase()}{item.active ? ' · Active · Saved automatically' : ''}</span></div>
          <div className="workspace-actions">{!item.active && <button disabled={taskBusy || workspaceBusy} onClick={() => { if (mayLeave()) void manage(() => onActivate(item.id)); }}>Open</button>}<button disabled={taskBusy || workspaceBusy} onClick={() => begin('duplicate', item.id, `${item.name} copy`)}>Duplicate</button><button disabled={taskBusy || workspaceBusy} onClick={() => begin('rename', item.id, item.name)}>Rename</button><button className="danger" disabled={taskBusy || workspaceBusy || item.active || catalog.workspaces.length === 1} title={item.active ? 'Switch workspaces before deleting this one.' : ''} onClick={() => { if (window.confirm(`Permanently delete “${item.name}”, including its code and Git history?`)) void manage(() => onDelete(item.id)); }}>Delete</button></div>
        </div>)}</div>
        {action && <div className="workspace-form"><strong>{action.kind === 'create' ? 'Create workspace' : action.kind === 'duplicate' ? 'Duplicate workspace' : 'Rename workspace'}</strong><input autoFocus maxLength={80} value={workspaceName} placeholder="Workspace name" onChange={(event) => setWorkspaceName(event.target.value)} />{action.kind === 'create' && <select value={workspaceMode} onChange={(event) => setWorkspaceMode(event.target.value as WorkspaceMode)}><option value="dom">DOM</option><option value="canvas">Canvas</option><option value="mixed">Mixed</option></select>}<button className="ghost" onClick={() => setAction(undefined)}>Cancel</button><button disabled={workspaceBusy} onClick={() => void submitAction()}>{workspaceBusy ? 'Working…' : action.kind === 'rename' ? 'Rename' : 'Create and open'}</button></div>}
        {workspaceError && <div className="settings-warning"><strong>Workspace action failed</strong><span>{workspaceError}</span></div>}
        {taskBusy && <p className="settings-note">Workspace management is locked while the coding agent is working.</p>}
      </section>
      <section><h2>Workspace mode</h2><p>Controls live vision, element selection, and the coding agent's rendering approach.</p>
        <div className="mode-options">{([
          ['canvas', 'Canvas', 'One primary HTML5 canvas with semantic, selectable layers.'],
          ['dom', 'DOM', 'Semantic HTML and CSS with DOM element selection.'],
          ['mixed', 'Mixed', 'DOM interfaces combined with registered canvas layers.'],
        ] as const).map(([value, label, detail]) => <label className={draft.mode === value ? 'selected' : ''} key={value}><input type="radio" name="workspace-mode" value={value} checked={draft.mode === value} onChange={() => update('mode', value)} /><strong>{label}</strong><span>{detail}</span></label>)}</div>
        {draft.mode === 'canvas' && !canvasCompatible && <div className="settings-warning"><strong>Canvas contract missing</strong><span>The project has no primary canvas adapter. Canvas vision and selection will remain unavailable until the coding agent adds one.</span></div>}
      </section>
      <section><h2>Live vision</h2><div className="settings-grid">
        <Field label="Frame rate"><select value={draft.vision.frameRate} onChange={(event) => update('vision', { ...draft.vision, frameRate: Number(event.target.value) as .5 | 1 | 2 })}><option value={.5}>0.5 FPS</option><option value={1}>1 FPS</option><option value={2}>2 FPS</option></select></Field>
        <Field label="Image quality"><select value={draft.vision.quality} onChange={(event) => update('vision', { ...draft.vision, quality: event.target.value as WorkspaceSettings['vision']['quality'] })}><option value="low">Low · 512px</option><option value="balanced">Balanced · 768px</option><option value="high">High · 1024px</option></select></Field>
      </div></section>
      <section><h2>Agent access</h2>
        <Toggle checked={draft.liveAgent.directFileEdits} onChange={(value) => update('liveAgent', { directFileEdits: value })} label="Allow Live agent to edit files directly" detail="Delegated coding tasks remain available when disabled." />
        <Toggle checked={draft.codingAgent.mediaGeneration} onChange={(value) => update('codingAgent', { ...draft.codingAgent, mediaGeneration: value })} label="Allow image and animation generation" detail="Existing workspace assets remain readable." />
        <Field label="New dependencies"><select value={draft.codingAgent.dependencies} onChange={(event) => update('codingAgent', { ...draft.codingAgent, dependencies: event.target.value as WorkspaceSettings['codingAgent']['dependencies'] })}><option value="allow">Allowed</option><option value="existing-only">Existing packages only</option></select></Field>
        <Field label="Coding reasoning"><select value={draft.codingAgent.reasoningProfile} onChange={(event) => update('codingAgent', { ...draft.codingAgent, reasoningProfile: event.target.value as WorkspaceSettings['codingAgent']['reasoningProfile'] })}><option value="adaptive">Adaptive</option><option value="balanced">Balanced</option><option value="fast">Fast</option></select></Field>
        <Field label="Parallel agents"><select value={draft.codingAgent.maxParallelAgents} onChange={(event) => update('codingAgent', { ...draft.codingAgent, maxParallelAgents: Number(event.target.value) })}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}{value === 3 ? ' · recommended' : ''}</option>)}</select></Field>
      </section>
      <section><h2>Verification and Git</h2><div className="settings-grid">
        <Field label="Coding validation"><select value={draft.codingAgent.validation} onChange={(event) => update('codingAgent', { ...draft.codingAgent, validation: event.target.value as WorkspaceSettings['codingAgent']['validation'] })}><option value="standard">Standard</option><option value="fast">Fast · publish guard</option><option value="unchecked">Unchecked</option></select></Field>
      </div><p className="settings-note">Unchecked still requires the preview container to build, start, and answer its health endpoint. User changes made in Workspace Files are committed automatically.</p></section>
      <footer><button className="ghost" onClick={() => setDraft(structuredClone(DEFAULT_CLIENT_SETTINGS))}>Restore defaults</button><span />{taskBusy && <em>Changes apply to the next coding task.</em>}<button className="ghost" onClick={onClose}>Cancel</button><button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</button></footer>
    </div>
  </FloatingWindow>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string }) { return <label className="settings-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{label}</strong><small>{detail}</small></span></label>; }
