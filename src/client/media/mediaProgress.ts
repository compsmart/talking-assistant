import type { MediaJobSnapshot, WorkItemSnapshot } from '../../shared/protocol';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'publishing']);
const TERMINAL_WORK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded']);

export interface MediaAgentProgress {
  workId?: string;
  jobId?: string;
  detail: string;
  stage: string;
  progress: number;
  activeCount: number;
}

export function deriveMediaAgentProgress(works: WorkItemSnapshot[], jobs: MediaJobSnapshot[]): MediaAgentProgress | undefined {
  const mediaWorks = works.filter((work) => !TERMINAL_WORK_STATUSES.has(work.status) && (
    work.subtasks.some((subtask) => subtask.role === 'media') || work.attempts.some((attempt) => attempt.role === 'media')
  )).sort(recentFirst);
  const mediaJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).sort(recentFirst);
  const job = mediaJobs[0]; const work = mediaWorks[0];
  if (!job && !work) return undefined;
  const runningStage = job?.stages.find((stage) => stage.status === 'running');
  const progress = job ? Math.max(0, Math.min(100, Math.max(0, ...job.stages.map((stage) => Number(stage.progress) || 0)))) : work?.status === 'queued' || work?.status === 'coordinating' ? 0 : 5;
  return {
    workId: work?.id, jobId: job?.id,
    detail: job ? `${label(job.request.kind)} · ${job.request.name}` : compact(work!.request.objective),
    stage: label(runningStage?.name || job?.status || work!.status), progress,
    activeCount: mediaWorks.length + mediaJobs.length,
  };
}

function recentFirst(a: { updatedAt?: string }, b: { updatedAt?: string }) { return Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''); }
function label(value: string) { return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function compact(value: string) { const text = value.trim().replace(/\s+/g, ' '); return text.length > 46 ? `${text.slice(0, 43)}…` : text; }
