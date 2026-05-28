import type { CanvasObject } from '@moodboard/shared'
import type { Point } from './transform'

export type Rect = { left: number; top: number; right: number; bottom: number }

export function aabbIntersect(a: Rect, b: Rect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

export function normalizeRect(p1: Point, p2: Point): Rect {
  return {
    left: Math.min(p1.x, p2.x),
    right: Math.max(p1.x, p2.x),
    top: Math.min(p1.y, p2.y),
    bottom: Math.max(p1.y, p2.y),
  }
}

export function objectRect(o: CanvasObject): Rect {
  return {
    left: o.position.x,
    top: o.position.y,
    right: o.position.x + o.size.width,
    bottom: o.position.y + o.size.height,
  }
}

export function objectsInMarquee(objects: CanvasObject[], p1: Point, p2: Point): string[] {
  const m = normalizeRect(p1, p2)
  return objects.filter((o) => aabbIntersect(m, objectRect(o))).map((o) => o.id)
}

export function aabbDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right))
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom))
  return Math.sqrt(dx * dx + dy * dy)
}

export function proximityGroups(objects: CanvasObject[], threshold = 24): string[][] {
  const n = objects.length
  if (n < 2) return []
  const parent: number[] = objects.map((_, i) => i)

  const find = (i: number): number => {
    let x = i
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const union = (i: number, j: number) => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }

  const rects = objects.map(objectRect)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (aabbDistance(rects[i]!, rects[j]!) <= threshold) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(i)
  }

  return [...groups.values()].filter((g) => g.length >= 2).map((g) => g.map((i) => objects[i]!.id))
}

export function groupBoundingBox(objects: CanvasObject[], padding = 20): Rect {
  if (objects.length === 0) {
    return { left: 0, top: 0, right: 0, bottom: 0 }
  }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const o of objects) {
    if (o.position.x < left) left = o.position.x
    if (o.position.y < top) top = o.position.y
    if (o.position.x + o.size.width > right) right = o.position.x + o.size.width
    if (o.position.y + o.size.height > bottom) bottom = o.position.y + o.size.height
  }
  return {
    left: left - padding,
    top: top - padding,
    right: right + padding,
    bottom: bottom + padding,
  }
}

export function groupId(objectIds: readonly string[]): string {
  return [...objectIds].sort().join('|')
}
