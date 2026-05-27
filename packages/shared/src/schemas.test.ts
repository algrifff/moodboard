import { describe, expect, it } from 'vitest'
import { boardSchema, healthResponseSchema } from './schemas'

describe('boardSchema', () => {
  it('validates a minimal empty board', () => {
    const result = boardSchema.safeParse({
      id: 'b1',
      userId: null,
      name: 'Test Board',
      objects: [],
      groups: [],
      createdAt: '2026-05-27T12:00:00Z',
      updatedAt: '2026-05-27T12:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a board missing required fields', () => {
    const result = boardSchema.safeParse({ id: 'b1' })
    expect(result.success).toBe(false)
  })
})

describe('healthResponseSchema', () => {
  it('validates a health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'moodboard-api',
      time: new Date().toISOString(),
    })
    expect(result.success).toBe(true)
  })
})
