import Anthropic from '@anthropic-ai/sdk'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import {
  assetMediaKindSchema,
  OUTPUT_FORMAT_LABELS,
  slotNameSchema,
  SLOT_TEXT_MAX,
  viewportSize,
  type AssetMediaKind,
  type DesignProgress,
  type DesignStage,
  type DesignVariant,
  type KitTokens,
  type OutputFormat,
  type TemplateSummary,
} from '@moodboard/shared'
import { z } from 'zod'
import type { TextEdit } from './docEdits'
import { DEEP_MODEL } from './modelTags'
import { describeModelError, type ModelClient } from './orchestrator'

// The designer: a specialist agent the orchestrator calls through
// design_output. Each variant is its own bounded Claude tool loop — pick a
// template, fill it from the kit and the library, render a frame, look at
// it (the PNG goes back as an image block), patch slots or the HTML/CSS,
// render again, and finish when its own critique passes or the bounds are
// hit. Multi-section formats plan an outline before building.
//
// Everything it touches is injected: the model client, the tools (a
// DesignToolbox — real outputs + the frame renderer in designToolbox.ts,
// fakes in designer.test.ts) and the per-variant cache.

export const DESIGNER_MAX_STEPS = 12
export const DESIGNER_MAX_RENDERS = 4
const MAX_TOKENS = 8000

export const MULTI_SECTION_FORMATS: ReadonlySet<OutputFormat> = new Set([
  'deck',
  'landing',
  'one-pager',
])

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type DesignAsset = {
  name: string
  url: string
  caption: string | null
  kind: AssetMediaKind
  width: number | null
  height: number | null
  colors: string[]
}

export type DesignContext = {
  brief: string
  format: OutputFormat
  client: { id: string; name: string } | null
  kit: { id: string; name: string; version: number; tokens: KitTokens } | null
  templates: TemplateSummary[]
  // A first look at the client's library; search_assets finds more.
  assets: DesignAsset[]
  linearIssue: string | null
}

export type VariantPlan = {
  index: number
  of: number
  angle: string
  angleBrief: string
  suggestedTemplate: string | null
  otherAngles: string[]
}

const ANGLES: { angle: string; brief: string }[] = [
  {
    angle: 'Direct',
    brief:
      'The clearest, most literal answer to the brief: the core message, large, and nothing that competes with it.',
  },
  {
    angle: 'New layout',
    brief:
      'A visibly different composition from option 1. Use a different template if one fits the format; otherwise change the arrangement through the HTML/CSS (flip image and copy, change the scale relationship, crop the image differently, move the brand).',
  },
  {
    angle: 'Bolder copy',
    brief:
      "A sharper, more provocative line on the same message — still in the kit's voice and inside its don'ts.",
  },
]

export function planVariants(context: DesignContext, count: number): VariantPlan[] {
  const n = Math.max(1, Math.min(ANGLES.length, count))
  const chosen = ANGLES.slice(0, n)
  return chosen.map((a, i) => ({
    index: i + 1,
    of: n,
    angle: a.angle,
    angleBrief: a.brief,
    suggestedTemplate:
      context.templates.length > 0 ? context.templates[i % context.templates.length]!.name : null,
    otherAngles: chosen.filter((_, j) => j !== i).map((o) => `${o.angle}: ${o.brief}`),
  }))
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolResult<T = object> = ({ ok: true; text: string } & T) | { ok: false; error: string }

export interface DesignToolbox {
  searchAssets(input: {
    query?: string
    kind?: AssetMediaKind
    limit?: number
  }): Promise<ToolResult>
  createOutput(input: {
    template: string
    name: string
    slots: Record<string, string>
  }): Promise<ToolResult<{ outputId: string; version: number; template: string }>>
  getSource(outputId: string): Promise<ToolResult>
  updateSlots(
    outputId: string,
    slots: Record<string, string | null>,
    baseVersion: number,
  ): Promise<ToolResult<{ version: number }>>
  updateHtml(
    outputId: string,
    edits: { html?: TextEdit[]; css?: TextEdit[] },
    baseVersion: number,
  ): Promise<ToolResult<{ version: number }>>
  render(
    outputId: string,
    version: number,
    opts: { section?: number },
  ): Promise<ToolResult<{ png: Buffer; sections: number; width: number; height: number }>>
}

const textEdit = z.object({
  find: z.string().min(1).max(20_000).describe('Exact text currently in the document.'),
  replace: z.string().max(60_000),
  all: z.boolean().optional().describe('Replace every occurrence (default: must match once).'),
})

const TOOL_SHAPES = {
  plan_outline: {
    description:
      'Multi-section formats only (deck, landing page, one-pager), before create_output: the sections this piece needs, in order. Then make the document match it with update_output_html (duplicate, remove or reorder sections) and fill copy section by section.',
    input: {
      sections: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            purpose: z.string().min(1).max(300).describe('What this section has to do.'),
          }),
        )
        .min(1)
        .max(16),
    },
  },
  search_assets: {
    description:
      "Search the client's asset library (full text over names, captions and tags). Image slots only take a url from here.",
    input: {
      query: z.string().max(200).optional(),
      kind: assetMediaKindSchema.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
  },
  create_output: {
    description:
      "Create this variant's output from a template, filling slots. Text slots take plain text (no HTML; newlines become line breaks); image slots take a library url. Unfilled slots keep the template's default copy — fill every text slot. Once per variant.",
    input: {
      template: z.string().min(1).describe('Template name or id from the list you were given.'),
      name: z.string().min(1).max(120).describe('A short name for this option.'),
      slots: z.record(slotNameSchema, z.string().max(SLOT_TEXT_MAX)),
    },
  },
  get_output_source: {
    description:
      "The output's current HTML and CSS (and slots) — read it before update_output_html so your find strings are exact.",
    input: {},
  },
  update_output_slots: {
    description: 'Change slot values (null resets one to the template default). New version.',
    input: { slots: z.record(slotNameSchema, z.string().max(SLOT_TEXT_MAX).nullable()) },
  },
  update_output_html: {
    description:
      'Edit the HTML and/or CSS with exact find/replace edits (new version). For structure slots can’t express: layout CSS, duplicating/removing/reordering sections, decorative elements. Keep data-slot markers on everything that holds copy or imagery. No <script>/<style>/<link>, no event handlers, no external URLs; CSS reads only --kit-* variables and its own custom properties; motion only as CSS keyframes.',
    input: {
      html: z.array(textEdit).max(20).optional(),
      css: z.array(textEdit).max(20).optional(),
    },
  },
  render_output_frame: {
    description:
      'Render the current version to a PNG at its real size (animations at their end state) and look at it. For multi-section documents pass section (0-based) to see one section; the result says how many there are.',
    input: { section: z.number().int().min(0).max(40).optional() },
  },
  finish_variant: {
    description:
      'Done: the last render passes your critique (or you are out of renders). Give the option a short name and a one- or two-sentence critique the person will read next to the thumbnail.',
    input: {
      name: z.string().min(1).max(120),
      critique: z.string().min(1).max(600),
    },
  },
} satisfies Record<string, { description: string; input: z.ZodRawShape }>

type ToolName = keyof typeof TOOL_SHAPES

export const DESIGNER_TOOLS: Anthropic.Tool[] = Object.entries(TOOL_SHAPES).map(
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

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const DESIGNER_SYSTEM = `You are a senior designer at a small studio. You produce one finished design option as a self-contained HTML output, built from the studio's templates, skinned by the client's style kit, filled with the client's library assets and your copy. You work with tools and you look at your own renders.

How to work:
1. Multi-section formats (deck, landing page, one-pager): plan_outline first — the sections the brief needs, in order.
2. create_output from the suggested template (or another template for this format if it clearly fits better). Fill every text slot with real copy for this brief in the kit's voice. Image slots take only a url from the library list or search_assets; if nothing fits, leave the slot at its default rather than forcing an unrelated image.
3. For multi-section documents, make the structure match your outline with update_output_html (read get_output_source first; duplicate a section to add one, delete one you don't need), then fill the copy.
4. render_output_frame and critique the render like an art director: Is the core message the first thing you read? Is the hierarchy clear with one focal point? Is every line legible against its background (contrast, size)? Does any copy overflow, wrap badly or collide? Does the image crop work? Does it look like this client — kit colours, fonts, logo — and follow the kit's don'ts?
5. Fix the biggest problem first, with update_output_slots for copy or update_output_html for structure and CSS, then render again to check the fix. Change one thing at a time when you're unsure.
6. When a render passes, call finish_variant. Don't polish forever: you have a limited number of renders and steps.

Format notes:
- Thumbnail (1280×720): it is seen at ~320px wide in a feed. Headline of 2–6 words, huge, highest contrast in the frame. One image, one idea. A kicker or tag only if it adds something.
- Social post: one statement, readable on a phone, room to breathe.
- Deck: one idea per slide, headlines under ~10 words, numbers big. Cover, the argument, a close.
- Landing page: hero headline + one supporting line + one clear call to action above the fold; sections that each answer one question.
- One-pager: scannable — headline, short intro, three or four labelled blocks, a contact line.

Rules: text slots are plain text, never HTML. Never invent asset URLs. Keep to the kit's palette and fonts — the template already reads them through --kit-* variables; in CSS use var(--kit-…) rather than hard-coded colours. Write copy the client could publish; no lorem ipsum, no placeholders. When you finish, the critique is for the person choosing between options: say what this option does well and its main trade-off, plainly.`

const line = (label: string, items: string[]) =>
  items.length > 0 ? `${label}: ${items.join('; ')}` : null

function kitSection(kit: DesignContext['kit']): string {
  if (!kit) {
    return '# Style kit\nNone — the output uses the neutral house style. Write plainly and confidently.'
  }
  const t = kit.tokens
  const fonts = [
    t.fonts.display ? `display ${t.fonts.display.family}` : null,
    t.fonts.body ? `body ${t.fonts.body.family}` : null,
  ].filter(Boolean)
  return [
    `# Style kit: ${kit.name} v${kit.version}`,
    t.summary ? `Summary: ${t.summary}` : null,
    line(
      'Palette',
      t.palette.map((p) => `${p.role} ${p.hex}${p.usage ? ` (${p.usage})` : ''}`),
    ),
    fonts.length > 0 || t.fonts.feel
      ? `Fonts: ${fonts.join(', ')}${t.fonts.feel ? `. Feel: ${t.fonts.feel}` : ''}`
      : null,
    t.logos.length > 0
      ? `Logo: ${t.logos.length} variant(s); templates show the kit logo automatically in their brand spot.`
      : 'Logo: none — templates show the brand name as a wordmark instead.',
    line('Voice — tone', t.voice.tone),
    line('Voice — do', t.voice.dos),
    line("Voice — don't", t.voice.donts),
    line('Voice — example lines', t.voice.examples),
    line('Imagery rules', t.imagery.rules),
    line('Notes', t.notes),
  ]
    .filter(Boolean)
    .join('\n')
}

function templateLine(t: TemplateSummary): string {
  const { width, height } = viewportSize(t.viewport)
  const size = t.viewport.kind === 'fixed' ? `${width}×${height}` : 'responsive'
  const slots = t.slots.map((s) => `${s.name} (${s.kind}: ${s.label})`).join(', ')
  return `- “${t.name}” (${size}) — slots: ${slots}`
}

function assetLine(a: DesignAsset): string {
  const size = a.width && a.height ? ` ${a.width}×${a.height}` : ''
  const colours = a.colors.length > 0 ? ` colours ${a.colors.slice(0, 4).join(' ')}` : ''
  return `- ${a.name} — ${a.url} (${a.kind}${size}${colours})${a.caption ? ` — ${a.caption}` : ''}`
}

export function variantPrompt(context: DesignContext, plan: VariantPlan): string {
  return [
    `# Brief\n${context.brief}`,
    [
      `Format: ${OUTPUT_FORMAT_LABELS[context.format]}`,
      `Client: ${context.client?.name ?? 'none'}`,
      context.linearIssue ? `From Linear issue ${context.linearIssue}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    kitSection(context.kit),
    `# Templates for this format\n${context.templates.map(templateLine).join('\n')}`,
    `# Library assets${context.client ? ` for ${context.client.name}` : ''}\n${
      context.assets.length > 0
        ? `${context.assets.map(assetLine).join('\n')}\n(search_assets finds more.)`
        : 'Nothing in the library yet — leave image slots at their defaults.'
    }`,
    [
      `# Your variant: option ${plan.index} of ${plan.of} — ${plan.angle}`,
      plan.angleBrief,
      plan.suggestedTemplate
        ? `Start from “${plan.suggestedTemplate}” unless another template for this format fits the brief better.`
        : null,
      plan.otherAngles.length > 0
        ? `The other options take these angles, so make yours distinct:\n${plan.otherAngles.map((a) => `- ${a}`).join('\n')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// One variant
// ---------------------------------------------------------------------------

type VariantState = {
  outputId: string | null
  version: number | null
  template: string | null
  name: string
  outline: { title: string; purpose: string }[] | null
  renders: number
  renderedVersion: number | null
  finished: { name: string; critique: string } | null
  lastText: string
  steps: number
}

export type RunVariantArgs = {
  model: ModelClient
  toolbox: DesignToolbox
  context: DesignContext
  plan: VariantPlan
  onProgress: (p: DesignProgress) => void
  signal?: AbortSignal
  maxSteps?: number
  maxRenders?: number
}

type BlockResult = Anthropic.ToolResultBlockParam

export async function runDesignVariant({
  model,
  toolbox,
  context,
  plan,
  onProgress,
  signal,
  maxSteps = DESIGNER_MAX_STEPS,
  maxRenders = DESIGNER_MAX_RENDERS,
}: RunVariantArgs): Promise<DesignVariant> {
  const multi = MULTI_SECTION_FORMATS.has(context.format)
  const state: VariantState = {
    outputId: null,
    version: null,
    template: null,
    name: `Option ${plan.index}`,
    outline: null,
    renders: 0,
    renderedVersion: null,
    finished: null,
    lastText: '',
    steps: 0,
  }
  const progress = (stage: DesignStage, detail?: string) =>
    onProgress({
      variant: plan.index,
      of: plan.of,
      stage,
      ...(detail ? { detail } : {}),
      ...(state.outputId ? { outputId: state.outputId } : {}),
      ...(state.version ? { version: state.version } : {}),
    })

  const result = (status: DesignVariant['status'], error: string | null): DesignVariant => ({
    index: plan.index,
    status,
    cached: false,
    outputId: state.outputId,
    version: state.version,
    name: state.finished?.name ?? state.name,
    template: state.template,
    angle: plan.angle,
    critique: state.finished?.critique ?? state.lastText.trim().slice(0, 600),
    renders: state.renders,
    steps: state.steps,
    error,
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
      case 'plan_outline': {
        if (!multi) return err(use.id, 'Only multi-section formats need an outline.')
        const sections = input.sections as { title: string; purpose: string }[]
        state.outline = sections
        progress('outline', `${sections.length} sections`)
        return ok(
          use.id,
          `Outline saved (${sections.length} sections). Now create_output, make its sections match this outline with update_output_html, and fill the copy section by section.`,
        )
      }
      case 'search_assets': {
        progress('assets', typeof input.query === 'string' ? input.query : undefined)
        const r = await toolbox.searchAssets(input as { query?: string; kind?: AssetMediaKind })
        return r.ok ? ok(use.id, r.text) : err(use.id, r.error)
      }
      case 'create_output': {
        if (state.outputId) {
          return err(
            use.id,
            `This option already has its output (v${state.version}). Edit it with update_output_slots / update_output_html instead.`,
          )
        }
        if (multi && !state.outline) return err(use.id, 'Plan the outline first with plan_outline.')
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
        progress(state.renders > 0 ? 'revising' : 'filling')
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
      case 'render_output_frame': {
        const missing = needsOutput()
        if (missing) return missing
        if (state.renders >= maxRenders) {
          return err(
            use.id,
            `Render budget used (${maxRenders}). Call finish_variant now with your critique of the last render.`,
          )
        }
        progress('rendering')
        const section = input.section as number | undefined
        const r = await toolbox.render(state.outputId!, state.version!, { section })
        if (!r.ok) return err(use.id, r.error)
        state.renders++
        state.renderedVersion = state.version
        progress('critique', `render ${state.renders} of ${maxRenders}`)
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: r.png.toString('base64') },
            },
            {
              type: 'text',
              text: `${r.text}\nRenders left: ${maxRenders - state.renders}. Critique it against the brief and the kit, then fix the biggest problem or finish_variant.`,
            },
          ],
        }
      }
      case 'finish_variant': {
        const missing = needsOutput()
        if (missing) return missing
        if (state.renders === 0) {
          return err(use.id, 'Render it and look at it before finishing.')
        }
        if (state.renderedVersion !== state.version && state.renders < maxRenders) {
          return err(
            use.id,
            `You changed it after the last render (now v${state.version}) — render again to check before finishing.`,
          )
        }
        state.finished = input as { name: string; critique: string }
        return ok(use.id, 'Finished.')
      }
    }
  }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: variantPrompt(context, plan) },
  ]
  progress(multi ? 'outline' : 'template')

  while (!state.finished && state.steps < maxSteps) {
    if (signal?.aborted) return failed('Stopped.')
    state.steps++
    let response: Anthropic.Message
    try {
      response = await model.streamTurn(
        {
          model: DEEP_MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: DESIGNER_SYSTEM, cache_control: { type: 'ephemeral' } }],
          tools: DESIGNER_TOOLS,
          messages,
          cache_control: { type: 'ephemeral' },
        },
        { onText: () => undefined, signal },
      )
    } catch (e) {
      if (signal?.aborted) return failed('Stopped.')
      console.error('designer model call failed', e)
      return failed(describeModelError(e))
    }

    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (text.trim()) state.lastText = text
    if (response.stop_reason === 'refusal') return failed('The model declined this brief.')

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (response.stop_reason === 'max_tokens') {
      // A tool input cut off mid-way can't be trusted; keep the text only.
      if (text.trim()) messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: 'Your last reply was cut off. Make smaller edits, one tool call at a time.',
      })
      continue
    }
    messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] })

    if (uses.length === 0) {
      if (state.outputId && state.renders > 0 && state.renderedVersion === state.version) {
        state.finished = { name: state.name, critique: text.trim().slice(0, 600) }
        break
      }
      messages.push({
        role: 'user',
        content: state.outputId
          ? 'Render it with render_output_frame, critique it, then finish_variant.'
          : 'Use the tools: create_output (after plan_outline for multi-section formats), render it, critique it.',
      })
      continue
    }

    const results: BlockResult[] = []
    for (const use of uses) {
      try {
        results.push(await runTool(use))
      } catch (e) {
        console.error('designer tool failed', use.name, e)
        results.push(err(use.id, `Tool crashed: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    messages.push({ role: 'user', content: results })
  }

  if (!state.finished) {
    if (!state.outputId || state.renders === 0) {
      return failed(`Ran out of steps (${maxSteps}) before a rendered design.`)
    }
    state.lastText = `${state.lastText.trim().slice(0, 500)}${state.lastText.trim() ? ' ' : ''}(Stopped at the ${maxSteps}-step limit.)`
  }
  progress('done', state.finished?.name ?? state.name)
  return result('done', null)
}

// ---------------------------------------------------------------------------
// A run: N variants, cache first
// ---------------------------------------------------------------------------

export type DesignCache = {
  get(key: string): Promise<DesignVariant | null>
  put(key: string, variant: DesignVariant): Promise<void>
}

export async function runDesign({
  model,
  context,
  count,
  toolboxFor,
  cache,
  keyFor,
  regenerate = false,
  onProgress,
  signal,
  maxSteps,
  maxRenders,
}: {
  model: ModelClient | null
  context: DesignContext
  count: number
  toolboxFor: (plan: VariantPlan) => DesignToolbox
  cache: DesignCache
  keyFor: (plan: VariantPlan) => string
  regenerate?: boolean
  onProgress: (p: DesignProgress) => void
  signal?: AbortSignal
  maxSteps?: number
  maxRenders?: number
}): Promise<DesignVariant[]> {
  const plans = planVariants(context, count)
  for (const plan of plans) onProgress({ variant: plan.index, of: plan.of, stage: 'queued' })
  // Variants run side by side; renders queue in the renderer's own bound.
  return Promise.all(
    plans.map(async (plan): Promise<DesignVariant> => {
      const key = keyFor(plan)
      if (!regenerate) {
        const hit = await cache.get(key)
        if (hit) {
          onProgress({
            variant: plan.index,
            of: plan.of,
            stage: 'cached',
            detail: hit.name,
            ...(hit.outputId ? { outputId: hit.outputId } : {}),
            ...(hit.version ? { version: hit.version } : {}),
          })
          return { ...hit, index: plan.index, cached: true }
        }
      }
      if (!model) {
        const error =
          'The designer isn’t configured on this server — set ANTHROPIC_API_KEY to enable it.'
        onProgress({ variant: plan.index, of: plan.of, stage: 'failed', detail: error })
        return {
          index: plan.index,
          status: 'failed',
          cached: false,
          outputId: null,
          version: null,
          name: `Option ${plan.index}`,
          template: null,
          angle: plan.angle,
          critique: '',
          renders: 0,
          steps: 0,
          error,
        }
      }
      const variant = await runDesignVariant({
        model,
        toolbox: toolboxFor(plan),
        context,
        plan,
        onProgress,
        signal,
        maxSteps,
        maxRenders,
      })
      if (variant.status === 'done') await cache.put(key, variant)
      return variant
    }),
  )
}
