import { motion } from 'framer-motion'
import { GROUP_OUTLINE_DURATION, SNAP_SPRING } from '@/lib/motion'

export function GroupOutline({
  bounds,
  scale,
  offset,
}: {
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
}) {
  const width = (bounds.right - bounds.left) * scale
  const height = (bounds.bottom - bounds.top) * scale
  const left = bounds.left * scale + offset.x
  const top = bounds.top * scale + offset.y

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        ...SNAP_SPRING,
        opacity: { duration: GROUP_OUTLINE_DURATION, ease: [0.2, 0.8, 0.2, 1] },
      }}
      style={{
        position: 'absolute',
        left,
        top,
        width,
        height,
        borderRadius: 12 * scale,
        border: '1.5px solid #7B5CFF',
        backgroundColor: 'rgba(123, 92, 255, 0.03)',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  )
}
