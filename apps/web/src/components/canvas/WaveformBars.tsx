// 18-bar waveform strip — used live in the recording HUD and statically on
// the on-canvas voice-note card. Both modes share the same visual so the
// card reads as a frozen snapshot of what was just on screen.
//
// Live mode avoids React renders per frame: the parent grabs a ref via
// `useImperativeHandle` and calls `setLevels(bars, isPeaking)` inside its
// own RAF / onLevel callback. The bars mutate via direct style writes.
// Static mode just consumes the `levels` prop on render.
//
// Colour: bar fill is `currentColor`. The wrapper's `color` interpolates
// between --text-mute (rest) and --accent (peak) with a soft 120ms ease,
// so the strip tints in time with the voice rather than flickering.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { BAR_COUNT } from '@/lib/voiceRecorder'

export type WaveformBarsHandle = {
  setLevels: (bars: ArrayLike<number>, isPeaking: boolean) => void
}

type Props = {
  // Initial / static levels — values in 0..1. Re-render swaps in new bars.
  levels?: ReadonlyArray<number>
  // Whether the strip is in "peaking" state on first render. The live HUD
  // overrides this via the imperative handle every frame.
  isPeaking?: boolean
  // Overall strip height in CSS px.
  height?: number
  // Silence floor — the minimum scaleY so a quiet bar still reads as a
  // bar, not a missing one. 0..1 ratio of the strip height.
  floor?: number
  // Width per bar in CSS px. Defaults pack 18 bars + gaps into ~260px.
  barWidth?: number
  // Gap between bars in CSS px.
  gap?: number
  // Optional class for layout positioning.
  className?: string
}

export const WaveformBars = forwardRef<WaveformBarsHandle, Props>(function WaveformBars(
  { levels, isPeaking = false, height = 36, floor = 0.06, barWidth = 3, gap = 4, className },
  handle,
) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<Array<HTMLDivElement | null>>([])

  // Imperative path — the live HUD writes here every frame without
  // triggering a React render.
  useImperativeHandle(
    handle,
    () => ({
      setLevels(bars, peaking) {
        const nodes = barRefs.current
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]
          if (!node) continue
          const raw = bars[i] ?? 0
          const clamped = Math.min(1, Math.max(floor, raw))
          node.style.transform = `scaleY(${clamped.toFixed(3)})`
        }
        const wrapper = wrapperRef.current
        if (wrapper) wrapper.dataset.peaking = peaking ? 'true' : 'false'
      },
    }),
    [floor],
  )

  // Apply the static `levels` prop on mount + change. The live HUD passes
  // a fresh `levels` only for the first paint; after that the imperative
  // handle takes over.
  useEffect(() => {
    if (!levels) return
    const nodes = barRefs.current
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node) continue
      const raw = levels[i] ?? 0
      const clamped = Math.min(1, Math.max(floor, raw))
      node.style.transform = `scaleY(${clamped.toFixed(3)})`
    }
  }, [levels, floor])

  return (
    <div
      ref={wrapperRef}
      data-peaking={isPeaking ? 'true' : 'false'}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap,
        height,
        // Colour interpolation lives on the wrapper so every bar (which
        // uses `currentColor`) gets the swell at once. Peak → accent, rest
        // → text-mute. Hardcoded transition timing matches the rest of the
        // motion language for "instant attack, soft release."
        color: isPeaking ? 'var(--accent)' : 'var(--text-mute)',
        transition: 'color 120ms cubic-bezier(0.3, 0, 0.2, 1)',
      }}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <div
          key={i}
          ref={(node) => {
            barRefs.current[i] = node
          }}
          style={{
            width: barWidth,
            height: '100%',
            borderRadius: barWidth,
            backgroundColor: 'currentColor',
            transformOrigin: 'center',
            transform: `scaleY(${floor})`,
            // Width-only transition; height is driven instantly by the
            // RAF loop or the static effect above. No bar-height tween.
            transition: 'background-color 120ms cubic-bezier(0.3, 0, 0.2, 1)',
            willChange: 'transform',
          }}
        />
      ))}
    </div>
  )
})
