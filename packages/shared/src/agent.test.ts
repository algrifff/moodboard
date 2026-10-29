import { describe, expect, it } from 'vitest'
import { agentStreamEventSchema, deriveThreadTitle } from './agent'

describe('deriveThreadTitle', () => {
  it('keeps a short first line as-is', () => {
    expect(deriveThreadTitle('  Pull these into a group  ')).toBe('Pull these into a group')
  })

  it('uses only the first line', () => {
    expect(deriveThreadTitle('Brief please\nand more detail here')).toBe('Brief please')
  })

  it('cuts long text at a word boundary with an ellipsis', () => {
    const title = deriveThreadTitle(
      'Pull the three sneaker shots and the yellow note into a group and give me a brief for it',
    )
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title).toBe('Pull the three sneaker shots and the yellow note into a…')
  })

  it('falls back for blank input', () => {
    expect(deriveThreadTitle('   ')).toBe('New thread')
  })
})

describe('agentStreamEventSchema', () => {
  it('parses a persisted tool-result message', () => {
    const event = agentStreamEventSchema.parse({
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'user',
        isError: false,
        createdAt: new Date(0).toISOString(),
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{"summary":"ok"}' }],
      },
    })
    expect(event.type).toBe('message')
  })

  it('rejects unknown event types', () => {
    expect(agentStreamEventSchema.safeParse({ type: 'nope' }).success).toBe(false)
  })
})
