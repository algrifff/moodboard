import type { RenderJob, RenderJobStatus } from '@moodboard/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, schema } from '../db'

// The background job queue (table render_job). Deliberately generic: a job is
// a kind, an opaque JSON payload and, when it finishes, an opaque JSON
// result. Today only MP4 renders use it; Phase 24's designer runs can move
// onto it later by registering a handler (lib/jobRunner.ts).
//
// Semantics:
// - A worker claims the oldest queued job with FOR UPDATE SKIP LOCKED, so
//   any number of API instances can poll one table without double-claiming.
//   Claiming counts an attempt.
// - A running job is kept alive by heartbeats (locked_at). One whose worker
//   died stops beating; requeueStaleJobs puts it back (or fails it once its
//   attempts are spent). The maintenance tick calls it.
// - Cancelling is a state change, not a signal: queued → cancelled at once;
//   running → cancelled, and the worker finds out at its next heartbeat
//   (its guarded UPDATEs match no row) and aborts.
// - Every worker write is guarded by (id, locked_by, status = running), so a
//   worker that lost its job — cancelled, or taken over after a stall —
//   can't overwrite whoever owns it now.

export type JobRow = typeof schema.renderJob.$inferSelect

export const JOB_STALE_MS = 60_000
export const JOB_QUEUE_MAX = Math.max(1, Number(process.env.JOB_QUEUE_MAX) || 25)
const MAX_ERROR_CHARS = 600

export class QueueFullError extends Error {
  constructor() {
    super('The render queue is full — wait for a render to finish and try again.')
    this.name = 'QueueFullError'
  }
}

const clip = (message: string) => message.trim().slice(0, MAX_ERROR_CHARS)

export function toRenderJob(row: JobRow, createdByName: string | null = null): RenderJob {
  const object = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as RenderJobStatus,
    progress: row.progress,
    attempts: row.attempts,
    outputId: row.outputId,
    payload: object(row.payload) ?? {},
    result: object(row.result),
    error: row.error,
    createdByName,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

export async function getJob(id: string): Promise<JobRow | null> {
  const [row] = await db.select().from(schema.renderJob).where(eq(schema.renderJob.id, id)).limit(1)
  return row ?? null
}

export async function getRenderJob(id: string): Promise<RenderJob | null> {
  const [row] = await db
    .select({ job: schema.renderJob, createdByName: schema.user.name })
    .from(schema.renderJob)
    .leftJoin(schema.user, eq(schema.user.id, schema.renderJob.createdBy))
    .where(eq(schema.renderJob.id, id))
    .limit(1)
  return row ? toRenderJob(row.job, row.createdByName) : null
}

export async function listOutputJobs(
  outputId: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<RenderJob[]> {
  const rows = await db
    .select({ job: schema.renderJob, createdByName: schema.user.name })
    .from(schema.renderJob)
    .leftJoin(schema.user, eq(schema.user.id, schema.renderJob.createdBy))
    .where(
      and(
        eq(schema.renderJob.outputId, outputId),
        opts.kind ? eq(schema.renderJob.kind, opts.kind) : undefined,
      ),
    )
    .orderBy(desc(schema.renderJob.createdAt))
    .limit(opts.limit ?? 20)
  return rows.map((r) => toRenderJob(r.job, r.createdByName))
}

// Queue a job, or return the identical one already waiting / running (same
// kind and payload) rather than doing the work twice.
export async function enqueueJob(args: {
  kind: string
  payload: Record<string, unknown>
  outputId?: string | null
  userId?: string | null
  maxAttempts?: number
}): Promise<{ job: JobRow; existing: boolean }> {
  const payload = JSON.stringify(args.payload)
  const [dup] = await db
    .select()
    .from(schema.renderJob)
    .where(
      and(
        eq(schema.renderJob.kind, args.kind),
        inArray(schema.renderJob.status, ['queued', 'running']),
        sql`${schema.renderJob.payload} = ${payload}::jsonb`,
      ),
    )
    .limit(1)
  if (dup) return { job: dup, existing: true }

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.renderJob)
    .where(inArray(schema.renderJob.status, ['queued', 'running']))
  if ((count?.n ?? 0) >= JOB_QUEUE_MAX) throw new QueueFullError()

  const [job] = await db
    .insert(schema.renderJob)
    .values({
      id: nanoid(),
      kind: args.kind,
      payload: args.payload,
      outputId: args.outputId ?? null,
      createdBy: args.userId ?? null,
      ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}),
    })
    .returning()
  return { job: job!, existing: false }
}

// The oldest queued job of one of `kinds`, now running under `workerId`.
export async function claimJob(workerId: string, kinds: string[]): Promise<JobRow | null> {
  if (kinds.length === 0) return null
  const claimed = await db.execute(sql`
    UPDATE render_job
    SET status = 'running', locked_at = now(), locked_by = ${workerId},
        attempts = attempts + 1, started_at = coalesce(started_at, now()),
        progress = 0, error = NULL, updated_at = now()
    WHERE id = (
      SELECT id FROM render_job
      WHERE status = 'queued' AND kind IN (${sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      )})
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)
  const id = claimed[0]?.id as string | undefined
  return id ? getJob(id) : null
}

const owned = (id: string, workerId: string) =>
  and(
    eq(schema.renderJob.id, id),
    eq(schema.renderJob.lockedBy, workerId),
    eq(schema.renderJob.status, 'running'),
  )

// Keeps the claim fresh and records progress (0..1). False means the job is
// no longer this worker's — cancelled, or requeued after a stall — and the
// work should stop.
export async function heartbeatJob(
  id: string,
  workerId: string,
  progress: number,
): Promise<boolean> {
  const rows = await db
    .update(schema.renderJob)
    .set({
      lockedAt: new Date(),
      progress: Math.min(1, Math.max(0, progress)),
      updatedAt: new Date(),
    })
    .where(owned(id, workerId))
    .returning({ id: schema.renderJob.id })
  return rows.length > 0
}

export async function completeJob(
  id: string,
  workerId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(schema.renderJob)
    .set({
      status: 'done',
      progress: 1,
      result,
      error: null,
      lockedAt: null,
      lockedBy: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(owned(id, workerId))
    .returning({ id: schema.renderJob.id })
  return rows.length > 0
}

// A failed attempt: back on the queue while attempts remain (unless the
// failure is permanent), otherwise failed for good.
export async function failJob(
  id: string,
  workerId: string,
  error: string,
  opts: { permanent?: boolean } = {},
): Promise<'requeued' | 'failed' | 'lost'> {
  const message = clip(error)
  const rows = await db.execute(sql`
    UPDATE render_job
    SET status = CASE WHEN ${opts.permanent ?? false} OR attempts >= max_attempts
                      THEN 'failed' ELSE 'queued' END,
        error = ${message},
        finished_at = CASE WHEN ${opts.permanent ?? false} OR attempts >= max_attempts
                           THEN now() ELSE NULL END,
        locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${id} AND locked_by = ${workerId} AND status = 'running'
    RETURNING status
  `)
  const status = rows[0]?.status as string | undefined
  return status === 'queued' ? 'requeued' : status === 'failed' ? 'failed' : 'lost'
}

// Hand a worker's running jobs back (clean shutdown): the attempt it was
// on doesn't count against them.
export async function releaseJobs(workerId: string): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE render_job
    SET status = 'queued', attempts = greatest(attempts - 1, 0), locked_at = NULL,
        locked_by = NULL, progress = 0, updated_at = now()
    WHERE locked_by = ${workerId} AND status = 'running'
    RETURNING id
  `)
  return rows.length
}

export async function cancelJob(id: string): Promise<{ job: JobRow | null; changed: boolean }> {
  const rows = await db
    .update(schema.renderJob)
    .set({
      status: 'cancelled',
      lockedAt: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(schema.renderJob.id, id), inArray(schema.renderJob.status, ['queued', 'running'])),
    )
    .returning()
  if (rows[0]) return { job: rows[0], changed: true }
  return { job: await getJob(id), changed: false }
}

// Running jobs whose worker stopped beating go back on the queue, or fail
// once their attempts are spent.
export async function requeueStaleJobs(
  staleMs = JOB_STALE_MS,
): Promise<{ requeued: number; failed: number }> {
  const rows = await db.execute(sql`
    UPDATE render_job
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        error = 'The worker stopped responding',
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
        locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE status = 'running'
      AND locked_at < now() - make_interval(secs => ${staleMs / 1000})
    RETURNING status
  `)
  const failed = rows.filter((r) => r.status === 'failed').length
  return { requeued: rows.length - failed, failed }
}
