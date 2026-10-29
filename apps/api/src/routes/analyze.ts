import {
  analyzeRequestSchema,
  synthesizeRequestSchema,
  type AgentId,
  type CanvasObject,
  type VideoClipBreakdown,
  type VideoClipData,
} from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthSession, AuthUser } from '../auth'
import { db, schema } from '../db'
import { getAgent } from '../lib/agents'
import { analyzeGroup, synthesizeGroup } from '../lib/analyze'
import { DEFAULT_DEPTH, modelTag, synthesisModelTag, type AnalysisDepth } from '../lib/modelTags'
import {
  assembleVideoEditorBreakdown,
  mapWithConcurrency,
  MAX_VIDEO_CLIPS,
  VIDEO_CLIP_CONCURRENCY,
  videoClipCacheTag,
} from '../lib/videoClips'
import { analyzeVideoForEditor } from '../lib/gemini'
import { analysisHash } from '../lib/analysisHash'
import { loadBoardObjects } from '../lib/boardObjects'
import { rateLimit } from '../lib/rateLimit'
import { recordGroupDisplay, type DisplayKind } from '../lib/groupState'

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

// Shared: get an agent's result, hitting cache first.
export async function getAgentResult(
  objects: CanvasObject[],
  agentId: AgentId,
  depth: AnalysisDepth,
  force: boolean,
): Promise<{ data: unknown; cached: boolean; cacheKey: string; tag: string }> {
  // The Senior Video Editor caches per *clip*, not per group (see
  // getVideoEditorResult) — branch before the group-level cache lookup.
  if (agentId === 'video-editor') {
    return getVideoEditorResult(objects, depth, force)
  }
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

// Senior Video Editor — analyses every video clip in the group, caching each
// one by its own identity so a given video is sent to Gemini exactly once,
// ever. Adding/removing clips or regrouping only pays for genuinely new videos;
// re-runs of already-watched clips are free. Capped at MAX_VIDEO_CLIPS/group.
async function getVideoEditorResult(
  objects: CanvasObject[],
  depth: AnalysisDepth,
  force: boolean,
): Promise<{ data: unknown; cached: boolean; cacheKey: string; tag: string }> {
  const tag = modelTag('video-editor', depth)
  const groupKey = analysisHash(objects, tag)

  const clipObjects = objects.filter((o) => o.type === 'video-clip')
  const analyzable = clipObjects.slice(0, MAX_VIDEO_CLIPS)
  const skipped = clipObjects.length - analyzable.length
  if (analyzable.length === 0) {
    return { data: assembleVideoEditorBreakdown([], 0), cached: true, cacheKey: groupKey, tag }
  }

  const clipTag = videoClipCacheTag()
  let allCached = true
  const breakdowns = await mapWithConcurrency(
    analyzable,
    VIDEO_CLIP_CONCURRENCY,
    async (o): Promise<VideoClipBreakdown> => {
      const clip = o.data as VideoClipData
      // Hash the clip alone (not the group) so its bucket is independent of
      // what else is on the canvas.
      const perClipKey = analysisHash([o], clipTag)
      if (!force) {
        const [hit] = await db
          .select()
          .from(schema.groupAnalysis)
          .where(eq(schema.groupAnalysis.cacheKey, perClipKey))
          .limit(1)
        if (hit) return hit.analysis as VideoClipBreakdown
      }
      allCached = false
      const breakdown = await analyzeVideoForEditor(clip)
      // Never cache a failed clip — a re-run should get a fresh attempt.
      if (!breakdown.unavailableReason) {
        await db
          .insert(schema.groupAnalysis)
          .values({ cacheKey: perClipKey, model: clipTag, analysis: breakdown as object })
          .onConflictDoNothing()
      }
      return breakdown
    },
  )

  return {
    data: assembleVideoEditorBreakdown(breakdowns, skipped),
    cached: allCached,
    cacheKey: groupKey,
    tag,
  }
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
    const { data, cached, cacheKey } = await getAgentResult(group.objects, agentId, depth, force)
    // Mirror the displayed read into the per-board table so MCP
    // get_board surfaces it without depending on browser
    // localStorage. art-director → 'ad'; video-editor → 'video';
    // everything else → 'sectioned' (matches SlotState mapping).
    const kind: DisplayKind =
      agentId === 'art-director' ? 'ad' : agentId === 'video-editor' ? 'video' : 'sectioned'
    await recordGroupDisplay({
      boardId,
      objects: group.objects,
      agentIds: [agentId],
      kind,
      data,
    }).catch((e) => console.warn('recordGroupDisplay (analyze) failed', e))
    return c.json({ agentId, data, cached, groupKey: cacheKey })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('ANTHROPIC_API_KEY')) {
      return c.json({ error: 'Analysis not configured' }, 503)
    }
    if (msg.includes('GEMINI_API_KEY')) {
      return c.json({ error: 'Video analysis not configured — set GEMINI_API_KEY' }, 503)
    }
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
      // Same mirror as the fresh path — a cache hit still represents
      // the user re-running this combo, so it's what should surface
      // server-side.
      await recordGroupDisplay({
        boardId,
        objects: group.objects,
        agentIds: sortedIds,
        kind: 'brief',
        data: hit.analysis,
      }).catch((e) => console.warn('recordGroupDisplay (synth cache hit) failed', e))
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
    await recordGroupDisplay({
      boardId,
      objects: group.objects,
      agentIds: sortedIds,
      kind: 'brief',
      data,
    }).catch((e) => console.warn('recordGroupDisplay (synth fresh) failed', e))

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
