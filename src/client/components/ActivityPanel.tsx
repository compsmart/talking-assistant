import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActivityEvent, ActivityRecord, RecoveryState, WorkspaceReleaseSummary } from '../../shared/protocol';
import { activateRelease, getActivity, getActivityEvents, getRecoveryState, getReleases, resolveActivity, restartPreview, restoreDraft, watchActivity } from '../activity/ActivityClient';
import { cancelPlan, cancelTask } from '../agent/TaskClient';
import { FloatingWindow } from './FloatingWindow';

interface Props {
  open: boolean; onClose: () => void; onError: (message: string) => void; onVersion: (version: string) => void;
  onReconnectLive: () => void; onOpenRun: () => void; onOpenFile: (path: string) => void; onAskLive: (message: string) => void;
}

export function ActivityPanel({ open, onClose, onError, onVersion, onReconnectLive, onOpenRun, onOpenFile, onAskLive }: Props) {
  const [records, setRecords] = useState<ActivityRecord[]>([]); const [unresolved, setUnresolved] = useState(0); const [selectedId, setSelectedId] = useState('');
  const [events, setEvents] = useState<ActivityEvent[]>([]); const [state, setState] = useState<RecoveryState>(); const [releases, setReleases] = useState<WorkspaceReleaseSummary[]>([]);
  const [scope, setScope] = useState<'active' | 'all'>('active'); const [severity, setSeverity] = useState(''); const [source, setSource] = useState(''); const [query, setQuery] = useState(''); const [busy, setBusy] = useState('');
  const selected = useMemo(() => records.find((item) => item.id === selectedId), [records, selectedId]);
  const refresh = useCallback(async (includeReleases = true) => {
    try { const [page, recovery, versions] = await Promise.all([getActivity({ scope, severity, source, query }), getRecoveryState(), includeReleases ? getReleases() : Promise.resolve(undefined)]); setRecords(page.items); setUnresolved(page.unresolved); setState(recovery); if (versions) setReleases(versions); setSelectedId((current) => current || page.items[0]?.id || ''); }
    catch (error) { onError((error as Error).message); }
  }, [onError, query, scope, severity, source]);
  useEffect(() => { if (open) void refresh(true); }, [open, refresh]);
  useEffect(() => watchActivity(() => { if (open) void refresh(false); }), [open, refresh]);
  useEffect(() => { if (!selectedId) { setEvents([]); return; } void getActivityEvents(selectedId).then(setEvents).catch((error) => onError((error as Error).message)); }, [onError, selectedId]);
  const recover = async (label: string, action: () => Promise<{ version: string }>) => { setBusy(label); try { const result = await action(); onVersion(result.version); await refresh(true); } catch (error) { onError((error as Error).message); } finally { setBusy(''); } };
  const cancelActive = async () => { if (!state?.activeRun) return; setBusy('cancel'); try { await (state.activeRun.kind === 'planning' ? cancelPlan(state.activeRun.id) : cancelTask(state.activeRun.id)); await refresh(false); } catch (error) { onError((error as Error).message); } finally { setBusy(''); } };
  if (!open) return null;
  return <FloatingWindow id="activity" title="Activity center" initial={{ x: Math.max(18, window.innerWidth - 850), y: 54, width: 820, height: 610 }} minWidth={620} minHeight={430} className="activity-window" onClose={onClose}>
    <div className="activity-center">
      <section className="activity-summary">
        <div><span className={`activity-health ${state?.lockOwner ? 'busy' : 'ok'}`} /> <strong>{state?.lockOwner ? `Locked by ${state.lockOwner}` : 'Workspace ready'}</strong><small>{unresolved} unresolved</small></div>
        <div className="activity-actions">
          <button onClick={onReconnectLive}>Reconnect Live</button><button disabled={!!busy || !!state?.lockOwner} onClick={() => void recover('preview', restartPreview)}>Restart preview</button>
          {state?.restartRequired && <button className="warning" onClick={() => void navigator.clipboard.writeText(state.restartCommand)}>Copy restart command</button>}
        </div>
        {state?.restartRequired && <p className="activity-warning">Server-side files changed after startup. Stop the server with Ctrl+C, run <code>{state.restartCommand}</code>, then reopen this panel.</p>}
        {state?.activeRun && <div className="activity-active-run"><span>{state.activeRun.kind} agent · {state.activeRun.status}</span><button onClick={onOpenRun}>Open</button><button className="danger" disabled={busy === 'cancel'} onClick={() => void cancelActive()}>Stop</button></div>}
      </section>
      <div className="activity-filters">
        <select value={scope} onChange={(event) => setScope(event.target.value as any)}><option value="active">Active workspace</option><option value="all">All workspaces</option></select>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select>
        <select value={source} onChange={(event) => setSource(event.target.value)}><option value="">All sources</option>{['live','direct-edit','coding','planning','preview','workspace','http','system','legacy'].map((value) => <option key={value}>{value}</option>)}</select>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity" /><button onClick={() => void refresh()}>Refresh</button>
      </div>
      <div className="activity-body">
        <nav className="activity-list">{!records.length && <p>No matching activity.</p>}{records.map((record) => <button key={record.id} className={`${record.id === selectedId ? 'selected' : ''} severity-${record.severity}`} onClick={() => setSelectedId(record.id)}>
          <span><strong>{record.title}</strong><time>{new Date(record.updatedAt).toLocaleString()}</time></span><small>{record.source} · {record.status}</small><em>{record.message}</em>{record.severity === 'error' && !record.resolvedAt && <i>!</i>}
        </button>)}</nav>
        <article className="activity-detail">{selected ? <>
          <header><div><span className={`activity-status severity-${selected.severity}`}>{selected.status}</span><h2>{selected.title}</h2></div><a href={`/api/activity/${encodeURIComponent(selected.id)}/export`}>Export JSONL</a></header>
          <p className="activity-message">{selected.message}</p>
          <dl><dt>Source</dt><dd>{selected.source}</dd><dt>Started</dt><dd>{new Date(selected.startedAt).toLocaleString()}</dd>{selected.durationMs !== undefined && <><dt>Duration</dt><dd>{formatDuration(selected.durationMs)}</dd></>}{selected.requestId && <><dt>Request</dt><dd>{selected.requestId}</dd></>}{selected.httpStatus && <><dt>HTTP</dt><dd>{selected.httpStatus}</dd></>}</dl>
          {!!selected.paths?.length && <div className="activity-paths"><strong>Affected files</strong>{selected.paths.map((path) => <button key={path} onClick={() => onOpenFile(path)}>{path}</button>)}</div>}
          <div className="activity-recovery">
            {selected.severity === 'error' && !selected.resolvedAt && <button onClick={() => void resolveActivity(selected.id).then(() => refresh()).catch((error) => onError((error as Error).message))}>Mark resolved</button>}
            {selected.source === 'direct-edit' && selected.status === 'failed' && <button onClick={() => onAskLive(`The direct edit failed: ${selected.message}. Re-read ${selected.paths?.join(', ') || 'the affected file'} and retry once using current file contents.`)}>Ask Live to retry</button>}
            <button disabled={!state || !state.git.dirty || !!state.lockOwner || !!busy} onClick={() => state && window.confirm(`Restore the draft from release ${state.workspaceVersion}? Current draft changes will be backed up.`) && void recover('restore', () => restoreDraft(state))}>Restore active release</button>
          </div>
          <div className="activity-events"><h3>Event timeline</h3>{!events.length && <p>No detailed events were recorded.</p>}{events.map((event) => <details key={`${event.taskId}:${event.seq}`} open={event.kind === 'error' || event.kind === 'stderr'}><summary><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.kind.replace('_', ' ')}</span>{event.phase}</summary><pre>{event.message}</pre></details>)}</div>
          <div className="activity-releases"><h3>Release rollback</h3>{releases.slice(0, 12).map((release) => <div key={release.version}><span><strong>{release.active ? 'Current' : release.version}</strong><small>{new Date(release.createdAt).toLocaleString()} · {release.changedFiles?.length || 0} file difference(s)</small></span>{!release.active && <button disabled={!state || !!state.lockOwner || !!busy} onClick={() => state && window.confirm(`Back up the current draft and activate ${release.version}?`) && void recover('rollback', () => activateRelease(release.version, state))}>Roll back</button>}</div>)}</div>
        </> : <p>Select an activity record.</p>}</article>
      </div>
    </div>
  </FloatingWindow>;
}

function formatDuration(value: number) { if (value < 1000) return `${value} ms`; if (value < 60_000) return `${(value / 1000).toFixed(1)} s`; return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s`; }
