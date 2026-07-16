const baseUrl = process.env.PERF_BASE_URL || 'http://127.0.0.1:3000';
const runs = Math.max(1, Number(process.env.PERF_RUNS || 10));
const objectives = process.env.TARGETED_PERF_OBJECTIVES
  ? JSON.parse(process.env.TARGETED_PERF_OBJECTIVES)
  : [
      'Change the main page background color to #101820.',
      'Change the primary visible heading text to "Targeted edit benchmark".',
      'Increase the primary visible heading font size by 1px.',
    ];

if (!Array.isArray(objectives) || !objectives.every((item) => typeof item === 'string' && item.trim())) throw new Error('TARGETED_PERF_OBJECTIVES must be a JSON array of non-empty strings.');

const samples: Array<{ durationMs: number; firstMutationMs: number; toolCount: number }> = [];
for (let index = 0; index < runs; index++) {
  const started = Date.now(); const objective = objectives[index % objectives.length];
  const created = await request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective }) });
  let task: any = created;
  while (!task.result) { await new Promise((resolve) => setTimeout(resolve, 250)); task = await request(`/api/tasks/${created.id}`); }
  if (task.result.status !== 'completed') throw new Error(`Run ${index + 1} failed: ${task.result.summary}`);
  const performance = task.result.performance;
  if (!performance || performance.firstMutationMs === undefined) throw new Error(`Run ${index + 1} returned no performance/first-mutation telemetry.`);
  samples.push({ durationMs: Date.now() - started, firstMutationMs: performance.firstMutationMs, toolCount: performance.toolCount });
  console.log(`${index + 1}/${runs}: ${performance.firstMutationMs}ms to mutation, ${performance.toolCount} tools, ${samples.at(-1)!.durationMs}ms total`);
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2); };
console.log(JSON.stringify({ runs, medianFirstMutationMs: median(samples.map((item) => item.firstMutationMs)), medianToolCalls: median(samples.map((item) => item.toolCount)), medianEndToEndMs: median(samples.map((item) => item.durationMs)) }, null, 2));

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init); const value = await response.json();
  if (!response.ok) throw new Error(value.error || `${response.status} ${response.statusText}`); return value;
}
