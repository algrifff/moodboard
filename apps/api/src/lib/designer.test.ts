import Anthropic from '@anthropic-ai/sdk'
import {
  HOUSE_KIT_TOKENS,
  type DesignProgress,
  type DesignVariant,
  type TemplateSummary,
} from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import {
  DESIGNER_SYSTEM,
  planVariants,
  runDesign,
  runDesignVariant,
  variantPrompt,
  type DesignCache,
  type DesignContext,
  type DesignToolbox,
} from './designer'
import type { ModelClient } from './orchestrator'

// The designer loop against a scripted model and a recording toolbox: no
// database, no browser. The real toolbox (designToolbox.ts) is exercised
// end to end through the sidebar with a fake model.

const template = (name: string, format: TemplateSummary['format']): TemplateSummary => ({
  id: `t-${name}`,
  name,
  format,
  viewport: { kind: 'fixed', width: 1280, height: 720 },
  clientId: null,
  clientName: null,
  starter: true,
  latestVersion: 1,
  slots: [
    { name: 'headline', kind: 'text', label: 'Headline' },
    { name: 'hero', kind: 'image', label: 'Hero image' },
  ],
  updatedAt: '2026-10-30T00:00:00.000Z',
})

const context = (patch: Partial<DesignContext> = {}): DesignContext => ({
  brief: 'Thumbnail for Acme’s launch video. Punchy, dark.',
  format: 'thumbnail',
  client: { id: 'acme', name: 'Acme' },
  kit: {
    id: 'kit',
    name: 'Acme brand',
    version: 2,
    tokens: {
      ...HOUSE_KIT_TOKENS,
      voice: {
        tone: ['dry'],
        dos: ['Short sentences'],
        donts: ['No exclamation marks'],
        examples: [],
      },
    },
  },
  templates: [template('YouTube thumbnail', 'thumbnail'), template('Bold thumbnail', 'thumbnail')],
  assets: [
    {
      name: 'hero.png',
      url: '/api/files/hero.png',
      caption: 'Rocket on a dark pad',
      kind: 'image',
      width: 1600,
      height: 900,
      colors: ['#111111'],
    },
  ],
  linearIssue: 'LIN-123',
  ...patch,
})

type Call = { name: string; args: unknown[] }
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function recordingToolbox(overrides: Partial<DesignToolbox> = {}) {
  const calls: Call[] = []
  let version = 0
  const rec =
    <T>(name: string, fn: (...args: never[]) => Promise<T>) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return fn(...(args as never[]))
    }
  const toolbox: DesignToolbox = {
    searchAssets: rec('searchAssets', async () => ({ ok: true, text: '[]' })),
    createOutput: rec('createOutput', async () => {
      version = 1
      return {
        ok: true,
        text: 'created',
        outputId: 'out-1',
        version,
        template: 'YouTube thumbnail',
      }
    }),
    getSource: rec('getSource', async () => ({ ok: true, text: '{"html":"<h1>x</h1>"}' })),
    updateSlots: rec('updateSlots', async () => ({ ok: true, text: 'ok', version: ++version })),
    updateHtml: rec('updateHtml', async () => ({ ok: true, text: 'ok', version: ++version })),
    render: rec('render', async () => ({
      ok: true,
      text: 'v1 1280×720',
      png: PNG,
      sections: 1,
      width: 1280,
      height: 720,
    })),
    ...overrides,
  }
  return { toolbox, calls }
}

type Step = { text?: string; tools?: { name: string; input: Record<string, unknown> }[] }

function message(step: Step, stop?: Anthropic.Message['stop_reason']): Anthropic.Message {
  const content = [
    ...(step.text ? [{ type: 'text', text: step.text, citations: null }] : []),
    ...(step.tools ?? []).map((t, i) => ({
      type: 'tool_use',
      id: `tu_${Math.random().toString(36).slice(2)}_${i}`,
      name: t.name,
      input: t.input,
    })),
  ]
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: stop ?? (step.tools?.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message
}

// Plays the steps in order, one per model turn; records every request.
function scriptedModel(steps: Step[] | ((params: Anthropic.MessageStreamParams) => Step)) {
  const requests: Anthropic.MessageStreamParams[] = []
  let i = 0
  const client: ModelClient = {
    async streamTurn(params) {
      requests.push(structuredClone(params))
      if (typeof steps === 'function') return message(steps(params))
      const step = steps[Math.min(i++, steps.length - 1)]!
      return message(step)
    },
  }
  return { client, requests }
}

const toolResults = (params: Anthropic.MessageStreamParams) => {
  const last = params.messages.at(-1)!
  return Array.isArray(last.content)
    ? last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
    : []
}

const plan = planVariants(context(), 1)[0]!

describe('runDesignVariant', () => {
  it('builds, renders, critiques from the image, patches and re-renders, then finishes', async () => {
    const { toolbox, calls } = recordingToolbox()
    const { client, requests } = scriptedModel([
      {
        text: 'Starting from the thumbnail template.',
        tools: [
          {
            name: 'create_output',
            input: {
              template: 'YouTube thumbnail',
              name: 'Liftoff',
              slots: { headline: 'Liftoff.', hero: '/api/files/hero.png' },
            },
          },
        ],
      },
      { tools: [{ name: 'render_output_frame', input: {} }] },
      {
        text: 'The headline is too small against the busy hero.',
        tools: [
          {
            name: 'update_output_html',
            input: { css: [{ find: 'font-size: 96px', replace: 'font-size: 140px' }] },
          },
        ],
      },
      { tools: [{ name: 'render_output_frame', input: {} }] },
      {
        tools: [
          {
            name: 'finish_variant',
            input: { name: 'Liftoff', critique: 'One huge word over the rocket. Reads at 320px.' },
          },
        ],
      },
    ])
    const progress: DesignProgress[] = []
    const variant = await runDesignVariant({
      model: client,
      toolbox,
      context: context(),
      plan,
      onProgress: (p) => progress.push(p),
    })

    expect(calls.map((c) => c.name)).toEqual(['createOutput', 'render', 'updateHtml', 'render'])
    // Each edit builds on the version the variant last saw.
    expect(calls[2]!.args[2]).toBe(1)
    expect(calls[3]!.args[1]).toBe(2)
    expect(variant).toMatchObject({
      status: 'done',
      outputId: 'out-1',
      version: 2,
      name: 'Liftoff',
      template: 'YouTube thumbnail',
      critique: 'One huge word over the rocket. Reads at 320px.',
      renders: 2,
      steps: 5,
      error: null,
    })

    // The render went back to the model as an image it can look at.
    const afterRender = toolResults(requests[2]!)[0]!
    expect(Array.isArray(afterRender.content)).toBe(true)
    const blocks = afterRender.content as Anthropic.ContentBlockParam[]
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    })
    // Cached system prompt and the brief with the kit's voice in context.
    expect(requests[0]!.system).toEqual([
      { type: 'text', text: DESIGNER_SYSTEM, cache_control: { type: 'ephemeral' } },
    ])
    expect(requests[0]!.messages[0]!.content).toContain("Voice — don't: No exclamation marks")

    expect(progress.map((p) => p.stage)).toEqual([
      'template',
      'template',
      'filling',
      'rendering',
      'critique',
      'revising',
      'rendering',
      'critique',
      'done',
    ])
  })

  it('refuses to finish unseen work and to create a second output', async () => {
    const { toolbox } = recordingToolbox()
    const { client, requests } = scriptedModel([
      { tools: [{ name: 'finish_variant', input: { name: 'x', critique: 'y' } }] },
      {
        tools: [
          { name: 'create_output', input: { template: 'YouTube thumbnail', name: 'A', slots: {} } },
        ],
      },
      { tools: [{ name: 'finish_variant', input: { name: 'x', critique: 'y' } }] },
      {
        tools: [
          { name: 'create_output', input: { template: 'Bold thumbnail', name: 'B', slots: {} } },
        ],
      },
      { tools: [{ name: 'render_output_frame', input: {} }] },
      { tools: [{ name: 'update_output_slots', input: { slots: { headline: 'Go' } } }] },
      { tools: [{ name: 'finish_variant', input: { name: 'x', critique: 'y' } }] },
      { tools: [{ name: 'render_output_frame', input: {} }] },
      { tools: [{ name: 'finish_variant', input: { name: 'A', critique: 'ok' } }] },
    ])
    const variant = await runDesignVariant({
      model: client,
      toolbox,
      context: context(),
      plan,
      onProgress: () => undefined,
    })
    const errors = requests
      .slice(1)
      .map((r) => toolResults(r)[0]!)
      .filter((r) => r.is_error)
      .map((r) => r.content)
    expect(errors).toEqual([
      'There is no output yet — create_output first.',
      'Render it and look at it before finishing.',
      expect.stringMatching(/already has its output/),
      expect.stringMatching(/changed it after the last render/),
    ])
    expect(variant).toMatchObject({ status: 'done', name: 'A', renders: 2 })
  })

  it('plans an outline before building a multi-section format', async () => {
    const { toolbox, calls } = recordingToolbox()
    const create = {
      name: 'create_output',
      input: { template: '16:9 deck', name: 'Q3', slots: { title: 'Q3' } },
    }
    const { client, requests } = scriptedModel([
      { tools: [create] },
      {
        tools: [
          {
            name: 'plan_outline',
            input: {
              sections: [
                { title: 'Cover', purpose: 'Name the launch' },
                { title: 'Why now', purpose: 'The market moment' },
              ],
            },
          },
        ],
      },
      { tools: [create] },
      { tools: [{ name: 'get_output_source', input: {} }] },
      {
        tools: [
          {
            name: 'update_output_html',
            input: { html: [{ find: '<section class="slide numbers">', replace: '' }] },
          },
        ],
      },
      { tools: [{ name: 'render_output_frame', input: { section: 1 } }] },
      { tools: [{ name: 'finish_variant', input: { name: 'Q3', critique: 'Tight.' } }] },
    ])
    const progress: DesignProgress[] = []
    const variant = await runDesignVariant({
      model: client,
      toolbox,
      context: context({ format: 'deck', templates: [template('16:9 deck', 'deck')] }),
      plan: planVariants(context({ format: 'deck' }), 1)[0]!,
      onProgress: (p) => progress.push(p),
    })
    expect(toolResults(requests[1]!)[0]).toMatchObject({
      is_error: true,
      content: 'Plan the outline first with plan_outline.',
    })
    expect(calls.map((c) => c.name)).toEqual(['createOutput', 'getSource', 'updateHtml', 'render'])
    expect(calls[3]!.args[2]).toEqual({ section: 1 })
    expect(progress[0]).toMatchObject({ stage: 'outline' })
    expect(progress.find((p) => p.detail === '2 sections')).toBeDefined()
    expect(variant.status).toBe('done')
  })

  it('stops at the step bound, and at the render budget', async () => {
    const { toolbox, calls } = recordingToolbox()
    let turn = 0
    const { client, requests } = scriptedModel(() =>
      turn++ === 0
        ? {
            tools: [
              {
                name: 'create_output',
                input: { template: 'YouTube thumbnail', name: 'Loop', slots: {} },
              },
            ],
          }
        : { tools: [{ name: 'render_output_frame', input: {} }] },
    )
    const variant = await runDesignVariant({
      model: client,
      toolbox,
      context: context(),
      plan,
      onProgress: () => undefined,
      maxSteps: 6,
      maxRenders: 3,
    })
    expect(requests).toHaveLength(6)
    expect(calls.filter((c) => c.name === 'render')).toHaveLength(3)
    expect(toolResults(requests[5]!)[0]).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/Render budget used \(3\)/),
    })
    expect(variant).toMatchObject({ status: 'done', renders: 3, steps: 6 })
    expect(variant.critique).toMatch(/6-step limit/)
  })

  it('fails visibly when the model errors or never produces a render', async () => {
    const { toolbox } = recordingToolbox()
    const failing: ModelClient = {
      async streamTurn() {
        throw new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers())
      },
    }
    const progress: DesignProgress[] = []
    const variant = await runDesignVariant({
      model: failing,
      toolbox,
      context: context(),
      plan,
      onProgress: (p) => progress.push(p),
    })
    expect(variant).toMatchObject({ status: 'failed', outputId: null })
    expect(variant.error).toMatch(/rate-limited/)
    expect(progress.at(-1)).toMatchObject({ stage: 'failed', detail: variant.error })

    const chatty = scriptedModel([{ text: 'Thinking about it.' }])
    const idle = await runDesignVariant({
      model: chatty.client,
      toolbox,
      context: context(),
      plan,
      onProgress: () => undefined,
      maxSteps: 3,
    })
    expect(idle).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Ran out of steps/),
    })
  })
})

describe('runDesign', () => {
  const memoryCache = () => {
    const store = new Map<string, DesignVariant>()
    const cache: DesignCache = {
      get: async (key) => store.get(key) ?? null,
      put: async (key, v) => void store.set(key, v),
    }
    return { cache, store }
  }

  // Each variant builds, renders once and finishes, named after its angle.
  const designerModel = () =>
    scriptedModel((params) => {
      const prompt = params.messages[0]!.content as string
      const angle = /option \d of \d — (.+)/.exec(prompt)![1]!
      const suggested = /Start from “(.+?)”/.exec(prompt)![1]!
      const last = params.messages.at(-1)!
      const turn = params.messages.filter((m) => m.role === 'assistant').length
      if (turn === 0) {
        return {
          tools: [
            { name: 'create_output', input: { template: suggested, name: angle, slots: {} } },
          ],
        }
      }
      if (turn === 1) return { tools: [{ name: 'render_output_frame', input: {} }] }
      expect(Array.isArray(last.content)).toBe(true)
      return { tools: [{ name: 'finish_variant', input: { name: angle, critique: 'Good.' } }] }
    })

  it('runs up to three distinct variants and caches each', async () => {
    const { cache, store } = memoryCache()
    const { client, requests } = designerModel()
    const templatesSeen: string[] = []
    const progress: DesignProgress[] = []
    const variants = await runDesign({
      model: client,
      context: context(),
      count: 5,
      toolboxFor: (p) =>
        recordingToolbox({
          createOutput: async (input) => {
            templatesSeen.push(input.template)
            return {
              ok: true,
              text: 'created',
              outputId: `out-${p.index}`,
              version: 1,
              template: input.template,
            }
          },
        }).toolbox,
      cache,
      keyFor: (p) => `key-${p.index}`,
      onProgress: (p) => progress.push(p),
    })
    expect(variants.map((v) => [v.index, v.name, v.status, v.cached])).toEqual([
      [1, 'Direct', 'done', false],
      [2, 'New layout', 'done', false],
      [3, 'Bolder copy', 'done', false],
    ])
    expect(templatesSeen.sort()).toEqual([
      'Bold thumbnail',
      'YouTube thumbnail',
      'YouTube thumbnail',
    ])
    expect([...store.keys()].sort()).toEqual(['key-1', 'key-2', 'key-3'])
    expect(requests).toHaveLength(9)
    expect(progress.filter((p) => p.stage === 'queued').map((p) => p.of)).toEqual([3, 3, 3])
  })

  it('reuses cached variants without calling the model, unless asked to regenerate', async () => {
    const { cache } = memoryCache()
    const first = designerModel()
    const args = {
      context: context(),
      count: 2,
      toolboxFor: () => recordingToolbox().toolbox,
      cache,
      keyFor: (p: { index: number }) => `key-${p.index}`,
      onProgress: () => undefined,
    }
    await runDesign({ ...args, model: first.client })
    expect(first.requests).toHaveLength(6)

    const second = designerModel()
    const progress: DesignProgress[] = []
    const again = await runDesign({
      ...args,
      model: second.client,
      onProgress: (p) => progress.push(p),
    })
    expect(second.requests).toHaveLength(0)
    expect(again.every((v) => v.cached && v.status === 'done')).toBe(true)
    expect(progress.filter((p) => p.stage === 'cached')).toHaveLength(2)

    // Cache hits work without a model; anything else says why it can't run.
    const keyless = await runDesign({ ...args, count: 3, model: null })
    expect(keyless.map((v) => [v.status, v.cached])).toEqual([
      ['done', true],
      ['done', true],
      ['failed', false],
    ])
    expect(keyless[2]!.error).toMatch(/ANTHROPIC_API_KEY/)

    const fresh = designerModel()
    await runDesign({ ...args, model: fresh.client, regenerate: true })
    expect(fresh.requests).toHaveLength(6)
  })
})

describe('variantPrompt', () => {
  it('carries the brief, the kit voice, the templates, the library and a distinct angle', () => {
    const plans = planVariants(context(), 3)
    const prompt = variantPrompt(context(), plans[1]!)
    expect(prompt).toContain('Thumbnail for Acme’s launch video. Punchy, dark.')
    expect(prompt).toContain('From Linear issue LIN-123')
    expect(prompt).toContain('Voice — do: Short sentences')
    expect(prompt).toContain('“YouTube thumbnail” (1280×720) — slots: headline (text: Headline)')
    expect(prompt).toContain('/api/files/hero.png')
    expect(prompt).toContain('option 2 of 3 — New layout')
    expect(prompt).toContain('Start from “Bold thumbnail”')
    expect(prompt).toContain('Direct: The clearest')
  })
})
