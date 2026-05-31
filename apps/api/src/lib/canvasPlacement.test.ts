import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { nextSpot } from './canvasPlacement'

const SIZE = { width: 200, height: 200 }

function makeObject(x: number, y: number, w = 200, h = 200): CanvasObject {
  return {
    id: 'x',
    type: 'sticky',
    position: { x, y },
    size: { width: w, height: h },
    rotation: 0,
    zIndex: 0,
    data: { text: '', color: '#fff' },
  }
}

describe('nextSpot', () => {
  it('drops at (0, 0) for an empty board', () => {
    expect(nextSpot([], SIZE)).toEqual({ x: 0, y: 0 })
  })

  it('tiles to the right of a single existing object', () => {
    const obj = makeObject(100, 50)
    expect(nextSpot([obj], SIZE)).toEqual({ x: 100 + 200 + 80, y: 50 })
  })

  it('extends a row of objects', () => {
    const objects = [makeObject(0, 0), makeObject(280, 0), makeObject(560, 0)]
    expect(nextSpot(objects, SIZE)).toEqual({ x: 560 + 200 + 80, y: 0 })
  })

  it('wraps to a new row after 6 objects in the same band', () => {
    const objects = Array.from({ length: 6 }, (_, i) => makeObject(i * 280, 0))
    const spot = nextSpot(objects, SIZE)
    expect(spot.x).toBe(0)
    expect(spot.y).toBeGreaterThan(200) // below the existing row
  })

  it('counts vertically separated objects as different bands', () => {
    // Two rows of 3 — the rightmost is in the top row.
    const objects = [
      makeObject(0, 0),
      makeObject(280, 0),
      makeObject(560, 0),
      makeObject(0, 400),
      makeObject(280, 400),
    ]
    const spot = nextSpot(objects, SIZE)
    // Right of the top row, aligned with top.
    expect(spot.x).toBe(560 + 200 + 80)
    expect(spot.y).toBe(0)
  })
})
