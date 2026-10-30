import {
  aabbIntersect,
  GROUP_PROXIMITY_PX,
  objectRect,
  type CanvasObject,
  type Rect,
} from '@moodboard/shared'

// MCP-side auto-placement. The MCP server has no viewport, so when the
// user (or model) drops a node we tile it to the right of existing
// content with generous spacing — far enough to dodge the 48px
// grouping proximity rule so unrelated drops don't accidentally fuse.
// Wraps to a new row after a column count to keep boards horizontal-
// scroll-friendly.

const ROW_PADDING_PX = 80
const NEW_ROW_GAP_PX = 80
const WRAP_AFTER = 6

export type Size = { width: number; height: number }
export type Point = { x: number; y: number }

export function nextSpot(objects: CanvasObject[], size: Size): Point {
  if (objects.length === 0) return { x: 0, y: 0 }

  // Build the row layout from existing objects by partitioning into
  // horizontal bands. Bands are defined by `top` clustering — anything
  // sharing roughly the same top edge counts as one row.
  let minTop = Infinity
  let maxBottom = -Infinity
  let maxRight = -Infinity
  let topOfRightmostRow = 0
  for (const o of objects) {
    if (o.position.y < minTop) minTop = o.position.y
    const right = o.position.x + o.size.width
    const bottom = o.position.y + o.size.height
    if (bottom > maxBottom) maxBottom = bottom
    if (right > maxRight) {
      maxRight = right
      topOfRightmostRow = o.position.y
    }
  }

  // Count how many objects share the rightmost row's `top` band
  // (within half the new object's height — coarse enough to absorb
  // minor vertical jitter from prior drops).
  const bandHalf = Math.max(40, size.height / 2)
  let inBand = 0
  for (const o of objects) {
    if (Math.abs(o.position.y - topOfRightmostRow) <= bandHalf) inBand++
  }

  if (inBand >= WRAP_AFTER) {
    // Wrap to a new row below the lowest existing object.
    return { x: 0, y: maxBottom + NEW_ROW_GAP_PX }
  }
  return { x: maxRight + ROW_PADDING_PX, y: topOfRightmostRow }
}

// Gap between items when pulling them into a group — well inside the 48px
// proximity rule so the cluster reads as one group, with room to breathe.
export const CLUSTER_GAP_PX = 24
// How far the cluster keeps from items that aren't joining it, so they
// don't get swept into the group.
const CLUSTER_CLEARANCE_PX = GROUP_PROXIMITY_PX + 32

// Lays `members` out as a tidy grid (reading order preserved) at a spot
// where no other object is within proximity range. Prefers to gather them
// where the first member already sits; otherwise the next free spot, and
// as a last resort below everything.
export function clusterLayout(members: CanvasObject[], others: CanvasObject[]): Map<string, Point> {
  const ordered = [...members].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
  )
  const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
  const relative = new Map<string, Point>()
  let y = 0
  let width = 0
  for (let start = 0; start < ordered.length; start += cols) {
    const row = ordered.slice(start, start + cols)
    let x = 0
    let rowHeight = 0
    for (const o of row) {
      relative.set(o.id, { x, y })
      x += o.size.width + CLUSTER_GAP_PX
      rowHeight = Math.max(rowHeight, o.size.height)
    }
    width = Math.max(width, x - CLUSTER_GAP_PX)
    y += rowHeight + CLUSTER_GAP_PX
  }
  const size = { width, height: Math.max(0, y - CLUSTER_GAP_PX) }

  const isClear = (origin: Point) => {
    const zone: Rect = {
      left: origin.x - CLUSTER_CLEARANCE_PX,
      top: origin.y - CLUSTER_CLEARANCE_PX,
      right: origin.x + size.width + CLUSTER_CLEARANCE_PX,
      bottom: origin.y + size.height + CLUSTER_CLEARANCE_PX,
    }
    return others.every((o) => !aabbIntersect(zone, objectRect(o)))
  }
  const below = (): Point => {
    if (others.length === 0) return { x: 0, y: 0 }
    const left = Math.min(...others.map((o) => o.position.x))
    const bottom = Math.max(...others.map((o) => o.position.y + o.size.height))
    return { x: left, y: bottom + CLUSTER_CLEARANCE_PX * 2 }
  }
  const first = ordered[0]
  const candidates = [...(first ? [first.position] : []), nextSpot(others, size), below()]
  const origin = candidates.find(isClear) ?? below()

  const out = new Map<string, Point>()
  for (const [id, p] of relative) out.set(id, { x: origin.x + p.x, y: origin.y + p.y })
  return out
}
