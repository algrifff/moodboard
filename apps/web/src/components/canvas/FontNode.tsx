import type { CanvasObject, FontData } from '@moodboard/shared'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { useFitText } from '@/hooks/useFitText'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'

// Module-scope cache so multiple FontNodes referencing the same family
// share one FontFace load + registration. Keyed by family — family is
// derived server-side from the upload filename, so collisions only
// happen across literally identical filenames, which is correct.
const fontLoads = new Map<string, Promise<void>>()

export function ensureFontLoaded(family: string, url: string): Promise<void> {
  const existing = fontLoads.get(family)
  if (existing) return existing
  // Quote the URL safely inside the CSS source descriptor.
  const cssUrl = `url(${JSON.stringify(url)})`
  const face = new FontFace(family, cssUrl)
  const promise = face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded)
    })
    .catch((err) => {
      // Drop from cache so a remount can retry — e.g. transient 5xx on
      // the file route.
      fontLoads.delete(family)
      throw err
    })
  fontLoads.set(family, promise)
  return promise
}

export function FontNode({
  object,
  scale,
  panMode,
  selected,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
}) {
  const data = object.data as FontData
  const sampleRef = useRef<HTMLDivElement>(null)
  // `document.fonts.check` returns true if the family is already
  // registered (e.g. another FontNode on the board), letting us skip
  // the fallback flash on revisits.
  const [loaded, setLoaded] = useState(() =>
    typeof document !== 'undefined' ? document.fonts.check(`16px "${data.family}"`) : false,
  )

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 220,
    minHeight: 120,
    haloPx: HALO,
  })

  const refit = useFitText(sampleRef, {
    width: object.size.width,
    height: object.size.height,
    min: 20,
    max: 160,
  })

  // Load on mount; refit when the real font's metrics arrive so the
  // useFitText binary search uses accurate widths.
  useEffect(() => {
    let cancelled = false
    ensureFontLoaded(data.family, data.url)
      .then(() => {
        if (cancelled) return
        setLoaded(true)
        refit()
      })
      .catch(() => {
        // Silent failure — the fallback font still renders, the user
        // sees the family name in the system sans.
      })
    return () => {
      cancelled = true
    }
  }, [data.family, data.url, refit])

  const sample =
    data.sampleText && data.sampleText.trim().length > 0 ? data.sampleText : data.family

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: OBJECT_SPAWN_DURATION, ease: [...SNAP_CURVE] }}
      onPointerEnter={interaction.onPointerEnter}
      onPointerLeave={interaction.onPointerLeave}
      onPointerMove={interaction.onPointerMove}
      onPointerDown={interaction.onPointerDown}
      onPointerUp={interaction.onPointerUp}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 18px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)] font-semibold">
          Font · {data.family}
        </div>
        <div
          ref={sampleRef}
          style={{
            flex: 1,
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            // The family is wrapped in quotes for safety (allows family
            // names with spaces). Falls back to system sans while the
            // FontFace loads or if the load failed.
            fontFamily: `"${data.family}", ui-sans-serif, system-ui, -apple-system, sans-serif`,
            fontSize: 48, // overridden by useFitText
            lineHeight: 1.05,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            transition: 'opacity 200ms',
            opacity: loaded ? 1 : 0.6,
          }}
        >
          {sample}
        </div>
      </div>
    </motion.div>
  )
}
