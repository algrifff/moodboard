import { useCallback, useLayoutEffect, type RefObject } from 'react'

type FitOptions = {
  width: number
  height: number
  min?: number
  max?: number
}

export function useFitText<T extends HTMLElement>(
  textRef: RefObject<T | null>,
  opts: FitOptions,
) {
  const { width, height, min = 12, max = 96 } = opts

  const fit = useCallback(() => {
    const el = textRef.current
    if (!el) return
    const containerH = el.clientHeight
    const containerW = el.clientWidth
    if (containerH <= 0 || containerW <= 0) return

    let low = min
    let high = max
    for (let i = 0; i < 14; i++) {
      const mid = (low + high) / 2
      el.style.fontSize = `${mid}px`
      if (el.scrollHeight <= containerH && el.scrollWidth <= containerW + 1) {
        low = mid
      } else {
        high = mid
      }
    }
    el.style.fontSize = `${low}px`
  }, [textRef, min, max])

  useLayoutEffect(() => {
    fit()
  }, [width, height, fit])

  return fit
}
