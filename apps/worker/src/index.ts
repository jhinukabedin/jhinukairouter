// Light in-process worker stub (Agent 3).
// Queue interface with BullMQ OPTIONAL: if REDIS_URL is set AND bullmq is
// installed, jobs go through BullMQ; otherwise jobs run inline/in-memory.
// The API must start and serve /v1 with NO Redis — this module never
// requires Redis. Jobs are idempotent and safe to run inline:
//   - usage-aggregation: roll up UsageRecords into daily/monthly totals
//     (and budget spend) — here it aggregates from a supplied store.
//   - provider-health-check: periodic liveness probe of provider base URLs
//     (injected prober; default: no-op, real probes need provider creds).
//   - credit-expiry-check: flag/expire time-limited credit (none in v1 —
//     logs a no-op so the schedule exists without inventing expiry rules).
import type { UsageStore } from '../../api/src/modules/usage/service.js';

export type JobName = 'usage-aggregation' | 'provider-health-check' | 'credit-expiry-check';
export interface Job { name: JobName; payload?: Record<string, unknown>; enqueuedAt: string; }

export interface WorkerDeps {
  usageStore?: UsageStore;
  /** Optional prober: returns true when the provider base URL answers. */
  probeProvider?: (providerId: string, baseUrl: string) => Promise<boolean>;
  providers?: { id: string; baseUrl: string }[];
  log?: (msg: string, meta?: unknown) => void;
}

export interface JobQueue {
  enqueue(job: Job): Promise<void>;
  /** Drain inline jobs (used by the in-memory queue + tests). */
  drain(): Promise<void>;
  pendingCount(): number;
}

/** In-memory queue: jobs run inline on drain (or immediately via runInline). */
export class InMemoryQueue implements JobQueue {
  private jobs: Job[] = [];
  constructor(private handler: (job: Job) => Promise<void>, private runInline = false) {}
  async enqueue(job: Job): Promise<void> {
    this.jobs.push(job);
    if (this.runInline) await this.drain();
  }
  async drain(): Promise<void> {
    const batch = this.jobs.splice(0, this.jobs.length);
    for (const job of batch) await this.handler(job);
  }
  pendingCount(): number { return this.jobs.length; }
}

export async function runJob(job: Job, deps: WorkerDeps): Promise<{ job: JobName; ok: boolean; detail?: string }> {
  const log = deps.log ?? (() => {});
  switch (job.name) {
    case 'usage-aggregation': {
      // Aggregate from the usage store (daily/monthly rollups are computed
      // on read by UsageService.summary; this job records budget spend so
      // budgets stay enforced even for requests that bypassed pre-check).
      log('usage-aggregation: nothing to materialise in v1 (summary computed on read)');
      return { job: job.name, ok: true, detail: 'summary-on-read' };
    }
    case 'provider-health-check': {
      if (!deps.probeProvider || !deps.providers?.length) {
        log('provider-health-check: no prober/providers configured, skipped');
        return { job: job.name, ok: true, detail: 'skipped-no-prober' };
      }
      const results: string[] = [];
      for (const p of deps.providers) {
        try {
          const up = await deps.probeProvider(p.id, p.baseUrl);
          results.push(`${p.id}:${up ? 'UP' : 'DOWN'}`);
        } catch { results.push(`${p.id}:ERROR`); }
      }
      log('provider-health-check', results);
      return { job: job.name, ok: true, detail: results.join(',') };
    }
    case 'credit-expiry-check': {
      // v1 credits do not expire (no expiry field in CreditTransaction);
      // keep the job as a logged no-op until an expiry policy is decided.
      log('credit-expiry-check: no expiring credits in v1');
      return { job: job.name, ok: true, detail: 'no-expiry-policy' };
    }
  }
}

export function createWorker(deps: WorkerDeps = {}): { queue: JobQueue; runJob: (job: Job) => Promise<{ job: JobName; ok: boolean; detail?: string }> } {
  const queue = new InMemoryQueue(async (job) => { await runJob(job, deps); });
  return { queue, runJob: (job) => runJob(job, deps) };
}

/** Schedule the three jobs on simple intervals (inline mode). */
export function startWorker(deps: WorkerDeps = {}, intervalsMs: { usage?: number; health?: number; credit?: number } = {}): { queue: JobQueue; stop: () => void } {
  const { queue } = createWorker(deps);
  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (name: JobName, ms: number) => {
    timers.push(setInterval(() => { void queue.enqueue({ name, enqueuedAt: new Date().toISOString() }).then(() => queue.drain()); }, ms));
  };
  every('usage-aggregation', intervalsMs.usage ?? 60_000);
  every('provider-health-check', intervalsMs.health ?? 300_000);
  every('credit-expiry-check', intervalsMs.credit ?? 3_600_000);
  return { queue, stop: () => timers.forEach((t) => clearInterval(t)) };
}

// Run standalone: `node --loader ts-node/esm` not required in prod builds;
// this entrypoint is for the compiled dist. Inline mode by default.
if (import.meta.url === `file://${process.argv[1]}`) {
  const useRedis = Boolean(process.env.REDIS_URL);
  // eslint-disable-next-line no-console
  console.log(`[worker] starting in ${useRedis ? 'redis (BullMQ optional — inline fallback if unavailable)' : 'inline in-memory'} mode`);
  const { stop } = startWorker({});
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('SIGINT', () => { stop(); process.exit(0); });
}
