import { X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ghostButton } from '@/components/ui'
import { EASE_OUT_STANDARD } from '@/lib/motion'

// The dialog shell the output pages share: scrim, card, title row.
export function Modal({
  open,
  onClose,
  title,
  width = 'max-w-md',
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  width?: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto px-4 py-[8vh]"
          style={{ backgroundColor: 'var(--scrim)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: [...EASE_OUT_STANDARD] }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          onKeyDown={(e) => {
            // Keys typed in a dialog stay in it; Escape from outside (focus
            // on the page body) is caught by the window listener above.
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
          }}
        >
          <motion.div
            role="dialog"
            aria-label={title}
            className={`w-full ${width} bg-card p-5`}
            style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)' }}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.2, ease: [...EASE_OUT_STANDARD] }}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground">{title}</h2>
              <button type="button" onClick={onClose} className={ghostButton} aria-label="Close">
                <X size={14} weight="bold" />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
