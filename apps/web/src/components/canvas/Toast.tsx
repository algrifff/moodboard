import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { TOAST_IN_DURATION, TOAST_OUT_DURATION } from '@/lib/motion'

type ToastMsg = { id: number; text: string }

let queueId = 0
const listeners = new Set<(msg: ToastMsg) => void>()

export function showToast(text: string) {
  const msg = { id: ++queueId, text }
  for (const fn of listeners) fn(msg)
}

export function ToastHost() {
  const [msgs, setMsgs] = useState<ToastMsg[]>([])

  useEffect(() => {
    const onMsg = (msg: ToastMsg) => {
      setMsgs((m) => [...m, msg])
      setTimeout(() => {
        setMsgs((m) => m.filter((x) => x.id !== msg.id))
      }, 1500)
    }
    listeners.add(onMsg)
    return () => {
      listeners.delete(onMsg)
    }
  }, [])

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex flex-col items-center gap-2">
      <AnimatePresence>
        {msgs.map((m) => (
          <motion.div
            key={m.id}
            initial={{ y: -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{
              enter: { duration: TOAST_IN_DURATION, ease: [0.2, 0.8, 0.2, 1] },
              exit: { duration: TOAST_OUT_DURATION, ease: [0.4, 0, 0.6, 1] },
            }}
            className="bg-card/95 backdrop-blur-md px-3 py-1.5 text-xs font-mono text-foreground shadow-[0_6px_24px_-12px_rgba(0,0,0,0.6)]"
            style={{ borderRadius: 'var(--radius)' }}
          >
            {m.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
