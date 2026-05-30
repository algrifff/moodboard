import { motion } from 'framer-motion'
import { EASE_OUT_STANDARD } from '@/lib/motion'

// One-shot expanding ring drawn behind a node when it first arrives on the
// canvas. The visual signal is "this came from elsewhere" — used for
// imported external nodes (Notion / Drive) to distinguish them from
// locally-spawned items.
//
// Lives on top of the node's transform so it scales with the card. Fires
// once on mount and never again — re-mounting (e.g. board hydration)
// won't replay the animation because the canvas store reuses object ids
// across renders and React keeps the component instance.

export function SpawnRing({ color = 'var(--accent)' }: { color?: string }) {
  return (
    <motion.div
      aria-hidden
      initial={{ scale: 1, opacity: 0.3 }}
      animate={{ scale: 1.06, opacity: 0 }}
      transition={{ duration: 0.32, ease: EASE_OUT_STANDARD }}
      style={{
        position: 'absolute',
        inset: -2,
        borderRadius: 'var(--radius-lg)',
        border: `1.5px solid ${color}`,
        pointerEvents: 'none',
      }}
    />
  )
}
