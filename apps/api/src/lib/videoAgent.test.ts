import Anthropic from '@anthropic-ai/sdk'
import {
  HOUSE_KIT_TOKENS,
  type DesignProgress,
  type DesignVariant,
  type TemplateSummary,
} from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import type { DesignCache } from './designer'
import type { ModelClient } from './orchestrator'
import {
  runVideo,
  runVideoAgent,
  VIDEO_AGENT_SYSTEM,
  VIDEO_AGENT_TOOLS,
  videoPrompt,
  type VideoContext,
  type VideoToolbox,
} from './videoAgent'

// The video agent loop against a scripted model and a recording toolbox: no
// database, no browser, no ffmpeg. The real toolbox (videoToolbox.ts) and
// queue are exercised end to end through the sidebar with a fake model.

const template: TemplateSummary = {
  id: 't-promo',
  name: 'Promo spot 16:9',
  format: 'video',
  viewport: { kind: 'fixed', width: 1920, height: 1080 },
  clientId: null,
  clientName: null,
  starter: true,
  latestVersion: 1,
  slots: [
    { name: 'headline', kind: 'text', label: 'Headline' },
    { name: 'hero', kind: 'image', label: 'Hero image' },
  ],
  updatedAt: '2026-10-30T00:00:00.000Z',
}

const context = (patch: Partial<VideoContext> = {}): VideoContext => ({
  brief: '15s promo for Acme’s spring launch. Confident, no hype.',
  client: { id: 'acme', name: 'Acme' },
  kit: { id: 'kit', name: 'Acme brand', version: 2, tokens: HOUSE_KIT_TOKENS },
  templates: [template],
  assets: [],
  clips: [
    {
      title: 'Acme factory tour',
      channel: 'Acme',
      durationSec: 95,
      posterUrl: '/api/files/tour.jpg',
    },
  ],
  fps: 30,
  ...patch,
})

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
type Call = { name: string; args: unknown[] }

function recordingToolbox(overrides: Partial<VideoToolbox> = {}) {
  const calls: Call[] = []
  let version = 0
  const rec =
    <T>(name: string, fn: (...args: never[]) => Promise<T>) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return fn(...(args as never[]))
    }
  const toolbox: VideoToolbox = {
    searchAssets: rec('searchAssets', async () => ({ ok: true, text: '[]' })),
    createOutput: rec('createOutput', async () => {
      version = 1
      return { ok: true, text: 'created', outputId: 'out-1', version, template: template.name }
    }),
    getSource: rec('getSource', async () => ({ ok: true, text: '{"html":"<main>x</main>"}' })),
    updateSlots: rec('updateSlots', async () => ({ ok: true, text: 'ok', version: ++version })),
    updateHtml: rec('updateHtml', async () => ({ ok: true, text: 'ok', version: ++version })),
    renderFrames: rec('renderFrames', async (_id: string, _v: number, times: number[]) => ({
      ok: true,
      text: '{"durationMs":15000}',
      durationMs: 15000,
      frames: times.map((timeMs) => ({ timeMs, png: PNG })),
    })),
    enqueueRender: rec('enqueueRender', async () => ({
      ok: true,
      text: 'Queued.',
      jobId: 'job-1',
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

function scriptedModel(steps: Step[]) {
  const requests: Anthropic.MessageStreamParams[] = []
  let i = 0
  const client: ModelClient = {
    async streamTurn(params) {
      requests.push(structuredClone(params))
      return message(steps[Math.min(i++, steps.length - 1)]!)
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

const SCRIPT = {
  logline: 'Spring is here and Acme is ready.',
  scenes: [
    { title: 'Sting', startMs: 0, durationMs: 2200, onScreen: 'Acme', purpose: 'Brand' },
    {
      title: 'Hero',
      startMs: 2200,
      durationMs: 3800,
      onScreen: 'Ready for spring',
      purpose: 'Hook',
    },
    {
      title: 'Beats',
      startMs: 6000,
      durationMs: 6000,
      onScreen: 'Three features',
      purpose: 'Proof',
    },
    { title: 'CTA', startMs: 12000, durationMs: 3000, onScreen: 'Start today', purpose: 'Ask' },
  ],
}
const CREATE = {
  name: 'create_output',
  input: { template: 'Promo spot 16:9', name: 'Spring', slots: { headline: 'Ready for spring' } },
}

describe('runVideoAgent', () => {
  it('goes script → output → key frames → fix → key frames → finish, then queues the render', async () => {
    const { toolbox, calls } = recordingToolbox()
    const { client, requests } = scriptedModel([
      { text: 'Script first.', tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      {
        text: 'The headline in scene two is cramped.',
        tools: [
          {
            name: 'update_output_html',
            input: { css: [{ find: 'font-size: 128px', replace: 'font-size: 110px' }] },
          },
        ],
      },
      { tools: [{ name: 'render_key_frames', input: { timesMs: [4800, 14000] } }] },
      {
        tools: [
          {
            name: 'finish_video',
            input: { name: 'Spring spot', critique: 'Clear and calm.', fps: 60 },
          },
        ],
      },
    ])
    const progress: DesignProgress[] = []
    const run = await runVideoAgent({
      model: client,
      toolbox,
      context: context(),
      onProgress: (p) => progress.push(p),
    })

    expect(run).toMatchObject({
      status: 'done',
      outputId: 'out-1',
      version: 2,
      name: 'Spring spot',
      critique: 'Clear and calm.',
      fps: 60,
      durationMs: 15000,
      jobId: 'job-1',
      renders: 6,
      steps: 6,
    })
    expect(run.script?.scenes).toHaveLength(4)
    expect(calls.map((c) => c.name)).toEqual([
      'createOutput',
      'renderFrames',
      'updateHtml',
      'renderFrames',
      'enqueueRender',
    ])
    // Default key frames: 70% into each scene.
    expect(calls[1]!.args[2]).toEqual([1540, 4860, 10200, 14100])
    expect(calls[3]!.args[2]).toEqual([4800, 14000])
    // The render is queued for the finished version at the chosen fps.
    expect(calls.at(-1)!.args).toEqual(['out-1', 2, 60])
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining([
        'script',
        'template',
        'rendering',
        'critique',
        'revising',
        'render-queued',
        'done',
      ]),
    )
    expect(progress.every((p) => p.of === 1 && p.variant === 1)).toBe(true)

    // The model saw frames as images, with their times.
    const frames = toolResults(requests[3]!)[0]!.content as { type: string; text?: string }[]
    expect(frames.filter((b) => b.type === 'image')).toHaveLength(4)
    expect(frames.some((b) => b.text?.includes('Frame at 1540 ms'))).toBe(true)
    // The brief carries the board's clips as references.
    expect(JSON.stringify(requests[0]!.messages[0])).toContain('Acme factory tour')
    expect(JSON.stringify(requests[0]!.messages[0])).toContain('/api/files/tour.jpg')
  })

  it('makes the model write a script before building, and look before finishing', async () => {
    const { toolbox } = recordingToolbox()
    const { client, requests } = scriptedModel([
      { tools: [CREATE] },
      { tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
    ])
    const run = await runVideoAgent({
      model: client,
      toolbox,
      context: context(),
      onProgress: () => undefined,
    })
    expect(run.status).toBe('done')
    expect(toolResults(requests[1]!)[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining('write_script'),
    })
    expect(toolResults(requests[4]!)[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining('render_key_frames'),
    })
  })

  it('refuses a script that runs past the limit and an edit-then-finish without a new look', async () => {
    const { toolbox } = recordingToolbox()
    const long = {
      ...SCRIPT,
      scenes: [
        { title: 'Long', startMs: 0, durationMs: 60_000, onScreen: 'x', purpose: 'y' },
        SCRIPT.scenes[3]!,
      ],
    }
    const { client, requests } = scriptedModel([
      {
        tools: [
          {
            name: 'write_script',
            input: { ...long, scenes: [{ ...long.scenes[0]!, startMs: 5000 }] },
          },
        ],
      },
      { tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      { tools: [{ name: 'update_output_slots', input: { slots: { headline: 'New' } } }] },
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
    ])
    const run = await runVideoAgent({
      model: client,
      toolbox,
      context: context(),
      onProgress: () => undefined,
    })
    expect(run.status).toBe('done')
    expect(toolResults(requests[1]!)[0]).toMatchObject({ is_error: true })
    expect(JSON.stringify(toolResults(requests[1]!)[0])).toContain('at most 60000')
    expect(JSON.stringify(toolResults(requests[6]!)[0])).toContain('changed it after the last look')
  })

  it('stops looking after its key-frame budget', async () => {
    const { toolbox, calls } = recordingToolbox()
    const look = { tools: [{ name: 'render_key_frames', input: { timesMs: [1000] } }] }
    const { client, requests } = scriptedModel([
      { tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      look,
      look,
      look,
      look,
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
    ])
    await runVideoAgent({ model: client, toolbox, context: context(), onProgress: () => undefined })
    expect(calls.filter((c) => c.name === 'renderFrames')).toHaveLength(3)
    expect(JSON.stringify(toolResults(requests[6]!)[0])).toContain('budget used')
  })

  it('returns what it has at the step limit, and fails if it never produced a film', async () => {
    const { toolbox } = recordingToolbox()
    const looped = scriptedModel([
      { tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      { tools: [{ name: 'get_output_source', input: {} }] },
    ])
    const partial = await runVideoAgent({
      model: looped.client,
      toolbox,
      context: context(),
      onProgress: () => undefined,
      maxSteps: 6,
    })
    expect(partial).toMatchObject({ status: 'done', outputId: 'out-1', jobId: 'job-1' })
    expect(partial.critique).toContain('6-step limit')

    const idle = scriptedModel([{ tools: [{ name: 'write_script', input: SCRIPT }] }])
    const none = await runVideoAgent({
      model: idle.client,
      toolbox,
      context: context(),
      onProgress: () => undefined,
      maxSteps: 3,
    })
    expect(none.status).toBe('failed')
    expect(none.error).toMatch(/Ran out of steps/)
  })

  it('fails with the reason when the model errors, and when the queue refuses', async () => {
    const { toolbox } = recordingToolbox()
    const broken: ModelClient = {
      async streamTurn() {
        throw new Error('boom')
      },
    }
    const down = await runVideoAgent({
      model: broken,
      toolbox,
      context: context(),
      onProgress: () => undefined,
    })
    expect(down).toMatchObject({ status: 'failed', error: expect.stringContaining('boom') })

    const full = recordingToolbox({
      enqueueRender: async () => ({ ok: false, error: 'The render queue is full' }),
    })
    const { client } = scriptedModel([
      { tools: [{ name: 'write_script', input: SCRIPT }] },
      { tools: [CREATE] },
      { tools: [{ name: 'render_key_frames', input: {} }] },
      { tools: [{ name: 'finish_video', input: { name: 'x', critique: 'y' } }] },
    ])
    const queued = await runVideoAgent({
      model: client,
      toolbox: full.toolbox,
      context: context(),
      onProgress: () => undefined,
    })
    expect(queued).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('queue is full'),
    })
    expect(queued.outputId).toBe('out-1')
  })

  it('stops when aborted', async () => {
    const { toolbox } = recordingToolbox()
    const controller = new AbortController()
    controller.abort()
    const { client, requests } = scriptedModel([{ text: 'hi' }])
    const run = await runVideoAgent({
      model: client,
      toolbox,
      context: context(),
      onProgress: () => undefined,
      signal: controller.signal,
    })
    expect(run).toMatchObject({ status: 'failed', error: 'Stopped.' })
    expect(requests).toHaveLength(0)
  })
})

describe('runVideo (cache)', () => {
  const memoryCache = () => {
    const rows = new Map<string, DesignVariant>()
    const cache: DesignCache = {
      get: async (key) => rows.get(key) ?? null,
      put: async (key, variant) => void rows.set(key, variant),
    }
    return { cache, rows }
  }
  const steps: Step[] = [
    { tools: [{ name: 'write_script', input: SCRIPT }] },
    { tools: [CREATE] },
    { tools: [{ name: 'render_key_frames', input: {} }] },
    { tools: [{ name: 'finish_video', input: { name: 'Spring spot', critique: 'Clear.' } }] },
  ]

  it('stores a finished film and reuses it without calling the model again', async () => {
    const { cache, rows } = memoryCache()
    const first = recordingToolbox()
    const model = scriptedModel(steps)
    const run = await runVideo({
      model: model.client,
      context: context(),
      toolbox: first.toolbox,
      cache,
      key: 'k',
      onProgress: () => undefined,
    })
    expect(run.cached).toBe(false)
    expect(rows.get('k')).toMatchObject({ outputId: 'out-1', name: 'Spring spot' })
    const modelCalls = model.requests.length

    const second = recordingToolbox()
    const progress: DesignProgress[] = []
    const again = await runVideo({
      model: model.client,
      context: context(),
      toolbox: second.toolbox,
      cache,
      key: 'k',
      onProgress: (p) => progress.push(p),
    })
    expect(again).toMatchObject({ cached: true, outputId: 'out-1', status: 'done', jobId: 'job-1' })
    expect(model.requests).toHaveLength(modelCalls)
    expect(progress.map((p) => p.stage)).toEqual(['queued', 'cached'])
    // The MP4 is still ensured (a no-op when it already exists).
    expect(second.calls.map((c) => c.name)).toEqual(['enqueueRender'])

    const fresh = await runVideo({
      model: scriptedModel(steps).client,
      context: context(),
      toolbox: recordingToolbox().toolbox,
      cache,
      key: 'k',
      regenerate: true,
      onProgress: () => undefined,
    })
    expect(fresh.cached).toBe(false)
  })

  it('does not cache a failure, and says when no model is configured', async () => {
    const { cache, rows } = memoryCache()
    const none = await runVideo({
      model: null,
      context: context(),
      toolbox: recordingToolbox().toolbox,
      cache,
      key: 'k',
      onProgress: () => undefined,
    })
    expect(none).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('ANTHROPIC_API_KEY'),
    })
    expect(rows.size).toBe(0)
  })
})

describe('prompts and tools', () => {
  it('describes the kit, the video templates and the board’s clips as stills only', () => {
    const prompt = videoPrompt(context())
    expect(prompt).toContain('# Brief')
    expect(prompt).toContain('Style kit: Acme brand v2')
    expect(prompt).toContain('Promo spot 16:9')
    expect(prompt).toContain('stills only')
    expect(prompt).toContain('1:35')
    expect(videoPrompt(context({ clips: [] }))).not.toContain('Reference clips')
  })

  it('lists a stable tool set, cached at the last tool', () => {
    expect(VIDEO_AGENT_TOOLS.map((t) => t.name)).toEqual([
      'write_script',
      'search_assets',
      'create_output',
      'get_output_source',
      'update_output_slots',
      'update_output_html',
      'render_key_frames',
      'finish_video',
    ])
    expect(VIDEO_AGENT_TOOLS.at(-1)).toHaveProperty('cache_control')
    expect(VIDEO_AGENT_SYSTEM).toMatch(/silent/i)
  })
})
