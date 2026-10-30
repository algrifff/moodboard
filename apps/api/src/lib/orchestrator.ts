import Anthropic from '@anthropic-ai/sdk'
import type {
  AgentContentBlock,
  AgentMessage,
  AgentStreamEvent,
  AgentToolResultBlock,
  AgentToolUseBlock,
  DesignProgress,
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

// The server's client, or null when no key is configured.
export function defaultModelClient(): ModelClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  return apiKey ? anthropicModelClient(new Anthropic({ apiKey })) : null
}

export type ToolRunOptions = {
  // A long tool (design_output) reports where it is; streamed, not stored.
  onProgress?: (progress: DesignProgress) => void
  signal?: AbortSignal
}

export type OrchestratorTools = {
  definitions: Anthropic.Tool[]
  run: (name: string, input: unknown, opts?: ToolRunOptions) => Promise<ToolOutcome>
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
- Items are images, sticky notes, text, web pages, videos, PDFs, Spotify, Drive files, fonts, voice notes, Figma frames and design outputs, each with a position and size in world pixels.
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
- A message may begin with a "[Linear issue LIN-123] …" block: that issue is the brief for the thread. Take the client from it (the block names the client when its team or project is mapped; otherwise use the board's client or ask) and read that client's kit. get_linear_issue re-reads an issue or reads another. The only write to Linear is post_linear_comment (below) — never claim to have changed an issue any other way.
- If a client or kit can't be found, say so and list what does exist instead of guessing.

Templates and outputs:
- Designs are self-contained HTML outputs made from templates (list_templates: thumbnail, social post, 16:9 deck, landing page, one-pager, plus the team's own). A template's slots are named text or image fields; the client's kit skins it.
- create_output makes one (template + client + kit + slot values); get_output reads it back; update_output_slots edits slots as a new version; update_output_html makes exact find/replace edits to its HTML/CSS (structure, layout, adding or removing deck slides); place_output_on_board shows it on the canvas. Text slots are plain text — write copy in the kit's voice, no HTML. Image slots take a library asset URL from search_assets. add_asset_to_board lays a library asset out on the canvas as a reference.

Figma (read-only; HTML is the output, nothing goes back to Figma):
- import_figma_frame brings a Figma frame onto the board as a card (rendered to PNG, saved to the library, remembering its file and frame). A file link needs a frame name; the tool lists the frames if you don't have one. get_figma_frame shows you a frame on the board — its picture and an outline of its layers, text, spacing and colours.
- A Figma frame is a visual reference, not a deliverable. When the user wants something made "like this" or "from this frame", pass the frame's name as figmaFrames to design_output / design_video: the designer sees it and matches its layout in the client's kit — not Figma's colours, unless they are the kit's.
- figma_kit_from_file turns a Figma file's styles into a style kit (a new kit for the client, or a new version of one). Only when the user asks; dryRun:true shows the mapping without saving, and the result lists what was mapped and skipped.

Making designs ("I need X for client Y"):
- design_output is the designer: it builds 2–3 distinct options (different templates, layouts or copy angles), renders each, critiques it visually and revises, and shows them to the user as cards with thumbnails. Use it for any request to make a thumbnail, social post, deck, landing page or one-pager; use create_output/update_output_* yourself only for small direct edits to an existing output.
- Before calling it you need: the client (and its kit, when it has more than one), the format, and the core message. Audience and tone sharpen the brief; take them from the request, the kit's voice or the Linear issue, and only ask if nothing gives them. Ask for what's missing in one short message — never for what you already have — otherwise go straight to design_output. "Thumbnail for Acme's launch video, punchy, dark" is complete: client Acme, format thumbnail, message the launch, tone punchy and dark.
- With a Linear issue attached, the issue is the brief: take the client from it (or the board), the format and message from its title and description, and pass its identifier as linearIssue. Don't re-ask what the issue says.
- Write design_output's brief as the designer's whole brief: core message, audience, tone, must-include copy or facts, anything the issue or the user said to avoid. It reuses earlier results for an identical brief; pass regenerate:true only when the user asks for fresh options.
- After it returns, don't describe every option in detail — the cards show them. One or two lines: what differs between the options and which you'd pick and why. The user picks on the card (or tells you; then call pick_design_variant).
- post_linear_comment posts a picked option to the Linear issue with a share link and its thumbnail (pass design_output's runId as run to post whatever they picked on the card). Only when the user has picked an option and asks you to post it — never on your own initiative, never an option nobody picked. The card also has its own post button.

Films (silent MP4 promo spots):
- design_video is the video agent: it writes a script and scene list, builds the film from a video template in the client's kit, looks at key frames, fixes what's off and queues the MP4 render. Use it for any request for a video, promo spot, trailer or social video. Same intake as design_output (client, kit if several, the message) plus the length and format if given (16:9 or 9:16 vertical for social); write the brief as the agent's whole brief — message, audience, tone, must-include copy, length, anything to avoid. It makes ONE film, not options.
- Rendering runs in the background. The result card shows live progress and then the finished video with a download button, so don't wait on it, poll it or describe it frame by frame: say in a line or two what the film does and that the MP4 is rendering. render_video queues (another) MP4 of an existing video output at 30 or 60 fps; get_render_job reads a job only when the user asks how it's going.
- Videos have no audio. Imported video clips on the board are references and poster stills only.

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

export function describeModelError(e: unknown): string {
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
    // `results` is what the thread stores; `forModel` also carries any
    // pictures a tool attached (Figma frames), for this run's next turn only.
    const results: AgentToolResultBlock[] = []
    const forModel: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      let outcome: ToolOutcome
      try {
        outcome = await tools.run(use.name, use.input, {
          signal,
          onProgress: (progress) => emit({ type: 'tool-progress', toolUseId: use.id, progress }),
        })
      } catch (e) {
        console.error('orchestrator tool failed', use.name, e)
        outcome = { ok: false, error: `Tool crashed: ${e instanceof Error ? e.message : e}` }
      }
      if (outcome.ok) {
        const objects = outcome.effects?.objects ?? []
        if (objects.length > 0) emit({ type: 'board', objects, removed: [] })
        const groups = outcome.effects?.groups ?? []
        if (groups.length > 0) emit({ type: 'groups', groups })
        const text = JSON.stringify(outcome.payload)
        results.push({ type: 'tool_result', tool_use_id: use.id, content: text })
        forModel.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.images?.length
            ? [
                { type: 'text', text },
                ...outcome.images.map(
                  (img): Anthropic.ImageBlockParam => ({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: img.mediaType,
                      data: img.data.toString('base64'),
                    },
                  }),
                ),
              ]
            : text,
        })
      } else {
        const block = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: outcome.error,
          is_error: true,
        }
        results.push(block)
        forModel.push(block)
      }
    }
    await persist('user', results)
    messages.push({ role: 'user', content: forModel })
  }

  await notice(`Stopped after ${maxIterations} steps. Ask me to carry on if there’s more to do.`)
}
