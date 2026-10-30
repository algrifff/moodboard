import { randomUUID } from 'node:crypto'
import {
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  releaseJobs,
  requeueStaleJobs,
  type JobRow,
} from './jobs'

// Runs queued jobs in this API process: up to `concurrency` at a time, each
// claimed from Postgres (lib/jobs.ts). A handler gets an AbortSignal that
// fires when the job is cancelled (by anyone, on any instance — found at the
// next heartbeat) or the server is shutting down, and a progress reporter.
// Whatever it returns becomes the job's result; a throw fails the attempt
// (retried while attempts remain, unless it is a PermanentJobError).

export type JobContext = {
  signal: AbortSignal
  // 0..1; persisted with the next heartbeat.
  progress: (fraction: number) => void
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<Record<string, unknown>>

// A failure retrying can't fix (a document over the render limits).
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

export type JobWorker = {
  workerId: string
  // Look for work now rather than at the next poll.
  kick: () => void
  stop: () => Promise<void>
}

type Running = { controller: AbortController; progress: number; beat?: NodeJS.Timeout }

const running = new Map<string, Running>()
let active: JobWorker | null = null

// Abort a job this process is running (the cancel route; other instances'
// jobs notice through the database).
export function abortLocalJob(id: string): void {
  running.get(id)?.controller.abort(new Error('cancelled'))
}

export function kickJobWorker(): void {
  active?.kick()
}

export function startJobWorker(opts: {
  handlers: Record<string, JobHandler>
  concurrency?: number
  pollMs?: number
  heartbeatMs?: number
  staleMs?: number
  // How long stop() waits for handlers to wind down before handing their
  // jobs back anyway.
  stopGraceMs?: number
  workerId?: string
}): JobWorker {
  const workerId = opts.workerId ?? `${process.pid}-${randomUUID().slice(0, 8)}`
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const pollMs = opts.pollMs ?? 2000
  const heartbeatMs = opts.heartbeatMs ?? 1500
  const kinds = Object.keys(opts.handlers)
  let stopping = false
  let pumping = false
  let lastSweep = 0

  const runJob = async (job: JobRow) => {
    const handler = opts.handlers[job.kind]!
    const state: Running = { controller: new AbortController(), progress: 0 }
    running.set(job.id, state)
    state.beat = setInterval(() => {
      heartbeatJob(job.id, workerId, state.progress)
        .then((mine) => {
          if (!mine) state.controller.abort(new Error('cancelled'))
        })
        .catch((e) => console.warn('[jobs] heartbeat failed', e))
    }, heartbeatMs)
    try {
      const result = await handler(job, {
        signal: state.controller.signal,
        progress: (fraction) => {
          state.progress = fraction
        },
      })
      if (!(await completeJob(job.id, workerId, result))) {
        console.warn(`[jobs] ${job.id} finished after losing its claim; result dropped`)
      }
    } catch (e) {
      if (stopping || state.controller.signal.aborted) return
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[jobs] ${job.kind} ${job.id} failed (attempt ${job.attempts})`, e)
      await failJob(job.id, workerId, message, { permanent: e instanceof PermanentJobError })
    } finally {
      clearInterval(state.beat)
      running.delete(job.id)
    }
  }

  const pump = async () => {
    if (pumping || stopping) return
    pumping = true
    try {
      if (Date.now() - lastSweep > 30_000) {
        lastSweep = Date.now()
        const swept = await requeueStaleJobs(opts.staleMs)
        if (swept.requeued + swept.failed > 0) {
          console.log(`[jobs] stale: ${swept.requeued} requeued, ${swept.failed} failed`)
        }
      }
      while (!stopping && inFlight.size < concurrency) {
        const job = await claimJob(workerId, kinds)
        if (!job) break
        const done = runJob(job).finally(() => {
          inFlight.delete(done)
          void pump()
        })
        inFlight.add(done)
      }
    } catch (e) {
      console.warn('[jobs] poll failed', e)
    } finally {
      pumping = false
    }
  }

  const inFlight = new Set<Promise<void>>()
  const timer = setInterval(() => void pump(), pollMs)
  timer.unref()
  void pump()

  const worker: JobWorker = {
    workerId,
    kick: () => void pump(),
    stop: async () => {
      stopping = true
      clearInterval(timer)
      for (const state of running.values()) state.controller.abort(new Error('shutdown'))
      let grace: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => {
          grace = setTimeout(resolve, opts.stopGraceMs ?? 10_000)
        }),
      ])
      clearTimeout(grace)
      for (const state of running.values()) clearInterval(state.beat)
      await releaseJobs(workerId).catch(() => 0)
      if (active === worker) active = null
    },
  }
  active = worker
  return worker
}
