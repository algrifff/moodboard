import { isTerminalJobStatus, type RenderJob } from '@moodboard/shared'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { streamSSE } from 'hono/streaming'
import type { AuthSession, AuthUser } from '../auth'
import { abortLocalJob } from '../lib/jobRunner'
import { cancelJob, getRenderJob } from '../lib/jobs'

type Variables = { user: AuthUser | null; session: AuthSession | null }

const requireUser = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// /api/render-jobs — status, a live stream of it, and cancel. Any signed-in
// teammate sees and cancels any job (one internal team).
export const renderJobs = new Hono<{ Variables: Variables }>()
renderJobs.use('*', requireUser)

renderJobs.get('/:id', async (c) => {
  const job = await getRenderJob(c.req.param('id'))
  if (!job) return c.json({ error: 'Not found' }, 404)
  return c.json({ job })
})

const STREAM_POLL_MS = 700
const STREAM_MAX_MS = 60 * 60_000

// Server-sent events: the job as it changes, ending when it is finished.
renderJobs.get('/:id/stream', async (c) => {
  const id = c.req.param('id')
  if (!(await getRenderJob(id))) return c.json({ error: 'Not found' }, 404)
  return streamSSE(c, async (stream) => {
    let closed = false
    stream.onAbort(() => {
      closed = true
    })
    let last = ''
    const started = Date.now()
    while (!closed && Date.now() - started < STREAM_MAX_MS) {
      const job: RenderJob | null = await getRenderJob(id)
      if (!job) break
      const key = `${job.status}:${job.progress.toFixed(3)}:${job.attempts}`
      if (key !== last) {
        last = key
        await stream.writeSSE({ event: 'job', data: JSON.stringify(job) })
      }
      if (isTerminalJobStatus(job.status)) break
      await stream.sleep(STREAM_POLL_MS)
    }
  })
})

renderJobs.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const { job, changed } = await cancelJob(id)
  if (!job) return c.json({ error: 'Not found' }, 404)
  if (changed) abortLocalJob(id)
  return c.json({ job: await getRenderJob(id) })
})
