import { AnimatePresence, motion } from 'framer-motion'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'

// Shown only when the board has no objects. Fades out as soon as the first
// object lands. Pointer-events:none so it never intercepts drops or clicks.
export function EmptyStateHint() {
  const empty = useCanvasStore((s) => s.objects.length === 0)
  return (
    <AnimatePresence>
      {empty && (
        <motion.div
          key="empty-state"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.24, ease: EASE_OUT_STANDARD }}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <div className="max-w-md px-6 text-center select-none">
            <p className="text-base font-medium text-[var(--text-soft)]">
              Drop images here, paste from your clipboard, or use the toolbar to add.
            </p>
            <p className="mt-2 text-xs text-[var(--text-faint)]">
              PDFs, sticky notes, and text too.
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
