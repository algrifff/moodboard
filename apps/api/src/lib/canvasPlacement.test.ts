import type { CanvasObject } from '@moodboard/shared'
import { describe, expect, it } from 'vitest'
import { proximityGroups } from '@moodboard/shared'
import { clusterLayout, CLUSTER_GAP_PX, nextSpot } from './canvasPlacement'

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

describe('clusterLayout', () => {
  const at = (id: string, x: number, y: number, w = 200, h = 200): CanvasObject => ({
    ...makeObject(x, y, w, h),
    id,
  })
  const apply = (objects: CanvasObject[], positions: Map<string, { x: number; y: number }>) =>
    objects.map((o) => ({ ...o, position: positions.get(o.id) ?? o.position }))

  it('gathers scattered items into exactly one group of those items', () => {
    const members = [
      at('a', 0, 0),
      at('b', 2000, 40, 300, 120),
      at('c', -900, 1400),
      at('d', 50, 3000),
    ]
    const others = [at('x', 5000, 5000)]
    const moved = apply([...members, ...others], clusterLayout(members, others))
    expect(proximityGroups(moved)).toEqual([expect.arrayContaining(['a', 'b', 'c', 'd'])])
    expect(proximityGroups(moved)[0]).toHaveLength(4)
  })

  it('anchors on the first member in reading order when that spot is clear', () => {
    const members = [at('a', 400, 300), at('b', 2000, 900)]
    const positions = clusterLayout(members, [])
    expect(positions.get('a')).toEqual({ x: 400, y: 300 })
    expect(positions.get('b')).toEqual({ x: 400 + 200 + CLUSTER_GAP_PX, y: 300 })
  })

  it('moves away from non-members that would otherwise join the group', () => {
    const members = [at('a', 0, 0), at('b', 3000, 0)]
    const bystander = at('x', 450, 0)
    const moved = apply([...members, bystander], clusterLayout(members, [bystander]))
    const groups = proximityGroups(moved)
    expect(groups).toHaveLength(1)
    expect([...groups[0]!].sort()).toEqual(['a', 'b'])
  })
})
