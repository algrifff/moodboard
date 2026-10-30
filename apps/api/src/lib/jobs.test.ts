import { nanoid } from 'nanoid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The job queue against a real, migrated Postgres (CI provides one). Each
// test uses its own job kind, so the dev server's worker and parallel test
// files never touch these rows.
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('job queue', () => {
  let dbMod: typeof import('../db')
  let jobs: typeof import('./jobs')
  let runner: typeof import('./jobRunner')
  const kinds: string[] = []

  const kind = () => {
    const k = `test-${nanoid(8)}`
    kinds.push(k)
    return k
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async <T>(read: () => Promise<T | null | false>, ms = 5000): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      const v = await read()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out waiting')
      await sleep(25)
    }
  }

  beforeAll(async () => {
    // The queue cap counts every waiting job in the database, and these tests
    // leave claimed jobs running until the end; without room they would trip
    // the cap whenever another test file has a few jobs queued at the same time.
    process.env.JOB_QUEUE_MAX = '1000'
    dbMod = await import('../db')
    jobs = await import('./jobs')
    runner = await import('./jobRunner')
  })

  afterAll(async () => {
    const { inArray } = await import('drizzle-orm')
    await dbMod.db.delete(dbMod.schema.renderJob).where(inArray(dbMod.schema.renderJob.kind, kinds))
    await dbMod.pgClient.end()
  })

  it('claims oldest first, counts the attempt, and runs a job once', async () => {
    const k = kind()
    const a = (await jobs.enqueueJob({ kind: k, payload: { n: 1 } })).job
    const b = (await jobs.enqueueJob({ kind: k, payload: { n: 2 } })).job
    const first = (await jobs.claimJob('w1', [k]))!
    expect(first.id).toBe(a.id)
    expect(first).toMatchObject({ status: 'running', lockedBy: 'w1', attempts: 1 })
    expect(first.startedAt).not.toBeNull()
    expect((await jobs.claimJob('w2', [k]))!.id).toBe(b.id)
    expect(await jobs.claimJob('w3', [k])).toBeNull()
  })

  it('does not queue the same waiting job twice', async () => {
    const k = kind()
    const one = await jobs.enqueueJob({ kind: k, payload: { same: true } })
    const two = await jobs.enqueueJob({ kind: k, payload: { same: true } })
    expect(one.existing).toBe(false)
    expect(two.existing).toBe(true)
    expect(two.job.id).toBe(one.job.id)
    const w = (await jobs.claimJob('w', [k]))!
    await jobs.completeJob(w.id, 'w', {})
    expect((await jobs.enqueueJob({ kind: k, payload: { same: true } })).existing).toBe(false)
  })

  it('hands every job to exactly one of several workers claiming at once', async () => {
    const k = kind()
    const ids = new Set<string>()
    for (let i = 0; i < 12; i++) {
      ids.add((await jobs.enqueueJob({ kind: k, payload: { i } })).job.id)
    }
    const drain = async (worker: string) => {
      const got: string[] = []
      for (;;) {
        const job = await jobs.claimJob(worker, [k])
        if (!job) return got
        got.push(job.id)
      }
    }
    const [a, b, c] = await Promise.all([drain('wa'), drain('wb'), drain('wc')])
    const all = [...a, ...b, ...c]
    expect(all).toHaveLength(12)
    expect(new Set(all)).toEqual(ids)
    expect(a.length + b.length + c.length).toBe(12)
  })

  it('skips a row another transaction holds locked, instead of waiting for it', async () => {
    const { sql } = await import('drizzle-orm')
    const k = kind()
    const locked = (await jobs.enqueueJob({ kind: k, payload: { which: 'locked' } })).job
    const free = (await jobs.enqueueJob({ kind: k, payload: { which: 'free' } })).job
    let claimedWhileLocked: string | undefined
    await dbMod.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM render_job WHERE id = ${locked.id} FOR UPDATE`)
      claimedWhileLocked = (await jobs.claimJob('w', [k]))?.id
    })
    expect(claimedWhileLocked).toBe(free.id)
    expect((await jobs.claimJob('w', [k]))!.id).toBe(locked.id)
  })

  it('only the owning worker can heartbeat, complete or fail a job', async () => {
    const k = kind()
    const job = (await jobs.enqueueJob({ kind: k, payload: {} })).job
    await jobs.claimJob('owner', [k])
    expect(await jobs.heartbeatJob(job.id, 'owner', 0.4)).toBe(true)
    expect((await jobs.getJob(job.id))!.progress).toBeCloseTo(0.4)
    expect(await jobs.heartbeatJob(job.id, 'other', 0.9)).toBe(false)
    expect(await jobs.completeJob(job.id, 'other', { x: 1 })).toBe(false)
    expect(await jobs.failJob(job.id, 'other', 'nope')).toBe('lost')
    expect(await jobs.completeJob(job.id, 'owner', { file: 'a.mp4' })).toBe(true)
    const done = (await jobs.getJob(job.id))!
    expect(done).toMatchObject({ status: 'done', progress: 1, result: { file: 'a.mp4' } })
    expect(done.finishedAt).not.toBeNull()
    expect(await jobs.heartbeatJob(job.id, 'owner', 0.5)).toBe(false)
  })

  it('retries a failing job until its attempts are spent, then fails it', async () => {
    const k = kind()
    const job = (await jobs.enqueueJob({ kind: k, payload: {}, maxAttempts: 2 })).job
    await jobs.claimJob('w', [k])
    expect(await jobs.failJob(job.id, 'w', 'boom 1')).toBe('requeued')
    expect(await jobs.getJob(job.id)).toMatchObject({ status: 'queued', error: 'boom 1' })
    await jobs.claimJob('w', [k])
    expect(await jobs.failJob(job.id, 'w', 'boom 2')).toBe('failed')
    expect(await jobs.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: 'boom 2',
      attempts: 2,
    })
  })

  it('fails a permanent error at once', async () => {
    const k = kind()
    const job = (await jobs.enqueueJob({ kind: k, payload: {} })).job
    await jobs.claimJob('w', [k])
    expect(await jobs.failJob(job.id, 'w', 'too long', { permanent: true })).toBe('failed')
    expect((await jobs.getJob(job.id))!.attempts).toBe(1)
  })

  it('re-queues a running job whose worker stopped beating, and fails one out of attempts', async () => {
    const { eq } = await import('drizzle-orm')
    const k = kind()
    const retry = (await jobs.enqueueJob({ kind: k, payload: { r: 1 } })).job
    const spent = (await jobs.enqueueJob({ kind: k, payload: { r: 2 }, maxAttempts: 1 })).job
    const fresh = (await jobs.enqueueJob({ kind: k, payload: { r: 3 } })).job
    await jobs.claimJob('dead', [k])
    await jobs.claimJob('dead', [k])
    await jobs.claimJob('alive', [k])
    const longAgo = new Date(Date.now() - 10 * 60_000)
    for (const id of [retry.id, spent.id]) {
      await dbMod.db
        .update(dbMod.schema.renderJob)
        .set({ lockedAt: longAgo })
        .where(eq(dbMod.schema.renderJob.id, id))
    }
    const swept = await jobs.requeueStaleJobs()
    expect(swept.requeued).toBeGreaterThanOrEqual(1)
    expect(swept.failed).toBeGreaterThanOrEqual(1)
    expect(await jobs.getJob(retry.id)).toMatchObject({
      status: 'queued',
      lockedBy: null,
      error: 'The worker stopped responding',
    })
    expect(await jobs.getJob(spent.id)).toMatchObject({ status: 'failed' })
    expect((await jobs.getJob(fresh.id))!.status).toBe('running')
    // The dead worker's late write is refused; the job is claimable again.
    expect(await jobs.completeJob(retry.id, 'dead', {})).toBe(false)
    expect((await jobs.claimJob('next', [k]))!.id).toBe(retry.id)
  })

  it('cancels a queued job, and tells a running job’s worker at its next heartbeat', async () => {
    const k = kind()
    const queued = (await jobs.enqueueJob({ kind: k, payload: { q: 1 } })).job
    const running = (await jobs.enqueueJob({ kind: k, payload: { q: 2 } })).job
    expect((await jobs.cancelJob(queued.id)).changed).toBe(true)
    expect(await jobs.claimJob('w', [k])).toMatchObject({ id: running.id })
    expect((await jobs.cancelJob(running.id)).changed).toBe(true)
    expect(await jobs.heartbeatJob(running.id, 'w', 0.5)).toBe(false)
    expect(await jobs.completeJob(running.id, 'w', {})).toBe(false)
    const after = (await jobs.getJob(running.id))!
    expect(after.status).toBe('cancelled')
    expect(after.finishedAt).not.toBeNull()
    // Already finished: nothing to cancel.
    expect(await jobs.cancelJob(queued.id)).toMatchObject({ changed: false })
    expect((await jobs.cancelJob('nope')).job).toBeNull()
  })

  it('gives a worker’s jobs back on shutdown without spending an attempt', async () => {
    const k = kind()
    const job = (await jobs.enqueueJob({ kind: k, payload: {} })).job
    await jobs.claimJob('leaving', [k])
    expect(await jobs.releaseJobs('leaving')).toBe(1)
    expect(await jobs.getJob(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lockedBy: null,
    })
  })

  describe('worker loop', () => {
    it('runs jobs, records progress and the result', async () => {
      const k = kind()
      const seen: number[] = []
      const worker = runner.startJobWorker({
        handlers: {
          [k]: async (job, { progress }) => {
            for (const p of [0.25, 0.5]) {
              progress(p)
              await sleep(120)
            }
            seen.push(job.attempts)
            return { ok: true }
          },
        },
        pollMs: 50,
        heartbeatMs: 40,
      })
      try {
        const { job } = await jobs.enqueueJob({ kind: k, payload: {} })
        worker.kick()
        const mid = await waitFor(async () => {
          const row = await jobs.getJob(job.id)
          return row?.status === 'running' && row.progress > 0 ? row : null
        })
        expect(mid.progress).toBeGreaterThan(0)
        const done = await waitFor(async () => {
          const row = await jobs.getJob(job.id)
          return row?.status === 'done' ? row : null
        })
        expect(done.result).toEqual({ ok: true })
        expect(seen).toEqual([1])
      } finally {
        await worker.stop()
      }
    })

    it('never runs more than its concurrency at once', async () => {
      const k = kind()
      let now = 0
      let peak = 0
      const worker = runner.startJobWorker({
        handlers: {
          [k]: async () => {
            now++
            peak = Math.max(peak, now)
            await sleep(80)
            now--
            return {}
          },
        },
        concurrency: 2,
        pollMs: 30,
        heartbeatMs: 40,
      })
      try {
        const made: { id: string }[] = []
        for (let i = 0; i < 5; i++)
          made.push((await jobs.enqueueJob({ kind: k, payload: { i } })).job)
        worker.kick()
        await waitFor(async () => {
          const rows = await Promise.all(made.map((j) => jobs.getJob(j.id)))
          return rows.every((r) => r?.status === 'done')
        })
        expect(peak).toBe(2)
      } finally {
        await worker.stop()
      }
    })

    it('aborts the handler when the job is cancelled, and retries a throw', async () => {
      const k = kind()
      let aborted = false
      let tries = 0
      const worker = runner.startJobWorker({
        handlers: {
          [k]: async (job, { signal }) => {
            if (job.payload && (job.payload as { slow?: boolean }).slow) {
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                  aborted = true
                  resolve()
                })
              })
              throw new Error('stopped')
            }
            tries++
            if (tries < 2) throw new Error('flaky')
            return { tries }
          },
        },
        pollMs: 30,
        heartbeatMs: 30,
      })
      try {
        const slow = (await jobs.enqueueJob({ kind: k, payload: { slow: true } })).job
        worker.kick()
        await waitFor(async () => (await jobs.getJob(slow.id))?.status === 'running')
        await jobs.cancelJob(slow.id)
        await waitFor(async () => aborted)
        expect((await jobs.getJob(slow.id))!.status).toBe('cancelled')

        const flaky = (await jobs.enqueueJob({ kind: k, payload: { slow: false } })).job
        worker.kick()
        const done = await waitFor(async () => {
          const row = await jobs.getJob(flaky.id)
          return row?.status === 'done' ? row : null
        })
        expect(done.attempts).toBe(2)
        expect(done.result).toEqual({ tries: 2 })
      } finally {
        await worker.stop()
      }
    })

    it('fails a PermanentJobError without retrying and hands running jobs back on stop', async () => {
      const k = kind()
      const worker = runner.startJobWorker({
        handlers: {
          [k]: async (job) => {
            if ((job.payload as { permanent?: boolean }).permanent) {
              throw new runner.PermanentJobError('over the limit')
            }
            await new Promise(() => undefined)
            return {}
          },
        },
        pollMs: 30,
        heartbeatMs: 30,
        stopGraceMs: 200,
      })
      const bad = (await jobs.enqueueJob({ kind: k, payload: { permanent: true } })).job
      worker.kick()
      const failed = await waitFor(async () => {
        const row = await jobs.getJob(bad.id)
        return row?.status === 'failed' ? row : null
      })
      expect(failed).toMatchObject({ error: 'over the limit', attempts: 1 })

      const hang = (await jobs.enqueueJob({ kind: k, payload: { permanent: false } })).job
      worker.kick()
      await waitFor(async () => (await jobs.getJob(hang.id))?.status === 'running')
      await worker.stop()
      expect(await jobs.getJob(hang.id)).toMatchObject({ status: 'queued', attempts: 0 })
    })
  })
})
