import type { AgentId, CanvasObject, VideoClipBreakdown, VideoClipData } from '@moodboard/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { getAgent } from './agents'
import { analyzeGroup, synthesizeGroup } from './analyze'
import { analysisHash } from './analysisHash'
import { analyzeVideoForEditor } from './gemini'
import { recordGroupDisplay, type DisplayKind } from './groupState'
import { DEFAULT_DEPTH, modelTag, synthesisModelTag, type AnalysisDepth } from './modelTags'
import {
  assembleVideoEditorBreakdown,
  mapWithConcurrency,
  MAX_VIDEO_CLIPS,
  VIDEO_CLIP_CONCURRENCY,
  videoClipCacheTag,
} from './videoClips'

// Running specialists against a group: cache first, then the model, then
// mirror the result into board_group_display so the whole team (and the
// canvas panel) sees it. Shared by the analyze routes, the MCP server and
// the sidebar orchestrator.

export type GroupRun = {
  kind: DisplayKind
  agentIds: AgentId[]
  data: unknown
  cached: boolean
  cacheKey: string
}

type RunOptions = { force?: boolean; depth?: AnalysisDepth }

async function cachedAnalysis(cacheKey: string): Promise<unknown | undefined> {
  const [hit] = await db
    .select()
    .from(schema.groupAnalysis)
    .where(eq(schema.groupAnalysis.cacheKey, cacheKey))
    .limit(1)
  return hit?.analysis
}

async function storeAnalysis(cacheKey: string, model: string, analysis: unknown): Promise<void> {
  await db
    .insert(schema.groupAnalysis)
    .values({ cacheKey, model, analysis: analysis as object })
    .onConflictDoNothing()
}

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
    const hit = await cachedAnalysis(cacheKey)
    if (hit !== undefined) return { data: hit, cached: true, cacheKey, tag }
  }
  const data = await analyzeGroup(objects, agentId, depth)
  await storeAnalysis(cacheKey, tag, data)
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
        const hit = await cachedAnalysis(perClipKey)
        if (hit !== undefined) return hit as VideoClipBreakdown
      }
      allCached = false
      const breakdown = await analyzeVideoForEditor(clip)
      // Never cache a failed clip — a re-run should get a fresh attempt.
      if (!breakdown.unavailableReason) await storeAnalysis(perClipKey, clipTag, breakdown)
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

export function displayKindFor(agentId: AgentId): DisplayKind {
  if (agentId === 'art-director') return 'ad'
  if (agentId === 'video-editor') return 'video'
  return 'sectioned'
}

export async function runAgentOnGroup(
  boardId: string,
  objects: CanvasObject[],
  agentId: AgentId,
  { force = false, depth = DEFAULT_DEPTH }: RunOptions = {},
): Promise<GroupRun> {
  const { data, cached, cacheKey } = await getAgentResult(objects, agentId, depth, force)
  const kind = displayKindFor(agentId)
  await recordGroupDisplay({ boardId, objects, agentIds: [agentId], kind, data }).catch((e) =>
    console.warn('recordGroupDisplay (agent) failed', e),
  )
  return { kind, agentIds: [agentId], data, cached, cacheKey }
}

export async function runSynthesisOnGroup(
  boardId: string,
  objects: CanvasObject[],
  agentIds: AgentId[],
  { force = false, depth = DEFAULT_DEPTH }: RunOptions = {},
): Promise<GroupRun> {
  const sortedIds = [...agentIds].sort()
  const synthTag = synthesisModelTag(sortedIds, depth)
  const cacheKey = analysisHash(objects, synthTag)

  let data = force ? undefined : await cachedAnalysis(cacheKey)
  const cached = data !== undefined
  if (data === undefined) {
    // Sequential rather than parallel to stay polite to Anthropic — the
    // spawn-rate 502s we hit before were from parallel firing on the same
    // input set.
    const agentResults: Array<{ id: AgentId; label: string; data: unknown }> = []
    for (const id of sortedIds) {
      const { data: agentData } = await getAgentResult(objects, id, depth, false)
      agentResults.push({ id, label: getAgent(id).label, data: agentData })
    }
    data = await synthesizeGroup(objects, agentResults, depth)
    await storeAnalysis(cacheKey, synthTag, data)
  }
  // A cache hit still represents someone running this combo, so it's what
  // should surface for the team.
  await recordGroupDisplay({ boardId, objects, agentIds: sortedIds, kind: 'brief', data }).catch(
    (e) => console.warn('recordGroupDisplay (synth) failed', e),
  )
  return { kind: 'brief', agentIds: sortedIds, data, cached, cacheKey }
}

// Maps the model-client failures callers translate into a 503 / a clear
// "not configured" tool error.
export function analysisNotConfigured(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('ANTHROPIC_API_KEY')) return 'Analysis not configured — set ANTHROPIC_API_KEY'
  if (msg.includes('GEMINI_API_KEY')) return 'Video analysis not configured — set GEMINI_API_KEY'
  return null
}
