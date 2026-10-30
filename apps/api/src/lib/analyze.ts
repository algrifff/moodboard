import Anthropic from '@anthropic-ai/sdk'
import type { AgentId, CanvasObject } from '@moodboard/shared'
import { getAgent, SYNTHESIZER } from './agents'
import { buildGroupContent } from './analyzeContent'
import { DEEP_MODEL, DEFAULT_DEPTH, FAST_MODEL, type AnalysisDepth } from './modelTags'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set — /api/boards/:id/analyze will 503')
}

const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null

// System prompts and output schemas live in agents.ts. This module is the
// content builder + Anthropic transport — agent-agnostic.

/**
 * Run a single agent against a group. Returns the agent-specific data
 * (validated against the agent's zod schema).
 */
export async function analyzeGroup(
  objects: CanvasObject[],
  agentId: AgentId,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  // The Senior Video Editor doesn't run on Claude — it's analysed per-clip in
  // the route (getVideoEditorResult) so each video caches independently. Guard
  // against a misroute landing on the Anthropic path below.
  if (agentId === 'video-editor') {
    throw new Error('video-editor must be analysed per-clip in the route, not analyzeGroup')
  }
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const agent = getAgent(agentId)
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: agent.maxTokens,
    system: [
      {
        type: 'text',
        text: agent.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: agent.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next block
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = agent.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Agent ${agent.id} JSON failed schema: ${result.error.message}`)
  }
  return result.data
}

/**
 * Synthesise a unified read from multiple agents' outputs. The moodboard's
 * content + each agent's read are fed in as context for the synthesiser.
 */
export async function synthesizeGroup(
  objects: CanvasObject[],
  agentResults: Array<{ id: AgentId; label: string; data: unknown }>,
  depth: AnalysisDepth = DEFAULT_DEPTH,
): Promise<unknown> {
  if (!client) {
    throw new Error('Anthropic client not configured (ANTHROPIC_API_KEY missing)')
  }
  const model = depth === 'fast' ? FAST_MODEL : DEEP_MODEL
  const content = await buildGroupContent(objects)

  // Append each prior agent's output as a labelled text block so the
  // synthesiser can read them as separate "specialist takes."
  for (const r of agentResults) {
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
    content.push({
      type: 'text',
      text: `--- ${r.label}'s read ---\n${body}\n--- end ${r.label}'s read ---`,
    })
  }
  content.push({
    type: 'text',
    text: 'Now: synthesise these into one unified read.',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: Anthropic.Message = (await client.messages.create({
    model,
    max_tokens: SYNTHESIZER.maxTokens,
    system: [
      {
        type: 'text',
        text: SYNTHESIZER.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: {
      format: { type: 'json_schema', schema: SYNTHESIZER.jsonSchema },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as Anthropic.Message

  let parsed: unknown
  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        parsed = JSON.parse(block.text)
        break
      } catch {
        // try next
      }
    }
  }
  if (parsed === undefined) {
    throw new Error('Claude returned no parseable JSON output')
  }
  const result = SYNTHESIZER.outputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Synthesiser JSON failed schema: ${result.error.message}`)
  }
  return result.data
}
