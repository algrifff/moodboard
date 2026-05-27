import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import {
  aabbDistance,
  aabbIntersect,
  groupBoundingBox,
  groupId,
  normalizeRect,
  objectsInMarquee,
  proximityGroups,
} from './aabb'

const obj = (id: string, x: number, y: number, w = 100, h = 100): CanvasObject => ({
  id,
  type: 'sticky',
  position: { x, y },
  size: { width: w, height: h },
  rotation: 0,
  zIndex: 0,
  data: { text: '', color: '#fff' },
})

describe('aabbIntersect', () => {
  it('returns true when rects overlap', () => {
    expect(
      aabbIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 5, top: 5, right: 15, bottom: 15 },
      ),
    ).toBe(true)
  })

  it('returns true when one rect contains the other', () => {
    expect(
      aabbIntersect(
        { left: 0, top: 0, right: 100, bottom: 100 },
        { left: 25, top: 25, right: 75, bottom: 75 },
      ),
    ).toBe(true)
  })

  it('returns true when rects touch at an edge', () => {
    expect(
      aabbIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 0, right: 20, bottom: 10 },
      ),
    ).toBe(true)
  })

  it('returns false when rects are apart', () => {
    expect(
      aabbIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 20, top: 20, right: 30, bottom: 30 },
      ),
    ).toBe(false)
  })
})

describe('normalizeRect', () => {
  it('orders points regardless of direction', () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 0, y: 0 })).toEqual({
      left: 0,
      right: 10,
      top: 0,
      bottom: 20,
    })
  })
})

describe('objectsInMarquee', () => {
  const objects = [
    obj('a', 0, 0),
    obj('b', 200, 200),
    obj('c', 50, 50),
  ]

  it('finds objects inside a marquee that contains them', () => {
    expect(objectsInMarquee(objects, { x: -10, y: -10 }, { x: 110, y: 110 })).toEqual(['a', 'c'])
  })

  it('finds objects partially overlapping the marquee', () => {
    // overlaps "a" without touching "c" (c.top = 50)
    expect(objectsInMarquee(objects, { x: 99, y: 0 }, { x: 150, y: 49 })).toEqual(['a'])
  })

  it('returns empty when marquee misses everything', () => {
    expect(objectsInMarquee(objects, { x: 500, y: 500 }, { x: 600, y: 600 })).toEqual([])
  })

  it('handles inverted-direction drag (bottom-right to top-left)', () => {
    expect(objectsInMarquee(objects, { x: 110, y: 110 }, { x: -10, y: -10 })).toEqual(['a', 'c'])
  })
})

describe('aabbDistance', () => {
  it('returns 0 when rects overlap', () => {
    expect(
      aabbDistance(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 5, top: 5, right: 15, bottom: 15 },
      ),
    ).toBe(0)
  })

  it('returns 0 when rects touch on an edge', () => {
    expect(
      aabbDistance(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 0, right: 20, bottom: 10 },
      ),
    ).toBe(0)
  })

  it('returns horizontal gap when rects are side-by-side', () => {
    expect(
      aabbDistance(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 20, top: 0, right: 30, bottom: 10 },
      ),
    ).toBe(10)
  })

  it('returns diagonal gap when rects are diagonally apart', () => {
    expect(
      aabbDistance(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 13, top: 14, right: 20, bottom: 20 },
      ),
    ).toBeCloseTo(5, 10)
  })
})

describe('proximityGroups', () => {
  const square = (id: string, x: number, y: number): CanvasObject => ({
    id,
    type: 'sticky',
    position: { x, y },
    size: { width: 100, height: 100 },
    rotation: 0,
    zIndex: 0,
    data: { text: '', color: '#fff' },
  })

  it('returns empty when fewer than 2 items', () => {
    expect(proximityGroups([square('a', 0, 0)], 24)).toEqual([])
  })

  it('groups two items within 24px', () => {
    const objects = [square('a', 0, 0), square('b', 120, 0)]
    expect(proximityGroups(objects, 24)).toEqual([['a', 'b']])
  })

  it('does NOT group items exactly past 24px apart', () => {
    const objects = [square('a', 0, 0), square('b', 125, 0)]
    expect(proximityGroups(objects, 24)).toEqual([])
  })

  it('groups items touching edges (0px gap)', () => {
    const objects = [square('a', 0, 0), square('b', 100, 0)]
    expect(proximityGroups(objects, 24)).toEqual([['a', 'b']])
  })

  it('groups items overlapping', () => {
    const objects = [square('a', 0, 0), square('b', 50, 50)]
    expect(proximityGroups(objects, 24)).toEqual([['a', 'b']])
  })

  it('returns connected components via transitive grouping (A-B-C all in one)', () => {
    const objects = [square('a', 0, 0), square('b', 120, 0), square('c', 240, 0)]
    expect(proximityGroups(objects, 24)).toEqual([['a', 'b', 'c']])
  })

  it('returns separate groups for disconnected clusters', () => {
    const objects = [
      square('a', 0, 0),
      square('b', 110, 0),
      square('c', 500, 500),
      square('d', 610, 500),
    ]
    const result = proximityGroups(objects, 24)
    expect(result).toHaveLength(2)
    expect(result.some((g) => g.includes('a') && g.includes('b'))).toBe(true)
    expect(result.some((g) => g.includes('c') && g.includes('d'))).toBe(true)
  })
})

describe('groupBoundingBox', () => {
  const obj = (x: number, y: number, w = 100, h = 100): CanvasObject => ({
    id: 'x',
    type: 'sticky',
    position: { x, y },
    size: { width: w, height: h },
    rotation: 0,
    zIndex: 0,
    data: { text: '', color: '#fff' },
  })

  it('returns a zero rect for an empty group', () => {
    expect(groupBoundingBox([])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('wraps a single object with default 20px padding', () => {
    expect(groupBoundingBox([obj(0, 0)])).toEqual({
      left: -20,
      top: -20,
      right: 120,
      bottom: 120,
    })
  })

  it('wraps multiple objects with padding', () => {
    expect(groupBoundingBox([obj(0, 0), obj(200, 200)], 10)).toEqual({
      left: -10,
      top: -10,
      right: 310,
      bottom: 310,
    })
  })
})

describe('groupId', () => {
  it('is stable across input ordering', () => {
    expect(groupId(['b', 'a', 'c'])).toBe(groupId(['c', 'b', 'a']))
  })

  it('differs for different membership', () => {
    expect(groupId(['a', 'b'])).not.toBe(groupId(['a', 'b', 'c']))
  })
})
