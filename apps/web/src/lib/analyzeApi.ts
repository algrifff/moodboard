import {
  aiAnalysisSchema,
  analyzeResponseSchema,
  sectionedParagraphsSchema,
  synthesizeResponseSchema,
  type AgentId,
  type AIAnalysis,
  type SectionedParagraphs,
  type SynthesisBrief,
} from '@moodboard/shared'

export type AgentResult =
  | { agentId: 'art-director'; data: AIAnalysis; cached: boolean; groupKey: string }
  | {
      agentId: 'business-analyst' | 'audience-profiler' | 'channel-strategist' | 'copywriter'
      data: SectionedParagraphs
      cached: boolean
      groupKey: string
    }

export async function analyzeGroup(
  boardId: string,
  objectIds: string[],
  agentId: AgentId,
  opts: { force?: boolean; depth?: 'fast' | 'deep' } = {},
): Promise<AgentResult> {
  const res = await fetch(`/api/boards/${boardId}/analyze`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      objectIds,
      agentId,
      force: opts.force ?? false,
      depth: opts.depth ?? 'deep',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Analyze failed: ${res.status} ${text}`)
  }
  const raw = analyzeResponseSchema.parse(await res.json())

  // Narrow the agent-specific payload here so callers don't have to.
  if (raw.agentId === 'art-director') {
    const data = aiAnalysisSchema.parse(raw.data)
    return { agentId: raw.agentId, data, cached: raw.cached, groupKey: raw.groupKey }
  }
  const data = sectionedParagraphsSchema.parse(raw.data)
  return {
    agentId: raw.agentId,
    data,
    cached: raw.cached,
    groupKey: raw.groupKey,
  }
}

export type SynthesisResult = {
  agentIds: AgentId[]
  data: SynthesisBrief
  cached: boolean
  groupKey: string
}

export async function synthesizeGroupApi(
  boardId: string,
  objectIds: string[],
  agentIds: AgentId[],
  opts: { force?: boolean; depth?: 'fast' | 'deep' } = {},
): Promise<SynthesisResult> {
  const res = await fetch(`/api/boards/${boardId}/synthesize`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      objectIds,
      agentIds,
      force: opts.force ?? false,
      depth: opts.depth ?? 'deep',
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Synthesize failed: ${res.status} ${text}`)
  }
  return synthesizeResponseSchema.parse(await res.json())
}
