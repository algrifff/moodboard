import {
  chooseDesignVariantRequestSchema,
  postDesignToLinearRequestSchema,
} from '@moodboard/shared'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { chooseDesignVariant, getDesignRun, postToLinear } from '../lib/designRuns'
import { LinearApiError } from '../lib/linear'
import { LinearUnavailableError } from '../lib/linearConnection'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

// The designer's runs, as the sidebar's variant cards see them: read the
// current pick, pick one, post the pick to the run's Linear issue. Posting
// is only ever this explicit request (or the agent tool when asked) and
// only for the picked variant.
export const designRuns = new Hono<{ Variables: Variables }>()

designRuns.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

const postLimit = rateLimit({ scope: 'linear-post', limit: 10, windowMs: 60_000 })

designRuns.get('/:id', async (c) => {
  const run = await getDesignRun(c.req.param('id'))
  if (!run) return c.json({ error: 'Not found' }, 404)
  return c.json({ run })
})

designRuns.post('/:id/choose', async (c) => {
  const parsed = chooseDesignVariantRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const result = await chooseDesignVariant(c.req.param('id'), parsed.data.outputId)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ run: result.run })
})

designRuns.post('/:id/linear-comment', postLimit, async (c) => {
  const parsed = postDesignToLinearRequestSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  const run = await getDesignRun(c.req.param('id') as string)
  if (!run) return c.json({ error: 'Not found' }, 404)
  const outputId = parsed.data.outputId ?? run.chosenOutputId
  if (!outputId) return c.json({ error: 'Pick an option first' }, 400)
  if (!run.variants.some((v) => v.outputId === outputId)) {
    return c.json({ error: 'That output isn’t one of this run’s options' }, 400)
  }
  try {
    const posted = await postToLinear({ userId: c.get('user')!.id, outputId, runId: run.id })
    if (!posted.ok) return c.json({ error: posted.error }, 400)
    return c.json({
      run: posted.run,
      commentUrl: posted.commentUrl,
      shareUrl: posted.shareUrl,
      imageAttached: posted.imageAttached,
    })
  } catch (e) {
    if (e instanceof LinearUnavailableError) return c.json({ error: e.message, code: e.code }, 409)
    if (e instanceof LinearApiError) return c.json({ error: `Linear: ${e.message}` }, 502)
    throw e
  }
})
