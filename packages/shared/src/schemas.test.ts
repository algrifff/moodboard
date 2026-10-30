import { describe, expect, it } from 'vitest'
import { healthResponseSchema, saveBoardObjectsRequestSchema } from './schemas'

describe('saveBoardObjectsRequestSchema', () => {
  const object = {
    id: 'o1',
    type: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    rotation: 0,
    zIndex: 0,
    data: { text: 'hi', color: '#FEF3C7', futureField: 1 },
  }

  it('keeps data fields the per-type schema does not know about', () => {
    const result = saveBoardObjectsRequestSchema.parse({
      upserts: [{ object, baseVersion: null }],
      deletes: [],
    })
    expect(result.upserts[0]!.object.data).toEqual(object.data)
  })

  it('rejects an unknown object type', () => {
    const result = saveBoardObjectsRequestSchema.safeParse({
      upserts: [{ object: { ...object, type: 'notion-page' }, baseVersion: 1 }],
      deletes: [],
    })
    expect(result.success).toBe(false)
  })

  it('requires a baseVersion on deletes', () => {
    const result = saveBoardObjectsRequestSchema.safeParse({
      upserts: [],
      deletes: [{ id: 'o1' }],
    })
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
