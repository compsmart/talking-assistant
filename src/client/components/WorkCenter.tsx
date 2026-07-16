import { useMemo, useState } from 'react';
import type { ActivityEvent, WorkItemSnapshot } from '../../shared/protocol';

interface Props { open: boolean; works: WorkItemSnapshot[]; events: Record<string, ActivityEvent[]>; onClose: () => void; onCancel: (id: string) => void; onApprove: (work: WorkItemSnapshot) => void; onAnswer: (workId: string, questionId: string, answer: string) => void }
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'superseded']);

export function WorkCenter({ open, works, events, onClose, onCancel, onApprove, onAnswer }: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const sorted = useMemo(() => [...works].sort((a, b) => Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) || b.updatedAt.localeCompare(a.updatedAt)), [works]);
  const selected = sorted.find((item) => item.id === selectedId) || sorted[0];
  return <aside className={`work-center ${open ? 'open' : ''}`} aria-hidden={!open}>
    <header><div><span className="terminal-dot" /> WORK CENTER <small>{works.filter((work) => !TERMINAL.has(work.status)).length} active</small></div><button onClick={onClose}>Close</button></header>
    <div className="work-center-body">
      <nav className="work-list" aria-label="Agent work">
        {!sorted.length && <p>No delegated work yet.</p>}
        {sorted.map((work) => <button key={work.id} className={work.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(work.id)}>
          <span className={`work-status ${work.status}`} />
          <div><strong>{work.request.objective}</strong><small>{work.status}{work.queuePosition ? ` · queued #${work.queuePosition}` : ''} · revision {work.specRevision}</small></div>
          {!!work.attempts.filter((attempt) => attempt.status === 'running').length && <b>{work.attempts.filter((attempt) => attempt.status === 'running').length}</b>}
        </button>)}
      </nav>
      <section className="work-detail">{selected ? <>
        <div className="work-detail-title"><div><span>{selected.status.replaceAll('_', ' ')}</span><h2>{selected.request.objective}</h2><small>{selected.id}</small></div><div>{selected.status === 'awaiting_approval' && selected.plan && <button className="continue" onClick={() => onApprove(selected)}>Approve plan</button>}{!TERMINAL.has(selected.status) && <button onClick={() => onCancel(selected.id)}>Cancel</button>}</div></div>
        {selected.request.successCriteria?.length ? <div className="work-criteria"><strong>Success criteria</strong>{selected.request.successCriteria.map((item) => <span key={item}>✓ {item}</span>)}</div> : null}
        {selected.questions.filter((question) => !question.answeredAt).map((question) => <div className="work-question" key={question.id}>
          <strong>Action needed</strong><p>{question.prompt}</p>
          {!!question.options?.length && <div className="work-question-options">{question.options.map((option) => <button key={option} className="continue" onClick={() => onAnswer(selected.id, question.id, option)}>{option}</button>)}</div>}
          <form onSubmit={(event) => { event.preventDefault(); const answer = answers[question.id]?.trim(); if (answer) { onAnswer(selected.id, question.id, answer); setAnswers((current) => ({ ...current, [question.id]: '' })); } }}>
            <input aria-label="Answer task question" value={answers[question.id] || ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Type an answer" />
            <button className="continue" type="submit">Answer</button>
          </form>
        </div>)}
        <div className="work-agents"><h3>Agent activity</h3>{!selected.attempts.length && <p>Coordination is preparing this task.</p>}{selected.attempts.map((attempt) => <article key={attempt.id} className={attempt.status}><span className={`work-status ${attempt.status}`} /><div><strong>{attempt.agentName || attempt.role}</strong><small>{attempt.role} · {attempt.status} · {attempt.id.slice(0, 8)}{attempt.profileRevision ? ` · profile r${attempt.profileRevision}` : ''}</small>{attempt.routingReason && <p className="work-routing-reason">{attempt.routingReason}</p>}{attempt.summary && <p>{attempt.summary}</p>}{attempt.error && <p className="error-text">{attempt.error}</p>}</div><b>{attempt.changedFiles.length ? `${attempt.changedFiles.length} files` : ''}</b></article>)}</div>
        {!!events[selected.id]?.length && <div className="work-timeline"><h3>Timeline</h3>{events[selected.id].slice(-150).map((event) => <div key={`${event.taskId}:${event.seq}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.phase}</span><p>{event.message}</p></div>)}</div>}
        {selected.result && <div className={`work-result ${selected.result.status}`}><strong>{selected.result.status}</strong><p>{selected.result.summary}</p>{selected.result.commit && <code>{selected.result.commit}</code>}</div>}
      </> : <p>Select a task.</p>}</section>
    </div>
  </aside>;
}
