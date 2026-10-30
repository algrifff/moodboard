import Anthropic from '@anthropic-ai/sdk'
import type {
  AgentContentBlock,
  AgentMessage,
  AgentStreamEvent,
  AgentToolResultBlock,
  AgentToolUseBlock,
} from '@moodboard/shared'
import type { ToolOutcome } from './canvasTools'
import { DEEP_MODEL } from './modelTags'

// The sidebar orchestrator: a Claude tool-use loop over the canvas tools,
// streamed to the browser. Everything it depends on is injected — the model
// client, the tools, persistence and the event sink — so the loop is tested
// with fakes (orchestrator.test.ts) and the route wires the real ones.

export const MAX_TOOL_ITERATIONS = 8
const MAX_TOKENS = 16000

export interface ModelClient {
  streamTurn(
    params: Anthropic.MessageStreamParams,
    opts: { onText: (delta: string) => void; signal?: AbortSignal },
  ): Promise<Anthropic.Message>
}

export function anthropicModelClient(client: Anthropic): ModelClient {
  return {
    async streamTurn(params, { onText, signal }) {
      const stream = client.messages.stream(params, { signal })
      stream.on('text', onText)
      return stream.finalMessage()
    },
  }
}

export type OrchestratorTools = {
  definitions: Anthropic.Tool[]
  run: (name: string, input: unknown) => Promise<ToolOutcome>
}

export type OrchestratorStore = {
  append: (
    role: AgentMessage['role'],
    content: AgentContentBlock[],
    isError?: boolean,
  ) => Promise<AgentMessage>
}

export const SYSTEM_PROMPT = `You are the studio's design agent, working inside moodboard.ai — an infinite-canvas mood board shared by one internal creative team. You sit in a sidebar next to the board the user has open, and you act on that board with tools.

How the board works:
- Items are images, sticky notes, text, web pages, videos, PDFs, Spotify, Drive files, fonts, voice notes and design outputs, each with a position and size in world pixels.
- Items whose boxes are within 48px of each other automatically form a group; a group shows a coloured outline, a palette and an analysis panel. Isolated items are not groups.
- Specialist agents (art director, copywriter, business analyst, audience profiler, channel strategist, video editor) read a group. Running two or more synthesises their reads into a one-page brief that appears on the group's panel.

How to work:
- Start from the real board: call get_board before moving or analysing anything, and refer to items by the ids it returns. Never invent ids.
- A user message may end with "[Selected on canvas: id, id, …]" — the items the user has selected right now. "These" / "this" means those items. Without a selection, match what the user describes by type and label from get_board; if it's genuinely ambiguous, ask a short question instead of guessing.
- To pull items together, use group_objects. To analyse, use analyze_group with the group's member ids. For "a brief", combine art-director and copywriter, plus any other specialist the request calls for.
- Prefer doing over describing: if the request is clear, make the change, then say what you did.
- Analysis results are cached and already shown on the canvas panel — don't paste the whole brief back. Summarise in two or three lines (the throughline and what stands out) and point the user to the brief card.
- If a tool fails, read the error, fix the call if you can, otherwise tell the user plainly what blocked you.

Clients, kits, assets and Linear:
- Work is done for a client. list_clients shows the studio's clients and which one this board belongs to. A client's style kit holds its palette, fonts, logos, voice and imagery rules; "use the Acme kit" means get_style_kit with client "Acme". Read the kit before choosing colours or writing copy, and keep to its voice and its don'ts. list_kits shows what exists.
- search_assets finds images, PDFs and fonts already in the asset library (by words, client or kind). Prefer library assets to inventing imagery.
- A message may begin with a "[Linear issue LIN-123] …" block: that issue is the brief for the thread. Take the client from it (the block names the client when its team or project is mapped; otherwise use the board's client or ask), read that client's kit, and say what you would make before making it. get_linear_issue re-reads an issue or reads another. Linear is read-only here — never claim to have updated an issue.
- If a client or kit can't be found, say so and list what does exist instead of guessing.

Templates and outputs:
- Designs are self-contained HTML outputs made from templates (list_templates: thumbnail, social post, 16:9 deck, landing page, one-pager, plus the team's own). A template's slots are named text or image fields; the client's kit skins it.
- create_output makes one (template + client + kit + slot values); get_output reads it back; update_output_slots edits slots as a new version; place_output_on_board shows it on the canvas. Text slots are plain text — write copy in the kit's voice, no HTML. Image slots take a library asset URL from search_assets.

Style: brief, specific, designer-to-designer. Plain sentences, light markdown at most, no headings, no emoji.`

// Persisted blocks → Messages API params. Server notices are skipped, and a
// tool_use left without results (a run that died mid-tools) gets error
// results so the next request is still valid.
export function toModelMessages(history: AgentMessage[]): Anthropic.MessageParam[] {
  const turns = history
    .filter((m) => !m.isError)
    .map((m) => ({ role: m.role, content: [...m.content] }))
  const out: Anthropic.MessageParam[] = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!
    out.push({ role: turn.role, content: turn.content as Anthropic.ContentBlockParam[] })
    if (turn.role !== 'assistant') continue
    const next = turns[i + 1]
    const answered = new Set(
      next?.role === 'user'
        ? next.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : []))
        : [],
    )
    const filler: AgentToolResultBlock[] = turn.content.flatMap((b) =>
      b.type === 'tool_use' && !answered.has(b.id)
        ? [
            {
              type: 'tool_result' as const,
              tool_use_id: b.id,
              is_error: true,
              content: 'Interrupted before this tool ran.',
            },
          ]
        : [],
    )
    if (filler.length === 0) continue
    // Tool results have to lead the user turn that follows the calls.
    if (next?.role === 'user') next.content = [...filler, ...next.content]
    else out.push({ role: 'user', content: filler })
  }
  return out
}

// Keeps only what we store (text + tool_use); drops empty text and any
// fields the SDK adds that we don't replay.
function storableBlocks(content: Anthropic.ContentBlock[]): AgentContentBlock[] {
  const out: AgentContentBlock[] = []
  for (const b of content) {
    if (b.type === 'text' && b.text.trim()) out.push({ type: 'text', text: b.text })
    if (b.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      })
    }
  }
  return out
}

function describeModelError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) {
    return 'The model is rate-limited right now. Give it a minute and try again.'
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return 'The agent’s Anthropic credentials were rejected — check ANTHROPIC_API_KEY on the server.'
  }
  if (e instanceof Anthropic.APIError) {
    return `The model request failed (${e.status ?? 'network'}). Try again in a moment.`
  }
  return `The agent hit an error: ${e instanceof Error ? e.message : String(e)}`
}

export async function runOrchestrator({
  history,
  client,
  tools,
  store,
  emit,
  signal,
  context,
  maxIterations = MAX_TOOL_ITERATIONS,
}: {
  // The full thread, ending with the user's new message.
  history: AgentMessage[]
  // Facts about this board that change between runs (its client…). Kept out
  // of the cached system block.
  context?: string
  client: ModelClient | null
  tools: OrchestratorTools
  store: OrchestratorStore
  emit: (event: AgentStreamEvent) => void
  signal?: AbortSignal
  maxIterations?: number
}): Promise<void> {
  const persist = async (
    role: AgentMessage['role'],
    content: AgentContentBlock[],
    isError = false,
  ) => {
    const message = await store.append(role, content, isError)
    emit({ type: 'message', message })
    return message
  }
  const notice = (text: string) => persist('assistant', [{ type: 'text', text }], true)

  if (!client) {
    await notice('The agent isn’t configured on this server — set ANTHROPIC_API_KEY to enable it.')
    return
  }

  const toolDefs = tools.definitions.map((t, i) =>
    i === tools.definitions.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t,
  )
  const messages = toModelMessages(history)

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      await notice('Stopped.')
      return
    }
    let streamed = ''
    let response: Anthropic.Message
    try {
      response = await client.streamTurn(
        {
          model: DEEP_MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
            ...(context ? [{ type: 'text' as const, text: context }] : []),
          ],
          tools: toolDefs,
          messages,
          // Caches the growing history across the tool-loop iterations.
          cache_control: { type: 'ephemeral' },
        },
        {
          signal,
          onText: (delta) => {
            streamed += delta
            emit({ type: 'text', delta })
          },
        },
      )
    } catch (e) {
      if (signal?.aborted) {
        if (streamed.trim()) await persist('assistant', [{ type: 'text', text: streamed }])
        await notice('Stopped.')
        return
      }
      console.error('orchestrator model call failed', e)
      await notice(describeModelError(e))
      return
    }

    let content = storableBlocks(response.content)
    // A tool input cut off at max_tokens can't be trusted; keep the text.
    const truncated = response.stop_reason === 'max_tokens'
    if (truncated) content = content.filter((b) => b.type !== 'tool_use')
    if (content.length > 0) {
      await persist('assistant', content)
      messages.push({ role: 'assistant', content: content as Anthropic.ContentBlockParam[] })
    }
    if (response.stop_reason === 'refusal') {
      await notice('The model declined that request.')
      return
    }
    if (truncated) {
      await notice('That response ran too long and was cut off. Try asking for less at once.')
      return
    }

    const toolUses = content.filter((b): b is AgentToolUseBlock => b.type === 'tool_use')
    if (toolUses.length === 0) return

    // Sequential: tools write to the same board, and each should see the
    // previous one's changes.
    const results: AgentToolResultBlock[] = []
    for (const use of toolUses) {
      let outcome: ToolOutcome
      try {
        outcome = await tools.run(use.name, use.input)
      } catch (e) {
        console.error('orchestrator tool failed', use.name, e)
        outcome = { ok: false, error: `Tool crashed: ${e instanceof Error ? e.message : e}` }
      }
      if (outcome.ok) {
        const objects = outcome.effects?.objects ?? []
        if (objects.length > 0) emit({ type: 'board', objects, removed: [] })
        const groups = outcome.effects?.groups ?? []
        if (groups.length > 0) emit({ type: 'groups', groups })
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(outcome.payload),
        })
      } else {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.error,
          is_error: true,
        })
      }
    }
    await persist('user', results)
    messages.push({ role: 'user', content: results })
  }

  await notice(`Stopped after ${maxIterations} steps. Ask me to carry on if there’s more to do.`)
}
