import { analyzeRequestSchema, synthesizeRequestSchema, type CanvasObject } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { loadBoardObjects } from '../lib/boardObjects'
import { analysisNotConfigured, runAgentOnGroup, runSynthesisOnGroup } from '../lib/groupAnalysis'
import { DEFAULT_DEPTH } from '../lib/modelTags'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const analyze = new Hono<{ Variables: Variables }>()

analyze.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// Tighter than the 30/min on upload — Claude calls cost real money. Per IP.
// Applied per-route below (not as wildcard) because the analyze router is
// mounted at the api root via `api.route('/', analyze)`; a wildcard rate
// limit would leak onto /api/files/* image streams and 429 the browser's
// parallel logo loads after a paste.
const analyzeRateLimit = rateLimit({ scope: 'analyze', limit: 20, windowMs: 60_000 })

// Shared: load the board and resolve the requested object subset.
async function loadGroupObjects(
  boardId: string,
  objectIds: string[],
): Promise<
  { ok: true; objects: CanvasObject[] } | { ok: false; status: 400 | 404; error: string }
> {
  const [boardRow] = await db
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(eq(schema.board.id, boardId))
    .limit(1)
  if (!boardRow) return { ok: false, status: 404, error: 'Not found' }
  const idSet = new Set(objectIds)
  const objects = (await loadBoardObjects(boardId))
    .map((o) => o.object)
    .filter((o) => idSet.has(o.id))
  if (objects.length < 2) {
    return {
      ok: false,
      status: 400,
      error: 'Group must contain at least 2 objects from this board',
    }
  }
  return { ok: true, objects }
}

analyze.post('/boards/:boardId/analyze', analyzeRateLimit, async (c) => {
  const boardId = c.req.param('boardId') as string

  const body = await c.req.json().catch(() => null)
  const parsed = analyzeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const { objectIds, agentId, force = false, depth = DEFAULT_DEPTH } = parsed.data

  const group = await loadGroupObjects(boardId, objectIds)
  if (!group.ok) return c.json({ error: group.error }, group.status)

  try {
    const run = await runAgentOnGroup(boardId, group.objects, agentId, { force, depth })
    return c.json({ agentId, data: run.data, cached: run.cached, groupKey: run.cacheKey })
  } catch (e) {
    const notConfigured = analysisNotConfigured(e)
    if (notConfigured) return c.json({ error: notConfigured }, 503)
    const msg = e instanceof Error ? e.message : String(e)
    console.error('analyze failed', { agentId, error: e })
    return c.json({ error: `Analysis failed: ${msg}` }, 502)
  }
})

analyze.post('/boards/:boardId/synthesize', analyzeRateLimit, async (c) => {
  const boardId = c.req.param('boardId') as string

  const body = await c.req.json().catch(() => null)
  const parsed = synthesizeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const { objectIds, agentIds, force = false, depth = DEFAULT_DEPTH } = parsed.data

  const group = await loadGroupObjects(boardId, objectIds)
  if (!group.ok) return c.json({ error: group.error }, group.status)

  try {
    const run = await runSynthesisOnGroup(boardId, group.objects, agentIds, { force, depth })
    return c.json({
      agentIds: run.agentIds,
      data: run.data,
      cached: run.cached,
      groupKey: run.cacheKey,
    })
  } catch (e) {
    const notConfigured = analysisNotConfigured(e)
    if (notConfigured) return c.json({ error: notConfigured }, 503)
    const msg = e instanceof Error ? e.message : String(e)
    console.error('synthesize failed', { agentIds, error: e })
    return c.json({ error: `Synthesis failed: ${msg}` }, 502)
  }
})
