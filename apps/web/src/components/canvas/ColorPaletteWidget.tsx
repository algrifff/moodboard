import type { CanvasObject } from '@moodboard/shared'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { PALETTE_SWATCH_DURATION, PALETTE_SWATCH_STAGGER } from '@/lib/motion'
import { paletteFromGroup, type Swatch } from '@/lib/palette'
import { showToast } from './Toast'

const SWATCH = 32
const RADIUS = 7
const GAP = 7
const OFFSET_FROM_BOX = 9

function copyTextSync(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(textarea)
  return ok
}

export function ColorPaletteWidget({
  groupKey,
  objects,
  bounds,
  scale,
  offset,
}: {
  groupKey: string
  objects: CanvasObject[]
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
}) {
  const [swatches, setSwatches] = useState<Swatch[]>([])

  useEffect(() => {
    let cancelled = false
    paletteFromGroup(objects).then((s) => {
      if (!cancelled) setSwatches(s)
    })
    return () => {
      cancelled = true
    }
  }, [groupKey, objects])

  if (swatches.length === 0) return null

  const screenRight = bounds.right * scale + offset.x
  const screenTop = bounds.top * scale + offset.y

  const copy = (hex: string) => {
    const text = hex.toUpperCase()
    // Try the synchronous legacy path first while we're still in the user gesture.
    if (copyTextSync(text)) {
      showToast(`Copied ${text}`)
      return
    }
    // Fall back to the modern async clipboard API. The synchronous part of the
    // call still counts as being inside the click handler's gesture.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(`Copied ${text}`),
        () => showToast('Copy failed'),
      )
      return
    }
    showToast('Copy failed')
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: screenRight + OFFSET_FROM_BOX,
        top: screenTop,
        display: 'flex',
        gap: GAP,
        pointerEvents: 'auto',
        zIndex: 12,
      }}
    >
      {swatches.map((s, i) => (
        <motion.button
          key={`${groupKey}-${s.hex}`}
          type="button"
          onClick={() => copy(s.hex)}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            duration: PALETTE_SWATCH_DURATION,
            ease: 'easeOut',
            delay: i * PALETTE_SWATCH_STAGGER,
          }}
          aria-label={`Copy ${s.hex}`}
          title={`${s.hex.toUpperCase()} — click to copy`}
          style={{
            width: SWATCH,
            height: SWATCH,
            borderRadius: RADIUS,
            backgroundColor: s.hex,
            border: '1px solid rgba(15, 23, 42, 0.12)',
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.12)',
            cursor: 'pointer',
            padding: 0,
          }}
        />
      ))}
    </div>
  )
}
