import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, AgentRunSnapshot, MediaJobSnapshot } from '../../shared/protocol';
import { cancelMediaJob, listMediaJobs } from '../media/MediaClient';

interface Props { open: boolean; task?: AgentRunSnapshot; events: ActivityEvent[]; onClose: () => void; onContinue: () => void; onCancel: () => void; onOpenMedia: (id: string) => void }

export function AgentTerminal({ open, task, events, onClose, onContinue, onCancel, onOpenMedia }: Props) {
  const output = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [media, setMedia] = useState<MediaJobSnapshot[]>([]);
  useEffect(() => { if (!open) return; let active = true; const refresh = () => void listMediaJobs().then((jobs) => active && setMedia(jobs)).catch(() => undefined); refresh(); const timer = window.setInterval(refresh, 2000); return () => { active = false; clearInterval(timer); }; }, [open]);
  useEffect(() => {
    if (open && pinned.current) output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [events, open, task]);
  const running = task && !['completed', 'failed', 'cancelled'].includes(task.status);
  const todos = task?.kind === 'coding' ? task.todos : [];
  const title = task?.kind === 'planning' ? 'PLANNING AGENT' : 'CODING AGENT';
  const awaitingContinuation = task?.kind === 'planning' && task.status === 'awaiting_continuation';
  return (
    <aside className={`agent-terminal ${open ? 'open' : ''}`} aria-hidden={!open}>
      <header>
        <div><span className="terminal-dot" /> {title} <small>{task?.status || 'idle'}</small></div>
        <div>{awaitingContinuation && <button className="continue" onClick={onContinue}>Continue</button>}{running && <button onClick={onCancel}>{awaitingContinuation ? 'Stop' : 'Cancel'}</button>}<button onClick={onClose}>Close</button></div>
      </header>
      {awaitingContinuation && task.continuation && <div className="terminal-continuation"><strong>Continue planning?</strong><span>{task.continuation.message}</span><small>Run {task.id} · segment {task.continuation.segment} · {task.continuation.interactionCount} interactions preserved</small></div>}
      {!!todos.length && <div className="terminal-todos" aria-label="Implementation progress">{todos.map((todo) => <div className={`terminal-todo ${todo.status}`} key={todo.id}><span>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'blocked' ? '!' : '○'}</span><div><strong>{todo.text}</strong>{todo.note && <small>{todo.note}</small>}</div></div>)}</div>}
      {!!media.length && <div className="terminal-media" aria-label="Media agent jobs">{media.map((job) => <article className={`media-job-card ${job.status}`} key={job.id}><div><strong>{job.request.kind}: {job.request.name}</strong><small>{job.status} · {Math.max(...job.stages.map((stage) => stage.progress))}%</small></div><div>{!['completed', 'failed', 'cancelled'].includes(job.status) && <button onClick={() => void cancelMediaJob(job.id)}>Cancel</button>}{job.request.kind === 'animation' && <button onClick={() => onOpenMedia(job.id)}>Open Editor</button>}</div></article>)}</div>}
      <div className={`terminal-output ${todos.length ? 'with-todos' : ''}`} ref={output} onScroll={() => {
        const el = output.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {!events.length && <div className="terminal-empty">Activity will appear here while the agent works.</div>}
        {events.map((event) => (
          <div className={`terminal-line kind-${event.kind}`} key={`${event.taskId}:${event.seq}`}>
            <time>{new Date(event.at).toLocaleTimeString()}</time>
            <span className="terminal-kind">{event.kind.replace('_', ' ')}</span>
            <pre>{event.message}</pre>
          </div>
        ))}
      </div>
    </aside>
  );
}
