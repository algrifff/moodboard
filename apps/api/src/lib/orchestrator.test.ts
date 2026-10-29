import type Anthropic from '@anthropic-ai/sdk'
import type { AgentContentBlock, AgentMessage, AgentStreamEvent } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import type { ToolOutcome } from './canvasTools'
import {
  runOrchestrator,
  toModelMessages,
  type ModelClient,
  type OrchestratorTools,
} from './orchestrator'

type Turn =
  | {
      text?: string
      tools?: { id: string; name: string; input: Record<string, unknown> }[]
      stop?: Anthropic.StopReason
    }
  | { throws: Error; partial?: string; abort?: AbortController }

function fakeClient(turns: Turn[]) {
  const calls: Anthropic.MessageStreamParams[] = []
  const client: ModelClient = {
    async streamTurn(params, { onText }) {
      // The loop mutates its messages array after the call; snapshot it.
      calls.push(structuredClone(params))
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)]!
      if ('throws' in turn) {
        if (turn.partial) onText(turn.partial)
        turn.abort?.abort()
        throw turn.throws
      }
      const content: unknown[] = []
      if (turn.text) {
        for (const word of turn.text.split(/(?<= )/)) onText(word)
        content.push({ type: 'text', text: turn.text, citations: null })
      }
      for (const t of turn.tools ?? []) content.push({ type: 'tool_use', ...t })
      return {
        id: `msg_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content,
        stop_reason: turn.stop ?? (turn.tools?.length ? 'tool_use' : 'end_turn'),
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message
    },
  }
  return { client, calls }
}

function harness(turns: Turn[], toolImpl?: (name: string, input: unknown) => Promise<ToolOutcome>) {
  const { client, calls } = fakeClient(turns)
  const stored: AgentMessage[] = []
  const events: AgentStreamEvent[] = []
  const toolCalls: { name: string; input: unknown }[] = []
  const tools: OrchestratorTools = {
    definitions: [
      { name: 'get_board', description: 'read', input_schema: { type: 'object', properties: {} } },
      { name: 'add_note', description: 'add', input_schema: { type: 'object', properties: {} } },
    ],
    run: async (name, input) => {
      toolCalls.push({ name, input })
      if (toolImpl) return toolImpl(name, input)
      return {
        ok: true,
        payload: { summary: `ran ${name}`, objectIds: ['o1'] },
        effects:
          name === 'add_note'
            ? {
                objects: [
                  {
                    object: {
                      id: 'o1',
                      type: 'sticky',
                      position: { x: 0, y: 0 },
                      size: { width: 200, height: 200 },
                      rotation: 0,
                      zIndex: 0,
                      data: { text: 'hi', color: '#FEF3C7' },
                    },
                    version: 1,
                  },
                ],
              }
            : undefined,
      }
    },
  }
  const store = {
    append: async (role: AgentMessage['role'], content: AgentContentBlock[], isError = false) => {
      const message: AgentMessage = {
        id: `m${stored.length + 1}`,
        threadId: 't1',
        role,
        content,
        isError,
        createdAt: new Date(0).toISOString(),
      }
      stored.push(message)
      return message
    },
  }
  return {
    client,
    calls,
    stored,
    events,
    toolCalls,
    tools,
    store,
    emit: (e: AgentStreamEvent) => events.push(e),
  }
}

const userMessage = (text: string): AgentMessage => ({
  id: 'u1',
  threadId: 't1',
  role: 'user',
  content: [{ type: 'text', text }],
  isError: false,
  createdAt: new Date(0).toISOString(),
})

describe('runOrchestrator', () => {
  it('streams text and persists a plain answer', async () => {
    const h = harness([{ text: 'Hello there.' }])
    await runOrchestrator({ ...h, history: [userMessage('hi')] })

    expect(
      h.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta),
    ).toEqual(['Hello ', 'there.'])
    expect(h.stored).toHaveLength(1)
    expect(h.stored[0]).toMatchObject({
      role: 'assistant',
      isError: false,
      content: [{ type: 'text', text: 'Hello there.' }],
    })
    // Stored blocks are normalised — SDK-only fields like citations dropped.
    expect(h.stored[0]!.content[0]).not.toHaveProperty('citations')
  })

  it('runs tools in order, persists call → results → answer, and pushes board changes', async () => {
    const h = harness([
      {
        text: 'Reading the board.',
        tools: [
          { id: 'tu1', name: 'get_board', input: {} },
          { id: 'tu2', name: 'add_note', input: { text: 'hi' } },
        ],
      },
      { text: 'Done — added a note.' },
    ])
    await runOrchestrator({ ...h, history: [userMessage('add a note')] })

    expect(h.toolCalls.map((t) => t.name)).toEqual(['get_board', 'add_note'])
    expect(h.stored.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ['assistant', ['text', 'tool_use', 'tool_use']],
      ['user', ['tool_result', 'tool_result']],
      ['assistant', ['text']],
    ])
    const results = h.stored[1]!.content
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' })
    expect(JSON.parse((results[1] as { content: string }).content)).toEqual({
      summary: 'ran add_note',
      objectIds: ['o1'],
    })

    // Board event arrives after the tool_use message and before the results.
    const kinds = h.events.filter((e) => e.type !== 'text').map((e) => e.type)
    expect(kinds).toEqual(['message', 'board', 'message', 'message'])

    // Second request carries the tool round-trip.
    const second = h.calls[1]!
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(h.calls).toHaveLength(2)
  })

  it('caches the system prompt and the tool definitions', async () => {
    const h = harness([{ text: 'ok' }])
    await runOrchestrator({ ...h, history: [userMessage('hi')] })
    const params = h.calls[0]!
    const system = params.system as Anthropic.TextBlockParam[]
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    const tools = params.tools as Anthropic.Tool[]
    expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
    expect(tools[0]!.cache_control).toBeUndefined()
  })

  it('adds run-specific context after the cached system block', async () => {
    const h = harness([{ text: 'ok' }])
    await runOrchestrator({
      ...h,
      history: [userMessage('hi')],
      context: 'This board belongs to the client Acme.',
    })
    const system = h.calls[0]!.system as Anthropic.TextBlockParam[]
    expect(system).toHaveLength(2)
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]).toEqual({ type: 'text', text: 'This board belongs to the client Acme.' })

    const bare = harness([{ text: 'ok' }])
    await runOrchestrator({ ...bare, history: [userMessage('hi')] })
    expect(bare.calls[0]!.system as unknown[]).toHaveLength(1)
  })

  it('stops after the iteration bound with a visible notice', async () => {
    const h = harness([{ tools: [{ id: 'tu', name: 'get_board', input: {} }] }])
    await runOrchestrator({ ...h, history: [userMessage('loop')], maxIterations: 3 })

    expect(h.calls).toHaveLength(3)
    expect(h.toolCalls).toHaveLength(3)
    const last = h.stored.at(-1)!
    expect(last.isError).toBe(true)
    expect((last.content[0] as { text: string }).text).toMatch(/Stopped after 3 steps/)
    // Every tool_use still got its result.
    expect(h.stored.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('turns a model failure into a persisted, user-visible notice', async () => {
    const h = harness([{ throws: new Error('boom') }])
    await runOrchestrator({ ...h, history: [userMessage('hi')] })
    expect(h.stored).toHaveLength(1)
    expect(h.stored[0]).toMatchObject({ role: 'assistant', isError: true })
    expect((h.stored[0]!.content[0] as { text: string }).text).toMatch(/boom/)
    expect(h.events.at(-1)).toMatchObject({ type: 'message' })
  })

  it('explains a missing API key in the thread', async () => {
    const h = harness([])
    await runOrchestrator({ ...h, client: null, history: [userMessage('hi')] })
    expect(h.stored).toHaveLength(1)
    expect(h.stored[0]!.isError).toBe(true)
    expect((h.stored[0]!.content[0] as { text: string }).text).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('feeds tool errors back to the model and keeps going', async () => {
    const h = harness(
      [{ tools: [{ id: 'tu1', name: 'add_note', input: {} }] }, { text: 'That failed, sorry.' }],
      async () => ({ ok: false, error: 'Board not found.' }),
    )
    await runOrchestrator({ ...h, history: [userMessage('add')] })
    expect(h.stored[1]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'Board not found.',
      is_error: true,
    })
    expect(h.stored.at(-1)).toMatchObject({ role: 'assistant', isError: false })
    expect(h.events.some((e) => e.type === 'board')).toBe(false)
  })

  it('keeps streamed text and stops when the user aborts', async () => {
    const abort = new AbortController()
    const h = harness([{ throws: new Error('aborted'), partial: 'Half a th', abort }])
    await runOrchestrator({ ...h, history: [userMessage('hi')], signal: abort.signal })
    expect(h.stored.map((m) => [(m.content[0] as { text: string }).text, m.isError])).toEqual([
      ['Half a th', false],
      ['Stopped.', true],
    ])
  })

  it('never runs a tool call truncated by max_tokens', async () => {
    const h = harness([
      { text: 'Let me', tools: [{ id: 'tu1', name: 'add_note', input: {} }], stop: 'max_tokens' },
    ])
    await runOrchestrator({ ...h, history: [userMessage('hi')] })
    expect(h.toolCalls).toHaveLength(0)
    expect(h.stored[0]!.content.map((b) => b.type)).toEqual(['text'])
    expect(h.stored[1]!.isError).toBe(true)
  })
})

describe('toModelMessages', () => {
  const msg = (role: AgentMessage['role'], content: AgentContentBlock[], isError = false) => ({
    id: Math.random().toString(),
    threadId: 't',
    role,
    content,
    isError,
    createdAt: '',
  })

  it('skips server notices', () => {
    const out = toModelMessages([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'not configured' }], true),
      msg('user', [{ type: 'text', text: 'again' }]),
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('answers tool calls a crashed run left without results', () => {
    const out = toModelMessages([
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'tool_use', id: 'tu1', name: 'get_board', input: {} }]),
      msg('user', [{ type: 'text', text: 'hello?' }]),
    ])
    expect(out).toHaveLength(3)
    const content = out[2]!.content as Anthropic.ContentBlockParam[]
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1', is_error: true })
    expect(content[1]).toEqual({ type: 'text', text: 'hello?' })
  })
})
