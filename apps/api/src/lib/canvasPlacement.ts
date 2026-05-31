import type { CanvasObject } from '@moodboard/shared'

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
