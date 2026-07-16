import { useEffect, useMemo, useState } from 'react';
import type { MediaArtifact, MediaJobSnapshot, MediaStageName } from '../../shared/protocol';
import { getMediaJob, rerunMediaStage, saveMediaJob, updateMediaSettings, watchMediaJob } from '../media/MediaClient';

interface Props { jobId: string; onClose: () => void; onSaved: (paths: string[], previewVersion?: string) => void; onError: (message: string) => void }
const LABELS: Record<MediaStageName, string> = { brief: '1. Brief and references', normalize: '2. Start/end frames and green stage', generate: '3. Generated video and sound', extract: '4. Extracted frame filmstrip', matte: '5. Background removal and alpha', encode: '6. Final animation and publishing', publish: 'Published revision' };

export default function AnimationEditorPanel({ jobId, onClose, onSaved, onError }: Props) {
  const [job, setJob] = useState<MediaJobSnapshot>(); const [advanced, setAdvanced] = useState(false); const [background, setBackground] = useState<'checker' | 'light' | 'dark'>('checker'); const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void getMediaJob(jobId).then((value) => active && setJob(value)).catch((error) => onError(error.message)); const stop = watchMediaJob(jobId, (value) => active && setJob(value)); return () => { active = false; stop(); }; }, [jobId, onError]);
  const grouped = useMemo(() => new Map(job?.stages.map((stage) => [stage.name, job.artifacts.filter((artifact) => artifact.stage === stage.name)]) || []), [job]);
  if (!job) return <aside className="animation-editor open"><header><strong>ANIMATION EDITOR</strong><button onClick={onClose}>Close</button></header><div className="animation-editor-loading">Loading media job…</div></aside>;
  const act = async (operation: () => Promise<MediaJobSnapshot>) => { setBusy(true); try { setJob(await operation()); } catch (error) { onError((error as Error).message); } finally { setBusy(false); } };
  return <aside className="animation-editor open" aria-label="Animation editor">
    <header><div><strong>ANIMATION EDITOR</strong><small>{job.status} · revision {job.revision}</small></div><button onClick={onClose}>Close</button></header>
    <div className="animation-editor-body">
      {job.stages.filter((stage) => stage.name !== 'publish').map((stage) => <section className={`media-stage ${stage.status}`} key={stage.name}>
        <div className="media-stage-title"><h3>{LABELS[stage.name]}</h3><span>{stage.status} {stage.progress ? `${stage.progress}%` : ''}</span></div>
        {stage.name === 'brief' && <div className="media-brief"><p>{job.request.prompt}</p><small>Start: {'startFrame' in job.request ? job.request.startFrame || 'none' : 'n/a'} · End: {'endFrame' in job.request ? job.request.endFrame || job.request.startFrame || 'none' : 'n/a'}</small></div>}
        <ArtifactGrid artifacts={grouped.get(stage.name) || []} background={background} />
        {stage.name === 'matte' && <div className="matte-controls">
          <label>Stage color <input type="color" value={job.settings.matte.backgroundColor} onChange={(event) => setJob({ ...job, settings: { ...job.settings, matte: { ...job.settings.matte, backgroundColor: event.target.value } } })} /></label>
          <label>Tolerance <input type="range" min="0" max="255" value={job.settings.matte.tolerance} onChange={(event) => setJob({ ...job, settings: { ...job.settings, matte: { ...job.settings.matte, tolerance: Number(event.target.value) } } })} /><output>{job.settings.matte.tolerance}</output></label>
          <label>Feather <input type="range" min="0" max="4" value={job.settings.matte.feather} onChange={(event) => setJob({ ...job, settings: { ...job.settings, matte: { ...job.settings.matte, feather: Number(event.target.value) } } })} /></label>
          <label>Despill <input type="range" min="0" max="1" step="0.1" value={job.settings.matte.despill} onChange={(event) => setJob({ ...job, settings: { ...job.settings, matte: { ...job.settings.matte, despill: Number(event.target.value) } } })} /></label>
          <label className="matte-checkbox">Whole frame <input type="checkbox" checked={!job.settings.matte.edgeConnected} onChange={(event) => setJob({ ...job, settings: { ...job.settings, matte: { ...job.settings.matte, edgeConnected: !event.target.checked } } })} /><output>{job.settings.matte.edgeConnected ? 'Edges only' : 'Includes holes'}</output></label>
          <div className="preview-backgrounds">Preview {(['checker', 'light', 'dark'] as const).map((item) => <button className={background === item ? 'active' : ''} key={item} onClick={() => setBackground(item)}>{item}</button>)}</div>
          <button disabled={busy} onClick={() => void act(async () => { const updated = await updateMediaSettings(job.id, job.revision, { matte: job.settings.matte }); return rerunMediaStage(updated.id, 'matte', updated.revision); })}>Reprocess matte</button>
        </div>}
        {stage.name === 'generate' && <button disabled title="Model regeneration incurs another API call and requires a new confirmed job.">Regenerate model output…</button>}
        {stage.status === 'failed' && <p className="media-stage-error">{stage.error || job.error}</p>}
      </section>)}
      <details open={advanced} onToggle={(event) => setAdvanced((event.currentTarget as HTMLDetailsElement).open)}><summary>Advanced</summary>
        <dl className="advanced-grid"><dt>Media model</dt><dd>Configured server model</dd><dt>Frame timing</dt><dd>{job.settings.encoding.frameCount} frames · {job.settings.encoding.fps} FPS · 4 seconds</dd><dt>Encoding</dt><dd>{job.settings.encoding.lossless ? 'Lossless WebP' : `Quality ${job.settings.encoding.quality}`}</dd><dt>Edge-connected matte</dt><dd>{job.settings.matte.edgeConnected ? 'Enabled' : 'Disabled'}</dd></dl>
      </details>
    </div>
    <footer><div>{job.stablePaths.join(' + ')}</div><button className="primary" disabled={busy || !['review', 'completed'].includes(job.status)} onClick={() => void act(async () => { const saved = await saveMediaJob(job.id, job.revision, job.selectedRevision); onSaved(saved.stablePaths, saved.previewVersion); return saved; })}>Save changes</button></footer>
  </aside>;
}

function ArtifactGrid({ artifacts, background }: { artifacts: MediaArtifact[]; background: string }) { if (!artifacts.length) return null; return <div className={`artifact-grid ${background}`}>{artifacts.map((artifact) => <figure key={artifact.id}>{artifact.type === 'video' ? <video src={artifact.url} controls playsInline /> : artifact.type === 'audio' ? <audio src={artifact.url} controls /> : <img src={artifact.url} alt={artifact.label} />}<figcaption>{artifact.label}</figcaption></figure>)}</div>; }
