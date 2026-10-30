import { groupBoundingBox, type CanvasObject } from '@moodboard/shared'
import { cubicBezier } from 'framer-motion'
import { EASE_OUT_STANDARD, FIT_ALL_DURATION_MS } from '@/lib/motion'
import { tweenTransform } from '@/lib/tweenTransform'
import { useCanvasStore } from '@/store/canvas'

type Viewport = { width: number; height: number }

// The pan/zoom that frames `objects` in the viewport, capped so a single
// small item doesn't fill the screen.
export function frameObjects(
  objects: CanvasObject[],
  viewport: Viewport,
  { padding = 40, maxScale = 4 }: { padding?: number; maxScale?: number } = {},
): { scale: number; offset: { x: number; y: number } } | null {
  if (objects.length === 0) return null
  const bbox = groupBoundingBox(objects, padding)
  const w = bbox.right - bbox.left
  const h = bbox.bottom - bbox.top
  if (w <= 0 || h <= 0 || viewport.width <= 0 || viewport.height <= 0) return null
  const scale = Math.max(0.1, Math.min(maxScale, viewport.width / w, viewport.height / h))
  const cx = (bbox.left + bbox.right) / 2
  const cy = (bbox.top + bbox.bottom) / 2
  return {
    scale,
    offset: { x: viewport.width / 2 - cx * scale, y: viewport.height / 2 - cy * scale },
  }
}

let cancelTween: (() => void) | null = null

// "Jump to on canvas": glide to the objects and select them. Lands calmly
// rather than snapping — it's a response to a click elsewhere on screen.
export function focusObjects(ids: string[]): boolean {
  const s = useCanvasStore.getState()
  const idSet = new Set(ids)
  const targets = s.objects.filter((o) => idSet.has(o.id))
  const to = frameObjects(targets, s.viewportSize, { padding: 80, maxScale: 1.25 })
  if (!to) return false
  s.setSelection(targets.map((o) => o.id))
  cancelTween?.()
  cancelTween = tweenTransform(
    { scale: s.scale, offset: s.offset },
    to,
    FIT_ALL_DURATION_MS,
    cubicBezier(...EASE_OUT_STANDARD),
    (next) => useCanvasStore.getState().setTransform(next),
  )
  return true
}
