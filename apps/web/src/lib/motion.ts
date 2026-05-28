import type { Transition } from 'framer-motion'

export const SNAP_CURVE = [0.7, -0.05, 0.2, 1.05] as const
export const EASE_OUT_STANDARD = [0.2, 0.8, 0.2, 1] as const
export const EASE_OUT_QUICK = [0.3, 0, 0.2, 1] as const

export const SNAP_SPRING: Transition = {
  type: 'spring',
  stiffness: 700,
  damping: 22,
  mass: 0.6,
}

export const GROUP_OUTLINE_DURATION = 0.28
export const PALETTE_SWATCH_DURATION = 0.22
export const PALETTE_SWATCH_STAGGER = 0.03
export const AI_PANEL_DURATION = 0.24
export const TOAST_IN_DURATION = 0.18
export const TOAST_OUT_DURATION = 0.2
export const TOOLBAR_PRESS_DURATION = 0.12
export const OBJECT_SPAWN_DURATION = 0.22
// Pan/zoom transitions for keyboard shortcuts. Cmd+0 (reset) is the calmer
// of the two; Cmd+1 (fit-all) is a deliberate gesture that earns the snap.
export const ZOOM_RESET_DURATION_MS = 250
export const FIT_ALL_DURATION_MS = 350
