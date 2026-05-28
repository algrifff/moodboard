import { useEffect, useState } from 'react'

// Runs an opacity-only fade-in once on mount. Quartic ease-out so the last
// 30% of the curve does the visible work — feels like the object "lands."
// Used by Konva nodes where we can't drop in a Framer Motion wrapper.
export function useSpawnOpacity(durationMs = 240): number {
  const [opacity, setOpacity] = useState(0)

  useEffect(() => {
    const start = performance.now()
    let raf = 0
    let cancelled = false
    const step = (now: number) => {
      if (cancelled) return
      const t = Math.min(1, (now - start) / durationMs)
      // ease-out quartic
      const eased = 1 - Math.pow(1 - t, 4)
      setOpacity(eased)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [durationMs])

  return opacity
}
