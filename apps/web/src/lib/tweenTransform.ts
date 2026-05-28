// rAF tween for the canvas pan/zoom transform. Used for Cmd+0 (reset) and
// Cmd+1 (fit-all) so the camera glides rather than snapping instant.

type Transform = { scale: number; offset: { x: number; y: number } }

export type EasingFn = (t: number) => number

export function tweenTransform(
  from: Transform,
  to: Transform,
  durationMs: number,
  easing: EasingFn,
  apply: (next: Transform) => void,
): () => void {
  const start = performance.now()
  let raf = 0
  let cancelled = false

  const step = (now: number) => {
    if (cancelled) return
    const linear = Math.min(1, Math.max(0, (now - start) / durationMs))
    const t = easing(linear)
    apply({
      scale: from.scale + (to.scale - from.scale) * t,
      offset: {
        x: from.offset.x + (to.offset.x - from.offset.x) * t,
        y: from.offset.y + (to.offset.y - from.offset.y) * t,
      },
    })
    if (linear < 1) raf = requestAnimationFrame(step)
    else apply(to) // Ensure we land exactly on the target.
  }
  raf = requestAnimationFrame(step)
  return () => {
    cancelled = true
    cancelAnimationFrame(raf)
  }
}
