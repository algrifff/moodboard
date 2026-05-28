import { motion } from 'framer-motion'
import { EASE_OUT_STANDARD } from '@/lib/motion'

// Wraps each route in a 180ms opacity crossfade. Driven by AnimatePresence
// at the route level (see App.tsx). Stays opacity-only — translates cause
// layout-shift on min-h-screen and fixed-position pages.
export function PageMotion({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: [...EASE_OUT_STANDARD] }}
    >
      {children}
    </motion.div>
  )
}
