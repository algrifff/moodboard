import {
  analyzeRequestSchema,
  synthesizeRequestSchema,
  type AgentId,
  type CanvasObject,
} from '@moodboard/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { getAgent } from '../lib/agents'
import {
  analyzeGroup,
  DEFAULT_DEPTH,
  modelTag,
  synthesisModelTag,
  synthesizeGroup,
  type AnalysisDepth,
} from '../lib/analyze'
import { analysisHash } from '../lib/analysisHash'
import { rateLimit } from '../lib/rateLimit'

type Variables = { user: AuthUser | null; session: AuthSession | null }

export const analyze = new Hono<{ Variables: Variables }>()

analyze.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

// Tighter than the 30/min on upload — Claude calls cost real money. Per IP.
analyze.use('*', rateLimit({ scope: 'analyze', limit: 20, windowMs: 60_000 }))

// Shared: load the board and resolve the requested object subset.
async function loadGroupObjects(
  boardId: string,
  userId: string,
  objectIds: string[],
): Promise<
  { ok: true; objects: CanvasObject[] } | { ok: false; status: 400 | 404; error: string }
> {
  const [boardRow] = await db
    .select()
    .from(schema.board)
    .where(and(eq(schema.board.id, boardId), eq(schema.board.userId, userId)))
    .limit(1)
  if (!boardRow) return { ok: false, status: 404, error: 'Not found' }
  const data = (boardRow.data ?? {}) as { objects?: CanvasObject[] }
  const all: CanvasObject[] = Array.isArray(data.objects) ? data.objects : []
  const idSet = new Set(objectIds)
  const objects = all.filter((o) => idSet.has(o.id))
  if (objects.length < 2) {
    return {
      ok: false,
      status: 400,
      error: 'Group must contain at least 2 objects from this board',
    }
  }
  return { ok: true, objects }
}

// Shared: get an agent's result, hitting cache first.
async function getAgentResult(
  objects: CanvasObject[],
  agentId: AgentId,
  depth: AnalysisDepth,
  force: boolean,
): Promise<{ data: unknown; cached: boolean; cacheKey: string; tag: string }> {
  const tag = modelTag(agentId, depth)
  const cacheKey = analysisHash(objects, tag)
  if (!force) {
    const [hit] = await db
      .select()
      .from(schema.groupAnalysis)
      .where(eq(schema.groupAnalysis.cacheKey, cacheKey))
      .limit(1)
    if (hit) return { data: hit.analysis, cached: true, cacheKey, tag }
  }
  const data = await analyzeGroup(objects, agentId, depth)
  await db
    .insert(schema.groupAnalysis)
    .values({ cacheKey, model: tag, analysis: data as object })
    .onConflictDoNothing()
  return { data, cached: false, cacheKey, tag }
}

analyze.post('/boards/:boardId/analyze', async (c) => {
  const user = c.get('user')!
  const boardId = c.req.param('boardId')

  const body = await c.req.json().catch(() => null)
  const parsed = analyzeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const { objectIds, agentId, force = false, depth = DEFAULT_DEPTH } = parsed.data

  const group = await loadGroupObjects(boardId, user.id, objectIds)
  if (!group.ok) return c.json({ error: group.error }, group.status)

  try {
    const { data, cached, cacheKey } = await getAgentResult(group.objects, agentId, depth, force)
    return c.json({ agentId, data, cached, groupKey: cacheKey })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('ANTHROPIC_API_KEY')) {
      return c.json({ error: 'Analysis not configured' }, 503)
    }
    console.error('analyze failed', { agentId, error: e })
    return c.json({ error: `Analysis failed: ${msg}` }, 502)
  }
})

analyze.post('/boards/:boardId/synthesize', async (c) => {
  const user = c.get('user')!
  const boardId = c.req.param('boardId')

  const body = await c.req.json().catch(() => null)
  const parsed = synthesizeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
  }
  const { objectIds, agentIds, force = false, depth = DEFAULT_DEPTH } = parsed.data

  const group = await loadGroupObjects(boardId, user.id, objectIds)
  if (!group.ok) return c.json({ error: group.error }, group.status)

  // Synthesiser cache — distinct bucket keyed by the sorted agent ids.
  const sortedIds = [...agentIds].sort()
  const synthTag = synthesisModelTag(sortedIds, depth)
  const synthCacheKey = analysisHash(group.objects, synthTag)

  if (!force) {
    const [hit] = await db
      .select()
      .from(schema.groupAnalysis)
      .where(eq(schema.groupAnalysis.cacheKey, synthCacheKey))
      .limit(1)
    if (hit) {
      return c.json({
        agentIds: sortedIds,
        data: hit.analysis,
        cached: true,
        groupKey: synthCacheKey,
      })
    }
  }

  try {
    // Pull each agent's read (cached or fresh) sequentially. Sequential
    // rather than parallel to stay polite to Anthropic — the spawn-rate
    // 502s we hit before were from parallel firing on the same input set.
    const agentResults: Array<{ id: AgentId; label: string; data: unknown }> = []
    for (const id of sortedIds) {
      const { data } = await getAgentResult(group.objects, id, depth, false)
      agentResults.push({ id, label: getAgent(id).label, data })
    }

    const data = await synthesizeGroup(group.objects, agentResults, depth)
    await db
      .insert(schema.groupAnalysis)
      .values({ cacheKey: synthCacheKey, model: synthTag, analysis: data as object })
      .onConflictDoNothing()

    return c.json({
      agentIds: sortedIds,
      data,
      cached: false,
      groupKey: synthCacheKey,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('ANTHROPIC_API_KEY')) {
      return c.json({ error: 'Analysis not configured' }, 503)
    }
    console.error('synthesize failed', { agentIds: sortedIds, error: e })
    return c.json({ error: `Synthesis failed: ${msg}` }, 502)
  }
})
