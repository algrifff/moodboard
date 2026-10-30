import Anthropic from '@anthropic-ai/sdk'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import {
  assetMediaKindSchema,
  slotNameSchema,
  SLOT_TEXT_MAX,
  videoFpsSchema,
  videoScriptSchema,
  VIDEO_MAX_DURATION_MS,
  type AssetMediaKind,
  type DesignProgress,
  type DesignStage,
  type DesignVariant,
  type VideoFps,
  type VideoScript,
} from '@moodboard/shared'
import { z } from 'zod'
import type { TextEdit } from './docEdits'
import {
  assetLine,
  kitSection,
  templateLine,
  type DesignAsset,
  type DesignCache,
  type DesignContext,
  type DesignToolbox,
  type ToolResult,
} from './designer'
import { DEEP_MODEL } from './modelTags'
import { describeModelError, type ModelClient } from './orchestrator'

// The video agent: one bounded Claude tool loop that goes script → scene list
// → HTML composition → key-frame renders → critique and fixes, then hands
// the finished version to the render queue (the MP4 itself is a background
// job; the agent never waits for it). Same machinery as the designer: the
// composition is a video-template output edited through slots and
// find/replace on its HTML/CSS (docEdits rules, which also keep data-duration
// valid and the motion seekable), and the model looks at its own renders as
// image blocks. Model, toolbox, cache and the queue hook are injected.

export const VIDEO_AGENT_MAX_STEPS = 16
export const VIDEO_AGENT_MAX_RENDERS = 3
export const VIDEO_AGENT_MAX_FRAMES = 4
// Key frames are for looking, not for the film: smaller than the spot.
export const VIDEO_AGENT_FRAME_EDGE = 960
const MAX_TOKENS = 8000

export type BoardClip = {
  title: string
  channel: string
  durationSec: number
  // A library file (/api/files/…): the clip's poster still, usable in an
  // image slot. Never the clip itself — videos are silent stills here.
  posterUrl: string | null
}

export type VideoContext = {
  brief: string
  client: { id: string; name: string } | null
  kit: DesignContext['kit']
  templates: DesignContext['templates']
  assets: DesignAsset[]
  clips: BoardClip[]
  fps: VideoFps
}

export type KeyFrame = { timeMs: number; png: Buffer }

export type VideoToolbox = Pick<
  DesignToolbox,
  'searchAssets' | 'createOutput' | 'getSource' | 'updateSlots' | 'updateHtml'
> & {
  renderFrames(
    outputId: string,
    version: number,
    timesMs: number[],
  ): Promise<ToolResult<{ frames: KeyFrame[]; durationMs: number }>>
  // Queue the MP4 render of the finished version. `jobId` is null when that
  // version already has a render at this fps.
  enqueueRender(
    outputId: string,
    version: number,
    fps: VideoFps,
  ): Promise<ToolResult<{ jobId: string | null }>>
}

export type VideoRun = DesignVariant & {
  script: VideoScript | null
  fps: VideoFps
  durationMs: number | null
  jobId: string | null
}

const textEdit = z.object({
  find: z.string().min(1).max(20_000).describe('Exact text currently in the document.'),
  replace: z.string().max(60_000),
  all: z.boolean().optional().describe('Replace every occurrence (default: must match once).'),
})

const TOOL_SHAPES = {
  write_script: {
    description:
      'First: the script. A logline and the scene list — for each scene its start and length in ms, the words/visual on screen, and what it has to do. Silent film: on-screen text and motion only. Scenes should be contiguous and add up to the length you intend (the starter spot is 15 000 ms; you may retime it up to 60 000 ms with update_output_html).',
    input: videoScriptSchema.shape,
  },
  search_assets: {
    description:
      "Search the client's asset library (full text over names, captions and tags). Image slots only take a url from here or from the clip posters listed in your brief.",
    input: {
      query: z.string().max(200).optional(),
      kind: assetMediaKindSchema.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  create_output: {
    description:
      "Create the video's output from a video template, filling its slots with your script's copy. Text slots are plain text; image slots take a library url. Unfilled slots keep the template's default copy — fill every text slot. Once.",
    input: {
      template: z.string().min(1).describe('Template name or id from the list you were given.'),
      name: z.string().min(1).max(120).describe('A short name for the video.'),
      slots: z.record(slotNameSchema, z.string().max(SLOT_TEXT_MAX)),
    },
  },
  get_output_source: {
    description:
      "The output's current HTML and CSS (and slot values). Read it before update_output_html so your find strings are exact and you can see the timeline (data-duration, each scene's --at / --len, animation delays).",
    input: {},
  },
  update_output_slots: {
    description: 'Change slot values (null resets one to the template default). New version.',
    input: { slots: z.record(slotNameSchema, z.string().max(SLOT_TEXT_MAX).nullable()) },
  },
  update_output_html: {
    description:
      'Edit the HTML and/or CSS with exact find/replace edits (new version): retime scenes (change data-duration and the scene/animation delays together), add or remove a feature beat, change layout. Rules that keep it renderable: every moment is a CSS animation with an explicit delay and fill-mode both, finished before data-duration; no transitions, no animation-play-state, no scripts, no <style>/<link>, no external URLs; data-duration stays 500–60000 ms; CSS reads only --kit-* variables and its own custom properties.',
    input: {
      html: z.array(textEdit).max(20).optional(),
      css: z.array(textEdit).max(20).optional(),
    },
  },
  render_key_frames: {
    description: `Look at the film: render up to ${VIDEO_AGENT_MAX_FRAMES} frames at the given times (ms) and see them. Omit times to get the middle of your first scenes. The result also lists any animation that runs past data-duration. You get ${VIDEO_AGENT_MAX_RENDERS} of these calls, so choose times that test the riskiest moments (the headline in, the busiest beat, the end card).`,
    input: {
      timesMs: z
        .array(z.number().int().min(0).max(VIDEO_MAX_DURATION_MS))
        .min(1)
        .max(VIDEO_AGENT_MAX_FRAMES)
        .optional(),
    },
  },
  finish_video: {
    description:
      'Done: the latest version has been looked at and passes your critique. Give it a short name, a one- or two-sentence critique the person will read, and the frame rate to render at (30 unless the brief wants 60). The MP4 render is queued for you.',
    input: {
      name: z.string().min(1).max(120),
      critique: z.string().min(1).max(600),
      fps: videoFpsSchema.optional(),
    },
  },
} satisfies Record<string, { description: string; input: z.ZodRawShape }>

type ToolName = keyof typeof TOOL_SHAPES

export const VIDEO_AGENT_TOOLS: Anthropic.Tool[] = Object.entries(TOOL_SHAPES).map(
  ([name, def], i, all) => {
    const { $schema: _ignored, ...schema } = toJsonSchemaCompat(z.object(def.input)) as {
      $schema?: string
    } & Anthropic.Tool.InputSchema
    return {
      name,
      description: def.description,
      input_schema: schema,
      ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }
  },
)

export const VIDEO_AGENT_SYSTEM = `You are a motion designer at a small studio. You make one short, silent promo film as a self-contained HTML composition: the studio's video templates, skinned by the client's style kit, filled with the client's library imagery and your copy. The film is rendered to MP4 by stepping its CSS animations frame by frame, so everything on screen is a function of time.

How to work:
1. write_script first: a logline and the scene list with start/length in ms. Silent film — every idea has to land in on-screen words and motion. One idea per scene; headlines under ~8 words; numbers big; a clear call to action at the end.
2. create_output from the best-fitting video template, filling every text slot with copy from your script in the kit's voice. Image slots take only a library url (or a clip poster from your brief); if nothing fits, leave the slot at its default rather than forcing an unrelated image.
3. If the script needs a different length or number of beats than the template, read get_output_source and retime with update_output_html: change data-duration and the scenes' --at / --len / animation delays together so every scene still starts where the last one ends and nothing runs past data-duration. Prefer small edits to the template's timeline over rewriting it.
4. render_key_frames at the moments that matter (mid-headline, the busiest beat, the end card) and critique them like a creative director: is the message the first thing read in each scene? Legible at phone size? Anything overflowing, colliding or cut off? Does it look like this client — kit colours, fonts, logo — and follow the kit's don'ts? Is there enough time to read each line (about 3 words per second, plus the entrance)?
5. Fix the biggest problem first (update_output_slots for copy, update_output_html for timing and layout), render again to check, then finish_video. You have a limited number of key-frame renders and steps — don't polish forever.

Rules: text slots are plain text, never HTML. Never invent asset URLs. Keep to the kit's palette and fonts — use var(--kit-…) in CSS rather than hard-coded colours. Motion only as CSS @keyframes with explicit delays and fill-mode both; no transitions, no scripts. No audio: don't mention music or voice-over. Write copy the client could publish. The critique is for the person who'll watch the film: say what it does well and its main trade-off, plainly.`

function clipLine(c: BoardClip): string {
  const mins =
    c.durationSec > 0
      ? ` ${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}`
      : ''
  return `- “${c.title}” by ${c.channel || 'unknown'}${mins}${c.posterUrl ? ` — poster still ${c.posterUrl}` : ' — no poster'}`
}

export function videoPrompt(context: VideoContext): string {
  return [
    `# Brief\n${context.brief}`,
    `Client: ${context.client?.name ?? 'none'}\nFrame rate: ${context.fps} fps`,
    kitSection(context.kit),
    `# Video templates\n${context.templates.map(templateLine).join('\n')}`,
    `# Library assets${context.client ? ` for ${context.client.name}` : ''}\n${
      context.assets.length > 0
        ? `${context.assets.map(assetLine).join('\n')}\n(search_assets finds more.)`
        : 'Nothing in the library yet — leave image slots at their defaults.'
    }`,
    context.clips.length > 0
      ? `# Reference clips on the board\nSilent film, so these are references and stills only — never clip footage. A poster still can go in an image slot.\n${context.clips.map(clipLine).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

type State = {
  script: VideoScript | null
  outputId: string | null
  version: number | null
  template: string | null
  name: string
  durationMs: number | null
  renderCalls: number
  framesRendered: number
  renderedVersion: number | null
  finished: { name: string; critique: string; fps: VideoFps } | null
  lastText: string
  steps: number
}

type BlockResult = Anthropic.ToolResultBlockParam
type ResultContent = Exclude<BlockResult['content'], string | undefined>[number]

export async function runVideoAgent({
  model,
  toolbox,
  context,
  onProgress,
  signal,
  maxSteps = VIDEO_AGENT_MAX_STEPS,
  maxRenders = VIDEO_AGENT_MAX_RENDERS,
}: {
  model: ModelClient
  toolbox: VideoToolbox
  context: VideoContext
  onProgress: (p: DesignProgress) => void
  signal?: AbortSignal
  maxSteps?: number
  maxRenders?: number
}): Promise<VideoRun> {
  const state: State = {
    script: null,
    outputId: null,
    version: null,
    template: null,
    name: 'Video',
    durationMs: null,
    renderCalls: 0,
    framesRendered: 0,
    renderedVersion: null,
    finished: null,
    lastText: '',
    steps: 0,
  }
  let jobId: string | null = null

  const progress = (stage: DesignStage, detail?: string) =>
    onProgress({
      variant: 1,
      of: 1,
      stage,
      ...(detail ? { detail } : {}),
      ...(state.outputId ? { outputId: state.outputId } : {}),
      ...(state.version ? { version: state.version } : {}),
    })

  const result = (status: DesignVariant['status'], error: string | null): VideoRun => ({
    index: 1,
    status,
    cached: false,
    outputId: state.outputId,
    version: state.version,
    name: state.finished?.name ?? state.name,
    template: state.template,
    angle: 'Video',
    critique: state.finished?.critique ?? state.lastText.trim().slice(0, 600),
    renders: state.framesRendered,
    steps: state.steps,
    error,
    script: state.script,
    fps: state.finished?.fps ?? context.fps,
    durationMs: state.durationMs,
    jobId,
  })
  const failed = (error: string) => {
    progress('failed', error)
    return result('failed', error)
  }
  const err = (id: string, error: string): BlockResult => ({
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: error,
  })
  const ok = (id: string, text: string): BlockResult => ({
    type: 'tool_result',
    tool_use_id: id,
    content: text,
  })

  const defaultTimes = (): number[] => {
    const scenes = state.script?.scenes ?? []
    const times = scenes.map((s) => s.startMs + Math.round(s.durationMs * 0.7))
    const spread =
      times.length > VIDEO_AGENT_MAX_FRAMES
        ? Array.from(
            { length: VIDEO_AGENT_MAX_FRAMES },
            (_, i) => times[Math.round((i * (times.length - 1)) / (VIDEO_AGENT_MAX_FRAMES - 1))]!,
          )
        : times
    return spread.length > 0 ? spread : [2000, 6000, 10000, 14000]
  }

  const runTool = async (use: Anthropic.ToolUseBlock): Promise<BlockResult> => {
    const def = TOOL_SHAPES[use.name as ToolName]
    if (!def) return err(use.id, `Unknown tool: ${use.name}`)
    const parsed = z.object(def.input).safeParse(use.input)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      return err(use.id, `Invalid input — ${issues.join('; ')}`)
    }
    const input = parsed.data as Record<string, unknown>
    const needsOutput = () =>
      state.outputId && state.version
        ? null
        : err(use.id, 'There is no output yet — create_output first.')

    switch (use.name as ToolName) {
      case 'write_script': {
        const script = input as unknown as VideoScript
        const end = Math.max(...script.scenes.map((s) => s.startMs + s.durationMs))
        if (end > VIDEO_MAX_DURATION_MS) {
          return err(
            use.id,
            `The script runs ${end} ms; films are at most ${VIDEO_MAX_DURATION_MS} ms.`,
          )
        }
        state.script = script
        progress('script', `${script.scenes.length} scenes · ${(end / 1000).toFixed(0)}s`)
        return ok(
          use.id,
          `Script saved: ${script.scenes.length} scenes, ${end} ms. Now create_output from a video template and fill its slots from the script.`,
        )
      }
      case 'search_assets': {
        progress('assets', typeof input.query === 'string' ? input.query : undefined)
        const r = await toolbox.searchAssets(input as { query?: string; kind?: AssetMediaKind })
        return r.ok ? ok(use.id, r.text) : err(use.id, r.error)
      }
      case 'create_output': {
        if (!state.script) return err(use.id, 'Write the script first with write_script.')
        if (state.outputId) {
          return err(
            use.id,
            `The film already has its output (v${state.version}). Edit it with update_output_slots / update_output_html instead.`,
          )
        }
        const args = input as { template: string; name: string; slots: Record<string, string> }
        progress('template', args.template)
        const r = await toolbox.createOutput(args)
        if (!r.ok) return err(use.id, r.error)
        state.outputId = r.outputId
        state.version = r.version
        state.template = r.template
        state.name = args.name
        progress('filling')
        return ok(use.id, r.text)
      }
      case 'get_output_source': {
        const missing = needsOutput()
        if (missing) return missing
        const r = await toolbox.getSource(state.outputId!)
        return r.ok ? ok(use.id, r.text) : err(use.id, r.error)
      }
      case 'update_output_slots':
      case 'update_output_html': {
        const missing = needsOutput()
        if (missing) return missing
        progress(state.renderCalls > 0 ? 'revising' : 'filling')
        const r =
          use.name === 'update_output_slots'
            ? await toolbox.updateSlots(
                state.outputId!,
                input.slots as Record<string, string | null>,
                state.version!,
              )
            : await toolbox.updateHtml(
                state.outputId!,
                input as { html?: TextEdit[]; css?: TextEdit[] },
                state.version!,
              )
        if (!r.ok) return err(use.id, r.error)
        state.version = r.version
        return ok(use.id, r.text)
      }
      case 'render_key_frames': {
        const missing = needsOutput()
        if (missing) return missing
        if (state.renderCalls >= maxRenders) {
          return err(
            use.id,
            `Key-frame budget used (${maxRenders}). Call finish_video now with your critique of the last frames.`,
          )
        }
        progress('rendering')
        const times = (input.timesMs as number[] | undefined) ?? defaultTimes()
        const r = await toolbox.renderFrames(state.outputId!, state.version!, times)
        if (!r.ok) return err(use.id, r.error)
        state.renderCalls++
        state.framesRendered += r.frames.length
        state.renderedVersion = state.version
        state.durationMs = r.durationMs
        progress('critique', `look ${state.renderCalls} of ${maxRenders}`)
        const content: ResultContent[] = [{ type: 'text', text: r.text }]
        for (const f of r.frames) {
          content.push({ type: 'text', text: `Frame at ${f.timeMs} ms:` })
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: f.png.toString('base64') },
          })
        }
        content.push({
          type: 'text',
          text: `Looks left: ${maxRenders - state.renderCalls}. Critique against the script and the kit, then fix the biggest problem or finish_video.`,
        })
        return { type: 'tool_result', tool_use_id: use.id, content }
      }
      case 'finish_video': {
        const missing = needsOutput()
        if (missing) return missing
        if (state.renderCalls === 0) {
          return err(use.id, 'Look at it with render_key_frames before finishing.')
        }
        if (state.renderedVersion !== state.version && state.renderCalls < maxRenders) {
          return err(
            use.id,
            `You changed it after the last look (now v${state.version}) — render_key_frames again to check before finishing.`,
          )
        }
        const fin = input as { name: string; critique: string; fps?: VideoFps }
        state.finished = { name: fin.name, critique: fin.critique, fps: fin.fps ?? context.fps }
        return ok(use.id, 'Finished. The MP4 render is being queued.')
      }
    }
  }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: videoPrompt(context) }]
  progress('script')

  while (!state.finished && state.steps < maxSteps) {
    if (signal?.aborted) return failed('Stopped.')
    state.steps++
    let response: Anthropic.Message
    try {
      response = await model.streamTurn(
        {
          model: DEEP_MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            { type: 'text', text: VIDEO_AGENT_SYSTEM, cache_control: { type: 'ephemeral' } },
          ],
          tools: VIDEO_AGENT_TOOLS,
          messages,
          cache_control: { type: 'ephemeral' },
        },
        { onText: () => undefined, signal },
      )
    } catch (e) {
      if (signal?.aborted) return failed('Stopped.')
      console.error('video agent model call failed', e)
      return failed(describeModelError(e))
    }

    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (text.trim()) state.lastText = text
    if (response.stop_reason === 'refusal') return failed('The model declined this brief.')

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (response.stop_reason === 'max_tokens') {
      if (text.trim()) messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: 'Your last reply was cut off. Make smaller edits, one tool call at a time.',
      })
      continue
    }
    messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] })

    if (uses.length === 0) {
      if (state.outputId && state.renderCalls > 0 && state.renderedVersion === state.version) {
        state.finished = {
          name: state.name,
          critique: text.trim().slice(0, 600),
          fps: context.fps,
        }
        break
      }
      messages.push({
        role: 'user',
        content: state.script
          ? state.outputId
            ? 'Look at it with render_key_frames, critique it, then finish_video.'
            : 'create_output from a video template, then render_key_frames.'
          : 'Start with write_script.',
      })
      continue
    }

    const results: BlockResult[] = []
    for (const use of uses) {
      try {
        results.push(await runTool(use))
      } catch (e) {
        console.error('video agent tool failed', use.name, e)
        results.push(err(use.id, `Tool crashed: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    messages.push({ role: 'user', content: results })
  }

  if (!state.finished) {
    if (!state.outputId || state.renderCalls === 0) {
      return failed(`Ran out of steps (${maxSteps}) before a film I could look at.`)
    }
    state.lastText = `${state.lastText.trim().slice(0, 500)}${state.lastText.trim() ? ' ' : ''}(Stopped at the ${maxSteps}-step limit.)`
  }

  const fps = state.finished?.fps ?? context.fps
  const queued = await toolbox.enqueueRender(state.outputId!, state.version!, fps)
  if (!queued.ok) {
    return failed(`The film is ready but its MP4 couldn’t be queued: ${queued.error}`)
  }
  jobId = queued.jobId
  progress('render-queued', state.finished?.name ?? state.name)
  progress('done', state.finished?.name ?? state.name)
  return result('done', null)
}

// ---------------------------------------------------------------------------
// With the cache in front
// ---------------------------------------------------------------------------

// A cache hit reuses the film (its output) without running the model; the
// MP4 render is still ensured — a no-op when that version is already
// rendered or queued.
export async function runVideo({
  model,
  context,
  toolbox,
  cache,
  key,
  regenerate = false,
  onProgress,
  signal,
  maxSteps,
  maxRenders,
}: {
  model: ModelClient | null
  context: VideoContext
  toolbox: VideoToolbox
  cache: DesignCache
  key: string
  regenerate?: boolean
  onProgress: (p: DesignProgress) => void
  signal?: AbortSignal
  maxSteps?: number
  maxRenders?: number
}): Promise<VideoRun> {
  onProgress({ variant: 1, of: 1, stage: 'queued' })
  if (!regenerate) {
    const hit = await cache.get(key)
    if (hit?.outputId && hit.version) {
      onProgress({
        variant: 1,
        of: 1,
        stage: 'cached',
        detail: hit.name,
        outputId: hit.outputId,
        version: hit.version,
      })
      const queued = await toolbox.enqueueRender(hit.outputId, hit.version, context.fps)
      return {
        ...hit,
        cached: true,
        script: null,
        fps: context.fps,
        durationMs: null,
        jobId: queued.ok ? queued.jobId : null,
        error: queued.ok ? null : queued.error,
      }
    }
  }
  if (!model) {
    const error =
      'The video agent isn’t configured on this server — set ANTHROPIC_API_KEY to enable it.'
    onProgress({ variant: 1, of: 1, stage: 'failed', detail: error })
    return {
      index: 1,
      status: 'failed',
      cached: false,
      outputId: null,
      version: null,
      name: 'Video',
      template: null,
      angle: 'Video',
      critique: '',
      renders: 0,
      steps: 0,
      error,
      script: null,
      fps: context.fps,
      durationMs: null,
      jobId: null,
    }
  }
  const run = await runVideoAgent({
    model,
    toolbox,
    context,
    onProgress,
    signal,
    maxSteps,
    maxRenders,
  })
  if (run.status === 'done') {
    const { script: _script, fps: _fps, durationMs: _duration, jobId: _job, ...variant } = run
    await cache.put(key, variant)
  }
  return run
}
