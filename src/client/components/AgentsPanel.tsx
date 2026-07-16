import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AgentConfigurationSnapshot,
  AgentContextResource,
  AgentProfile,
  AgentSecretMetadata,
  AgentSkill,
  AgentStage,
  AgentToolCategoryDescriptor,
  AgentToolDescriptor,
  RoutingSimulation,
} from '../../shared/protocol';
import {
  createAgentSecret,
  deleteAgentSecret,
  getAgentConfiguration,
  getAgentTools,
  saveAgentConfiguration,
  simulateAgentRouting,
  updateAgentSecret,
} from '../settings/AgentConfigClient';
import { FloatingWindow } from './FloatingWindow';
import './AgentsPanel.css';

type Tab = 'agents' | 'tools' | 'resources' | 'secrets' | 'routing';
const TABS: Array<[Tab, string]> = [['agents', 'Agents'], ['tools', 'Tools'], ['resources', 'Skills & Context'], ['secrets', 'Secrets'], ['routing', 'Routing']];
const STAGES: AgentStage[] = ['planner', 'researcher', 'coder', 'reviewer', 'resolver', 'media'];

interface Props { workspaceId?: string; onClose: () => void; onError?: (message: string) => void }

export function AgentsPanel({ workspaceId, onClose, onError }: Props) {
  const [snapshot, setSnapshot] = useState<AgentConfigurationSnapshot>();
  const [draft, setDraft] = useState<AgentConfigurationSnapshot>();
  const [tools, setTools] = useState<AgentToolDescriptor[]>([]);
  const [toolCategories, setToolCategories] = useState<AgentToolCategoryDescriptor[]>([]);
  const [tab, setTab] = useState<Tab>('agents');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const report = (reason: unknown) => { const message = (reason as Error).message; setError(message); onError?.(message); };
  const load = async () => {
    setBusy(true); setError('');
    try {
      const [config, directory] = await Promise.all([getAgentConfiguration(workspaceId), getAgentTools()]);
      setSnapshot(config); setDraft(structuredClone(config)); setTools(directory.tools); setToolCategories(directory.categories);
      setSelectedAgentId((current) => current && config.profiles.some((profile) => profile.id === current) ? current : config.profiles[0]?.id || '');
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [workspaceId]);
  const dirty = Boolean(snapshot && draft && JSON.stringify(snapshot) !== JSON.stringify(draft));
  const save = async () => {
    if (!snapshot || !draft) return;
    setBusy(true); setError('');
    try {
      const saved = await saveAgentConfiguration(snapshot, { profiles: draft.profiles, workspaceOverrides: draft.overrides, skills: draft.skills, contexts: draft.contexts, routing: draft.routing });
      setSnapshot(saved); setDraft(structuredClone(saved));
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const close = () => { if (!dirty || window.confirm('Discard unsaved agent configuration changes?')) onClose(); };
  if (!draft) return <FloatingWindow id="agents-settings" title="Agents" initial={{ x: 88, y: 52, width: 880, height: 680 }} minWidth={680} minHeight={480} className="agents-window" onClose={close}><div className="agents-loading">{error || 'Loading agent configuration…'}</div></FloatingWindow>;
  const selected = draft.profiles.find((profile) => profile.id === selectedAgentId);
  const replaceProfile = (profile: AgentProfile) => setDraft((current) => current && ({ ...current, profiles: current.profiles.map((item) => item.id === profile.id ? profile : item) }));
  const createProfile = () => {
    const now = new Date().toISOString();
    const profile: AgentProfile = { id: crypto.randomUUID(), name: 'New agent', description: '', kind: 'custom', enabled: true, stages: ['coder'], capabilities: [], model: 'gemini-2.5-pro', instructions: '', toolIds: [], skillIds: [], contextIds: [], secretGrantIds: [], priority: 0, maxConcurrency: 1, routingRules: [], revision: 0, createdAt: now, updatedAt: now };
    setDraft((current) => current && ({ ...current, profiles: [...current.profiles, profile] })); setSelectedAgentId(profile.id); setTab('agents');
  };
  const cloneProfile = (source: AgentProfile) => { const now = new Date().toISOString(); const copy = { ...structuredClone(source), id: crypto.randomUUID(), name: `${source.name} copy`, kind: 'custom' as const, revision: 0, createdAt: now, updatedAt: now }; setDraft((current) => current && ({ ...current, profiles: [...current.profiles, copy] })); setSelectedAgentId(copy.id); };
  const removeProfile = (profile: AgentProfile) => { if (profile.kind === 'builtin' || !window.confirm(`Delete custom agent “${profile.name}”?`)) return; setDraft((current) => current && ({ ...current, profiles: current.profiles.filter((item) => item.id !== profile.id) })); setSelectedAgentId(draft.profiles.find((item) => item.id !== profile.id)?.id || ''); };
  return <FloatingWindow id="agents-settings" title="Agent Configuration" initial={{ x: 88, y: 52, width: 880, height: 680 }} minWidth={680} minHeight={480} className="agents-window" onClose={close}>
    <div className="agents-page">
      <nav className="agents-tabs" aria-label="Agent configuration sections">{TABS.map(([id, label]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {error && <div className="agents-error">{error}</div>}
      <main>
        {tab === 'agents' && <AgentsTab profiles={draft.profiles} selected={selected} skills={draft.skills} contexts={draft.contexts} onSelect={setSelectedAgentId} onCreate={createProfile} onClone={cloneProfile} onRemove={removeProfile} onChange={replaceProfile} />}
        {tab === 'tools' && <ToolsTab tools={tools} categories={toolCategories} profiles={draft.profiles} selected={selected} onSelect={setSelectedAgentId} onChange={replaceProfile} />}
        {tab === 'resources' && <ResourcesTab snapshot={draft} onChange={setDraft} />}
        {tab === 'secrets' && <SecretsTab secrets={draft.secrets} workspaceId={workspaceId} profiles={draft.profiles} reload={load} report={report} />}
        {tab === 'routing' && <RoutingTab snapshot={draft} tools={tools} categories={toolCategories} onChange={setDraft} />}
      </main>
      <footer><button className="ghost" disabled={!dirty || busy} onClick={() => { setDraft(structuredClone(snapshot)); setError(''); }}>Discard</button><span>{dirty ? 'Unsaved changes apply to future assignments.' : `Revision ${snapshot?.revision ?? draft.revision}`}</span><button className="ghost" onClick={close}>Close</button><button disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save configuration'}</button></footer>
    </div>
  </FloatingWindow>;
}

function AgentsTab({ profiles, selected, skills, contexts, onSelect, onCreate, onClone, onRemove, onChange }: { profiles: AgentProfile[]; selected?: AgentProfile; skills: AgentSkill[]; contexts: AgentContextResource[]; onSelect: (id: string) => void; onCreate: () => void; onClone: (profile: AgentProfile) => void; onRemove: (profile: AgentProfile) => void; onChange: (profile: AgentProfile) => void }) {
  return <div className="agents-split"><aside><header><strong>Agent pool</strong><button onClick={onCreate}>New</button></header>{profiles.map((profile) => <button className={`agent-list-item ${selected?.id === profile.id ? 'selected' : ''}`} key={profile.id} onClick={() => onSelect(profile.id)}><i className={profile.enabled ? 'online' : ''} /><span><strong>{profile.name}</strong><small>{profile.kind} · {profile.stages.join(', ') || 'no stages'}</small></span></button>)}</aside><div className="agent-editor">{selected ? <>
    <div className="agent-editor-heading"><div><h2>{selected.name}</h2><p>{selected.kind === 'builtin' ? 'Built-in profile. Clone it for unrestricted customization.' : 'Custom profile'}</p></div><button className="ghost" onClick={() => onClone(selected)}>Clone</button><button className="danger" disabled={selected.kind === 'builtin'} onClick={() => onRemove(selected)}>Delete</button></div>
    <Toggle checked={selected.enabled} label="Available to the Assistant" detail="Disabled agents are excluded before routing is scored." onChange={(enabled) => onChange({ ...selected, enabled })} />
    <div className="agent-form-grid"><Field label="Name"><input maxLength={80} value={selected.name} onChange={(event) => onChange({ ...selected, name: event.target.value })} /></Field><Field label="Model"><input value={selected.model} onChange={(event) => onChange({ ...selected, model: event.target.value })} /></Field><Field label="Priority (−50 to 50)"><input type="number" min={-50} max={50} value={selected.priority} onChange={(event) => onChange({ ...selected, priority: Number(event.target.value) })} /></Field><Field label="Concurrency"><input type="number" min={1} max={16} value={selected.maxConcurrency} onChange={(event) => onChange({ ...selected, maxConcurrency: Number(event.target.value) })} /></Field></div>
    <Field label="Description"><input value={selected.description} onChange={(event) => onChange({ ...selected, description: event.target.value })} /></Field>
    <fieldset><legend>Eligible stages</legend><div className="agent-check-grid">{STAGES.map((stage) => <Check key={stage} label={stage} checked={selected.stages.includes(stage)} onChange={() => onChange({ ...selected, stages: toggle(selected.stages, stage) })} />)}</div></fieldset>
    <Field label="Capabilities (comma separated)"><input value={selected.capabilities.join(', ')} onChange={(event) => onChange({ ...selected, capabilities: csv(event.target.value) })} /></Field>
    <Field label="Custom instructions"><textarea rows={7} value={selected.instructions} placeholder="Specialization, quality bar, and constraints…" onChange={(event) => onChange({ ...selected, instructions: event.target.value })} /></Field>
    <fieldset><legend>Routing rules</legend><p>Use explicit preferences or exclusions to resolve overlap with other agents.</p>{selected.routingRules.map((rule) => <div className="routing-rule" key={rule.id}><input value={rule.name} placeholder="Rule name" onChange={(event) => onChange({ ...selected, routingRules: selected.routingRules.map((item) => item.id === rule.id ? { ...item, name: event.target.value } : item) })} /><select value={rule.effect} onChange={(event) => onChange({ ...selected, routingRules: selected.routingRules.map((item) => item.id === rule.id ? { ...item, effect: event.target.value as typeof rule.effect } : item) })}><option value="prefer">Prefer</option><option value="exclude">Exclude</option></select><input type="number" min={-100} max={100} value={rule.weight} title="Routing weight" onChange={(event) => onChange({ ...selected, routingRules: selected.routingRules.map((item) => item.id === rule.id ? { ...item, weight: Number(event.target.value) } : item) })} /><input value={(rule.keywords || []).join(', ')} placeholder="Keywords, comma separated" onChange={(event) => onChange({ ...selected, routingRules: selected.routingRules.map((item) => item.id === rule.id ? { ...item, keywords: csv(event.target.value) } : item) })} /><button className="danger" onClick={() => onChange({ ...selected, routingRules: selected.routingRules.filter((item) => item.id !== rule.id) })}>Remove</button></div>)}<button onClick={() => onChange({ ...selected, routingRules: [...selected.routingRules, { id: crypto.randomUUID(), name: 'New preference', enabled: true, effect: 'prefer', weight: 25, keywords: [] }] })}>Add routing rule</button></fieldset>
    <fieldset><legend>Skills</legend><div className="agent-check-grid">{skills.map((skill) => <Check key={skill.id} label={skill.name} checked={selected.skillIds.includes(skill.id)} disabled={!skill.enabled} onChange={() => onChange({ ...selected, skillIds: toggle(selected.skillIds, skill.id) })} />)}</div></fieldset>
    <fieldset><legend>Context</legend><div className="agent-check-grid">{contexts.map((context) => <Check key={context.id} label={context.name} checked={selected.contextIds.includes(context.id)} disabled={!context.enabled} onChange={() => onChange({ ...selected, contextIds: toggle(selected.contextIds, context.id) })} />)}</div></fieldset>
  </> : <div className="agents-empty">Create or select an agent.</div>}</div></div>;
}

function ToolsTab({ tools, categories, profiles, selected, onSelect, onChange }: { tools: AgentToolDescriptor[]; categories: AgentToolCategoryDescriptor[]; profiles: AgentProfile[]; selected?: AgentProfile; onSelect: (id: string) => void; onChange: (profile: AgentProfile) => void }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readExpansionPreference());
  const selectedIds = selected?.toolIds || [];
  const selectedTools = tools.filter((tool) => selectedIds.includes(tool.id));
  const replace = (ids: string[]) => selected && onChange({ ...selected, toolIds: ids });
  const grantSafe = () => replace([...new Set([...selectedIds, ...tools.filter(isSafeTool).map((tool) => tool.id)])]);
  const clearAll = () => { if (selectedIds.length && window.confirm(`Remove all ${selectedIds.length} tool grants from ${selected?.name}?`)) replace([]); };
  const setAllExpanded = (open: boolean) => {
    const next = Object.fromEntries(categories.map((category) => [category.id, open]));
    setExpanded(next); localStorage.setItem('agent-tool-categories', JSON.stringify(next));
  };
  const updateExpansion = (id: string, open: boolean) => {
    const next = { ...expanded, [id]: open }; setExpanded(next); localStorage.setItem('agent-tool-categories', JSON.stringify(next));
  };
  return <section className="agents-section tools-page">
    <div className="section-heading"><div><h2>Tool permissions</h2><p>Choose what this agent can use. Tools are grouped by purpose; higher-risk access is called out clearly.</p></div><label className="agent-picker"><span>Editing agent</span><select value={selected?.id || ''} onChange={(event) => onSelect(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label></div>
    <div className="tool-overview" aria-label="Permission summary">
      <SummaryMetric value={selectedIds.length} label="Enabled" />
      <SummaryMetric value={selectedTools.filter((tool) => tool.risks.includes('network')).length} label="Network" tone="network" />
      <SummaryMetric value={selectedTools.filter((tool) => tool.risks.includes('write')).length} label="Workspace write" tone="write" />
      <SummaryMetric value={selectedTools.filter((tool) => tool.risks.includes('execute')).length} label="Execution" tone="execute" />
      <SummaryMetric value={selectedTools.filter((tool) => tool.risks.includes('external_action')).length} label="External action" tone="external" />
    </div>
    <div className="tool-toolbar">
      <label className="tool-search"><span aria-hidden="true">⌕</span><input value={query} placeholder="Search tools, descriptions, inputs, or risks" onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear tool search" onClick={() => setQuery('')}>×</button>}</label>
      <div><button onClick={grantSafe} disabled={!selected}>Enable safe tools</button><button className="ghost" onClick={() => setAllExpanded(true)}>Expand all</button><button className="ghost" onClick={() => setAllExpanded(false)}>Collapse all</button><button className="danger" disabled={!selectedIds.length} onClick={clearAll}>Clear all</button></div>
    </div>
    <GroupedToolChecklist tools={tools} categories={categories} selectedIds={selectedIds} query={query} expanded={expanded} onExpanded={updateExpansion} onChange={replace} showDetails />
  </section>;
}

function SummaryMetric({ value, label, tone = '' }: { value: number; label: string; tone?: string }) { return <div className={`tool-metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>; }

function GroupedToolChecklist({ tools, categories, selectedIds, query = '', expanded = {}, onExpanded, onChange, showDetails = false }: { tools: AgentToolDescriptor[]; categories: AgentToolCategoryDescriptor[]; selectedIds: string[]; query?: string; expanded?: Record<string, boolean>; onExpanded?: (id: string, open: boolean) => void; onChange: (ids: string[]) => void; showDetails?: boolean }) {
  const needle = query.trim().toLowerCase();
  const matches = (tool: AgentToolDescriptor) => `${tool.name} ${tool.id} ${tool.description} ${tool.categoryId} ${JSON.stringify(tool.inputSchema)} ${tool.risks.join(' ')}`.toLowerCase().includes(needle);
  const groups = categories.map((category) => ({ category, all: tools.filter((tool) => tool.categoryId === category.id), visible: tools.filter((tool) => tool.categoryId === category.id && matches(tool)) })).filter(({ visible }) => !needle || visible.length);
  const grant = (ids: string[], enabled: boolean) => onChange(enabled ? [...new Set([...selectedIds, ...ids])] : selectedIds.filter((id) => !ids.includes(id)));
  if (!groups.length) return <div className="tool-empty"><strong>No matching tools</strong><span>Try a tool name, permission type, input, or risk such as “network”.</span></div>;
  return <div className={`tool-categories ${showDetails ? '' : 'compact'}`}>{groups.map(({ category, all, visible }) => {
    const enabled = all.filter((tool) => selectedIds.includes(tool.id)).length; const open = Boolean(needle) || expanded[category.id] !== false;
    return <section className="tool-category" key={category.id}>
      <header><button className="tool-category-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${category.name}`} aria-expanded={open} onClick={() => onExpanded?.(category.id, !open)}>{open ? '−' : '+'}</button><input type="checkbox" aria-label={`Toggle all ${category.name} tools`} ref={(node) => { if (node) node.indeterminate = enabled > 0 && enabled < all.length; }} checked={enabled === all.length && all.length > 0} onChange={(event) => { const adding = event.target.checked; const risky = all.some((tool) => !isSafeTool(tool)); if (!adding || !risky || window.confirm(`Enable all ${category.name} tools? This group includes elevated permissions.`)) grant(all.filter((tool) => tool.available && !tool.locked).map((tool) => tool.id), adding); }} /><div><strong>{category.name}</strong><small>{category.description}</small></div><span className="category-count">{enabled} of {all.length}</span>{enabled > 0 && <button className="ghost category-clear" onClick={() => grant(all.map((tool) => tool.id), false)}>Clear</button>}</header>
      {open && <div className="tool-list">{visible.map((tool) => <ToolRow key={tool.id} tool={tool} checked={selectedIds.includes(tool.id) || Boolean(tool.locked)} showDetails={showDetails} onToggle={() => grant([tool.id], !selectedIds.includes(tool.id))} />)}</div>}
    </section>;
  })}</div>;
}

function ToolRow({ tool, checked, showDetails, onToggle }: { tool: AgentToolDescriptor; checked: boolean; showDetails: boolean; onToggle: () => void }) {
  const content = <><input type="checkbox" disabled={!tool.available || tool.locked} checked={checked} onClick={(event) => event.stopPropagation()} onChange={onToggle} /><span><strong>{tool.name}{tool.locked ? ' · Required' : ''}</strong><small>{tool.description}</small></span><div className="risk-tags">{tool.risks.map((risk) => <b className={`risk-${risk}`} key={risk}>{riskLabel(risk)}</b>)}</div></>;
  if (!showDetails) return <label className={!tool.available ? 'unavailable' : ''}>{content}</label>;
  return <details className={!tool.available ? 'unavailable' : ''}><summary>{content}</summary><div className="tool-detail"><span><b>Tool ID</b>{tool.id}</span><span><b>Stages</b>{tool.stages.join(', ')}</span><span><b>Availability</b>{tool.available ? 'Available' : tool.availabilityReason || 'Unavailable'}</span><span><b>Side effects</b>{riskLabel(tool.sideEffectScope)}</span><span><b>Credentials</b>{tool.credentialSlots.join(', ') || 'None'}</span><code>{JSON.stringify(tool.inputSchema, null, 2)}</code></div></details>;
}

function isSafeTool(tool: AgentToolDescriptor) { return tool.available && tool.sideEffectScope === 'none' && !tool.risks.includes('secret'); }
function riskLabel(value: string) { return ({ read: 'Read only', write: 'Workspace write', execute: 'Runs code', network: 'Network', secret: 'Uses secrets', external_action: 'External action', none: 'None', workspace: 'Workspace only', external: 'External systems' } as Record<string, string>)[value] || value; }
function readExpansionPreference(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem('agent-tool-categories') || '{}'); } catch { return {}; } }

function LegacyToolsTab({ tools, categories, profiles, selected, onSelect, onChange }: { tools: AgentToolDescriptor[]; categories: AgentToolCategoryDescriptor[]; profiles: AgentProfile[]; selected?: AgentProfile; onSelect: (id: string) => void; onChange: (profile: AgentProfile) => void }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('agent-tool-categories') || '{}'));
  const needle: any = query.trim().toLowerCase();
  const matches = (tool: AgentToolDescriptor) => `${tool.name} ${tool.id} ${tool.description} ${tool.categoryId} ${JSON.stringify(tool.inputSchema || {})} ${tool.risks.join(' ')}`.toLowerCase().includes(needle);
  const ordered = categories.length ? categories : [...new Set(tools.map((tool) => tool.categoryId))].map((id, order) => ({ id, name: id, description: '', order }));
  const grant = (ids: string[], enabled: boolean) => selected && onChange({ ...selected, toolIds: enabled ? [...new Set([...selected.toolIds, ...ids])] : selected.toolIds.filter((id) => !ids.includes(id)) });
  const setOpen = (id: string, open: boolean) => { const next = { ...expanded, [id]: open }; setExpanded(next); localStorage.setItem('agent-tool-categories', JSON.stringify(next)); };
  const safe = tools.filter((tool) => tool.available && tool.sideEffectScope === 'none' && !tool.risks.includes('secret')).map((tool) => tool.id);
  return <section className="agents-section"><div className="section-heading"><div><h2>Tool permissions</h2><p>Permissions are enforced by the Tool Broker. Stage and workspace safety ceilings still apply.</p></div><select value={selected?.id || ''} onChange={(event) => onSelect(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div><input className="agent-search" value={query} placeholder="Search the global tool directory…" onChange={(event) => setQuery(event.target.value)} />
    <div className="tool-summary"><strong>{selected?.toolIds.length || 0} grants</strong><span>{selected?.toolIds.filter((id) => tools.find((tool) => tool.id === id)?.risks.includes('network')).length || 0} network</span><span>{selected?.toolIds.filter((id) => tools.find((tool) => tool.id === id)?.sideEffectScope === 'workspace').length || 0} workspace-write/execution</span><button disabled={!selected} onClick={() => grant(safe, true)}>Enable safe tools</button></div>
    <div className="tool-categories">{ordered.sort((a, b) => a.order - b.order).map((category) => { const all = tools.filter((tool) => tool.categoryId === category.id); const visible = all.filter(matches); if (needle && !visible.length) return null; const enabled = all.filter((tool) => selected?.toolIds.includes(tool.id)).length; const open = needle || expanded[category.id] !== false; return <section className="tool-category" key={category.id}><header><button className="tool-category-toggle" onClick={() => setOpen(category.id, !open)} aria-expanded={open}>{open ? '▾' : '▸'}</button><input type="checkbox" aria-label={`Toggle ${category.name}`} ref={(node) => { if (node) node.indeterminate = enabled > 0 && enabled < all.length; }} checked={all.length > 0 && enabled === all.length} onChange={(event) => { const adding = event.target.checked; const risky = all.some((tool) => tool.sideEffectScope !== 'none' || tool.risks.includes('secret')); if (!adding || !risky || window.confirm(`Enable ${category.name} tools with workspace or external side effects?`)) grant(all.filter((tool) => tool.available && !tool.locked).map((tool) => tool.id), adding); }} /><div><strong>{category.name}</strong><small>{enabled}/{all.length} enabled · {category.description}</small></div><button className="ghost" onClick={() => grant(all.map((tool) => tool.id), false)}>Clear category</button></header>{open && <div className="tool-list">{visible.map((tool) => <details className={!tool.available ? 'unavailable' : ''} key={tool.id}><summary><input type="checkbox" disabled={!selected || !tool.available || tool.locked} checked={Boolean(selected?.toolIds.includes(tool.id) || tool.locked)} onClick={(event) => event.stopPropagation()} onChange={() => selected && onChange({ ...selected, toolIds: toggle(selected.toolIds, tool.id) })} /><span><strong>{tool.name}{tool.locked ? ' · required' : ''}</strong><small>{tool.id} · {tool.description}</small></span>{tool.risks.map((risk) => <b key={risk}>{risk}</b>)}</summary><div className="tool-detail"><span>Stages: {tool.stages.join(', ')}</span><span>Availability: {tool.available ? 'available' : tool.availabilityReason || 'unavailable'}</span><span>Side effects: {tool.sideEffectScope}</span><span>Runtime: {tool.runtimeCapability || tool.runtimeToolId || tool.id}</span><span>Credentials: {tool.credentialSlots.join(', ') || 'none'}</span><code>{JSON.stringify(tool.inputSchema || { type: 'object', properties: {} }, null, 2)}</code></div></details>)}</div>}</section>; })}</div>
  </section>;
}

function ResourcesTab({ snapshot, onChange }: { snapshot: AgentConfigurationSnapshot; onChange: (value: AgentConfigurationSnapshot) => void }) {
  const addSkill = () => { const now = new Date().toISOString(); onChange({ ...snapshot, skills: [...snapshot.skills, { id: crypto.randomUUID(), name: 'New skill', description: '', instructions: '', capabilities: [], requiredToolIds: [], requiredSecretKinds: [], contextIds: [], enabled: true, revision: 0, createdAt: now, updatedAt: now }] }); };
  const addContext = () => { const now = new Date().toISOString(); onChange({ ...snapshot, contexts: [...snapshot.contexts, { id: crypto.randomUUID(), name: 'New context', description: '', scope: 'global', content: '', enabled: true, revision: 0, createdAt: now, updatedAt: now }] }); };
  return <section className="agents-section resource-columns"><div><div className="section-heading"><div><h2>Skills</h2><p>Reusable declarative instructions. Skills do not grant tools.</p></div><button onClick={addSkill}>Add skill</button></div>{snapshot.skills.map((skill) => <ResourceCard key={skill.id} title={skill.name} enabled={skill.enabled} onEnabled={(enabled) => onChange({ ...snapshot, skills: snapshot.skills.map((item) => item.id === skill.id ? { ...item, enabled } : item) })} onDelete={() => onChange({ ...snapshot, skills: snapshot.skills.filter((item) => item.id !== skill.id) })}><Field label="Name"><input value={skill.name} onChange={(event) => onChange({ ...snapshot, skills: snapshot.skills.map((item) => item.id === skill.id ? { ...item, name: event.target.value } : item) })} /></Field><Field label="Instructions"><textarea rows={5} value={skill.instructions} onChange={(event) => onChange({ ...snapshot, skills: snapshot.skills.map((item) => item.id === skill.id ? { ...item, instructions: event.target.value } : item) })} /></Field><Field label="Capabilities"><input value={skill.capabilities.join(', ')} onChange={(event) => onChange({ ...snapshot, skills: snapshot.skills.map((item) => item.id === skill.id ? { ...item, capabilities: csv(event.target.value) } : item) })} /></Field></ResourceCard>)}</div>
    <div><div className="section-heading"><div><h2>Context</h2><p>Model-visible information. Never place keys or credentials here.</p></div><button onClick={addContext}>Add context</button></div>{snapshot.contexts.map((context) => <ResourceCard key={context.id} title={context.name} enabled={context.enabled} onEnabled={(enabled) => onChange({ ...snapshot, contexts: snapshot.contexts.map((item) => item.id === context.id ? { ...item, enabled } : item) })} onDelete={() => onChange({ ...snapshot, contexts: snapshot.contexts.filter((item) => item.id !== context.id) })}><Field label="Name"><input value={context.name} onChange={(event) => onChange({ ...snapshot, contexts: snapshot.contexts.map((item) => item.id === context.id ? { ...item, name: event.target.value } : item) })} /></Field><Field label="Scope"><select value={context.scope} onChange={(event) => onChange({ ...snapshot, contexts: snapshot.contexts.map((item) => item.id === context.id ? { ...item, scope: event.target.value as AgentContextResource['scope'] } : item) })}><option value="global">Global</option><option value="workspace">Workspace</option></select></Field><Field label="Inline context"><textarea rows={5} value={context.content || ''} onChange={(event) => onChange({ ...snapshot, contexts: snapshot.contexts.map((item) => item.id === context.id ? { ...item, content: event.target.value } : item) })} /></Field><Field label="Workspace file globs"><input value={(context.fileGlobs || []).join(', ')} onChange={(event) => onChange({ ...snapshot, contexts: snapshot.contexts.map((item) => item.id === context.id ? { ...item, fileGlobs: csv(event.target.value) } : item) })} /></Field></ResourceCard>)}</div>
  </section>;
}

function SecretsTab({ secrets, workspaceId, profiles, reload, report }: { secrets: AgentSecretMetadata[]; workspaceId?: string; profiles: AgentProfile[]; reload: () => Promise<void>; report: (reason: unknown) => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState('api_key'); const [value, setValue] = useState(''); const [scope, setScope] = useState<'global' | 'workspace'>(workspaceId ? 'workspace' : 'global'); const [exposure, setExposure] = useState<'tool_only' | 'model_readable'>('tool_only'); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); try { await createAgentSecret({ name, kind, value, scope, exposure }); setName(''); setValue(''); await reload(); } catch (reason) { report(reason); } finally { setBusy(false); } };
  return <section className="agents-section"><div className="section-heading"><div><h2>Secret vault</h2><p>Stored values are never returned to this interface. Replace a value; it cannot be revealed.</p></div></div><div className="secret-create"><input value={name} placeholder="Credential name" onChange={(event) => setName(event.target.value)} /><input value={kind} placeholder="Kind (for example api_key)" onChange={(event) => setKind(event.target.value)} /><input type="password" autoComplete="new-password" value={value} placeholder="Secret value" onChange={(event) => setValue(event.target.value)} /><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="global">Global</option>{workspaceId && <option value="workspace">This workspace</option>}</select><select value={exposure} onChange={(event) => setExposure(event.target.value as typeof exposure)}><option value="tool_only">Tool only · recommended</option><option value="model_readable">Model readable · advanced</option></select><button disabled={busy || !name.trim() || !value} onClick={() => void create()}>Store secret</button></div>{exposure === 'model_readable' && <div className="agents-warning">Model-readable secrets may be sent to the configured model provider when an authorized agent requests them. Prefer tool-only bindings.</div>}
    <div className="secret-list">{secrets.map((secret) => <SecretRow key={secret.id} secret={secret} profiles={profiles} reload={reload} report={report} />)}{!secrets.length && <div className="agents-empty">No credentials configured.</div>}</div>
  </section>;
}

function SecretRow({ secret, profiles, reload, report }: { secret: AgentSecretMetadata; profiles: AgentProfile[]; reload: () => Promise<void>; report: (reason: unknown) => void }) {
  const [replacement, setReplacement] = useState(''); const [working, setWorking] = useState(false);
  const run = async (operation: () => Promise<unknown>) => { setWorking(true); try { await operation(); setReplacement(''); await reload(); } catch (reason) { report(reason); } finally { setWorking(false); } };
  return <article><div><strong>{secret.name}</strong><small>{secret.kind} · {secret.scope} · {secret.exposure === 'tool_only' ? 'tool only' : 'model readable'}</small></div><code>••••••••••••</code><input type="password" value={replacement} placeholder="Replacement value" onChange={(event) => setReplacement(event.target.value)} /><select multiple value={secret.agentIds} title="Agents authorized to use this secret" onChange={(event) => { const grants = [...event.currentTarget.selectedOptions].map((option) => option.value); void run(() => updateAgentSecret(secret.id, { grants })); }}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><button disabled={working || !replacement} onClick={() => void run(() => updateAgentSecret(secret.id, { value: replacement }))}>Replace</button><button className="danger" disabled={working} onClick={() => { if (window.confirm(`Delete credential “${secret.name}”?`)) void run(() => deleteAgentSecret(secret.id)); }}>Delete</button></article>;
}

function RoutingTab({ snapshot, tools, categories, onChange }: { snapshot: AgentConfigurationSnapshot; tools: AgentToolDescriptor[]; categories: AgentToolCategoryDescriptor[]; onChange: (value: AgentConfigurationSnapshot) => void }) {
  const [objective, setObjective] = useState(''); const [stage, setStage] = useState<AgentStage>('coder'); const [capabilities, setCapabilities] = useState(''); const [requiredTools, setRequiredTools] = useState<string[]>([]); const [result, setResult] = useState<RoutingSimulation>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const simulate = async () => { setBusy(true); setError(''); try { setResult(await simulateAgentRouting({ objective, stage, requiredCapabilities: csv(capabilities), requiredTools })); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  return <section className="agents-section"><div className="section-heading"><div><h2>Selection policy</h2><p>Security and eligibility are filtered first. Routing scores only the remaining candidates.</p></div></div>
    <div className="agent-form-grid"><Field label="Mode"><select value={snapshot.routing.mode} onChange={(event) => onChange({ ...snapshot, routing: { ...snapshot.routing, mode: event.target.value as typeof snapshot.routing.mode } })}><option value="automatic">Automatic</option><option value="priority_first">Priority first</option><option value="ask_on_overlap">Ask on overlap</option></select></Field><Field label="Tie threshold"><input type="number" min={0} max={25} value={snapshot.routing.tieThreshold} onChange={(event) => onChange({ ...snapshot, routing: { ...snapshot.routing, tieThreshold: Number(event.target.value) } })} /></Field></div>
    <div className="routing-simulator"><h3>Routing simulator</h3><Field label="Example task"><textarea rows={4} value={objective} placeholder="Describe a task to see which agent would be selected…" onChange={(event) => setObjective(event.target.value)} /></Field><div className="agent-form-grid"><Field label="Stage"><select value={stage} onChange={(event) => setStage(event.target.value as AgentStage)}>{STAGES.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Required capabilities"><input value={capabilities} placeholder="react, accessibility" onChange={(event) => setCapabilities(event.target.value)} /></Field></div>
      <fieldset><legend>Required tools <span>{requiredTools.length ? `· ${requiredTools.length} selected` : '· optional'}</span></legend><GroupedToolChecklist tools={tools} categories={categories} selectedIds={requiredTools} expanded={expanded} onExpanded={(id, open) => setExpanded((current) => ({ ...current, [id]: open }))} onChange={setRequiredTools} /></fieldset>
      <button disabled={busy || !objective.trim()} onClick={() => void simulate()}>{busy ? 'Simulating…' : 'Simulate routing'}</button>{error && <div className="agents-error">{error}</div>}{result && <RoutingResult result={result} />}
    </div>
  </section>;
}

function LegacyRoutingTab({ snapshot, tools, categories, onChange }: { snapshot: AgentConfigurationSnapshot; tools: AgentToolDescriptor[]; categories: AgentToolCategoryDescriptor[]; onChange: (value: AgentConfigurationSnapshot) => void }) {
  const [objective, setObjective] = useState(''); const [stage, setStage] = useState<AgentStage>('coder'); const [capabilities, setCapabilities] = useState(''); const [requiredTools, setRequiredTools] = useState<string[]>([]); const [result, setResult] = useState<RoutingSimulation>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const simulate = async () => { setBusy(true); setError(''); try { setResult(await simulateAgentRouting({ objective, stage, requiredCapabilities: csv(capabilities), requiredTools })); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
  return <section className="agents-section"><div className="section-heading"><div><h2>Selection policy</h2><p>Security and eligibility are filtered first. Routing scores only the remaining candidates.</p></div></div><div className="agent-form-grid"><Field label="Mode"><select value={snapshot.routing.mode} onChange={(event) => onChange({ ...snapshot, routing: { ...snapshot.routing, mode: event.target.value as typeof snapshot.routing.mode } })}><option value="automatic">Automatic</option><option value="priority_first">Priority first</option><option value="ask_on_overlap">Ask on overlap</option></select></Field><Field label="Tie threshold"><input type="number" min={0} max={25} value={snapshot.routing.tieThreshold} onChange={(event) => onChange({ ...snapshot, routing: { ...snapshot.routing, tieThreshold: Number(event.target.value) } })} /></Field></div>
    <div className="routing-simulator"><h3>Routing simulator</h3><Field label="Example task"><textarea rows={4} value={objective} placeholder="Describe a task to see which agent would be selected…" onChange={(event) => setObjective(event.target.value)} /></Field><div className="agent-form-grid"><Field label="Stage"><select value={stage} onChange={(event) => setStage(event.target.value as AgentStage)}>{STAGES.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Required capabilities"><input value={capabilities} placeholder="react, accessibility" onChange={(event) => setCapabilities(event.target.value)} /></Field></div><fieldset><legend>Required tools</legend><div className="agent-check-grid compact">{tools.map((tool) => <Check key={tool.id} label={tool.name} checked={requiredTools.includes(tool.id)} onChange={() => setRequiredTools(toggle(requiredTools, tool.id))} />)}</div></fieldset><button disabled={busy || !objective.trim()} onClick={() => void simulate()}>{busy ? 'Simulating…' : 'Simulate routing'}</button>{error && <div className="agents-error">{error}</div>}{result && <RoutingResult result={result} />}</div>
  </section>;
}

function RoutingResult({ result }: { result: RoutingSimulation }) { const selected = result.candidates.find((candidate) => candidate.agentId === result.selectedAgentId); return <div className="routing-result"><h3>{result.requiresUserChoice ? 'User choice required' : selected?.agentName || result.selectedAgentId || 'No eligible agent'}</h3>{result.reason && <p>{result.reason}</p>}{result.candidates.map((candidate) => <div key={candidate.agentId}><strong>{candidate.agentName}</strong><span>{candidate.eligible ? `Score ${candidate.score ?? '—'}` : 'Excluded'}</span><small>{[...candidate.reasons, ...candidate.exclusions].join(' · ')}</small></div>)}</div>; }

function ResourceCard({ title, enabled, onEnabled, onDelete, children }: { title: string; enabled: boolean; onEnabled: (value: boolean) => void; onDelete: () => void; children: ReactNode }) { return <article className="resource-card"><header><strong>{title}</strong><label><input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} /> Enabled</label><button className="danger" onClick={onDelete}>Delete</button></header>{children}</article>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="agent-field"><span>{label}</span>{children}</label>; }
function Toggle({ checked, label, detail, onChange }: { checked: boolean; label: string; detail: string; onChange: (value: boolean) => void }) { return <label className="agent-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{label}</strong><small>{detail}</small></span></label>; }
function Check({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) { return <label className="agent-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} /><span>{label}</span></label>; }
function csv(value: string) { return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]; }
function toggle<T>(values: T[], value: T) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
