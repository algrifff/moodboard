import type { CanvasObject } from '@moodboard/shared'
import { Eyedropper, LockSimple, LockSimpleOpen, Pencil } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { HexColorPicker } from 'react-colorful'
import { useEffect, useRef, useState } from 'react'
import { PALETTE_SWATCH_DURATION, PALETTE_SWATCH_STAGGER, SNAP_CURVE } from '@/lib/motion'
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

// Per-slot user override. When `locked`, the slot keeps its hex even when
// the underlying palette recomputes (image added, image resized, etc.).
type Override = { hex: string; locked: boolean }

const HEX_RE = /^#?([0-9a-fA-F]{6})$/

function normaliseHex(input: string): string | null {
  const m = input.trim().match(HEX_RE)
  if (!m) return null
  return `#${m[1]!.toUpperCase()}`
}

export function ColorPaletteWidget({
  groupKey,
  objects,
  bounds,
  scale,
  offset,
  aiPalette,
}: {
  groupKey: string
  objects: CanvasObject[]
  bounds: { left: number; top: number; right: number; bottom: number }
  scale: number
  offset: { x: number; y: number }
  // Set by the AI analysis flow when an agent or synthesis run produces a
  // palette. Takes over from image-extraction: the swatches snap to these
  // hexes, every slot is auto-locked. Unlocking + editing still works the
  // same way as for image-extracted swatches.
  aiPalette?: string[]
}) {
  const [swatches, setSwatches] = useState<Swatch[]>([])
  const [overrides, setOverrides] = useState<Record<number, Override>>({})
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // String key for comparing AI palette content across renders. Lets us
  // detect a genuinely-new palette without depending on parent referential
  // stability of the hex array.
  const aiKey = aiPalette && aiPalette.length > 0 ? aiPalette.join('|') : null

  // Image-extracted palette — runs only while no AI palette is active so a
  // group-mutation (added/resized image) doesn't trample the curated set.
  // The cancelled flag also handles the case where an AI palette arrives
  // mid-extraction.
  useEffect(() => {
    if (aiKey) return
    let cancelled = false
    paletteFromGroup(objects).then((s) => {
      if (!cancelled) setSwatches(s)
    })
    return () => {
      cancelled = true
    }
  }, [groupKey, objects, aiKey])

  // AI palette takeover. Replace the swatch source AND seed every slot's
  // override as locked, so the lock-badge UI reflects "these are committed
  // choices." Unlocking still removes the override and reveals the swatch
  // hex underneath (which is the AI hex), so the colour stays put.
  useEffect(() => {
    if (!aiPalette || aiPalette.length === 0) return
    setSwatches(aiPalette.map((hex) => ({ hex, population: 0 })))
    setOverrides(Object.fromEntries(aiPalette.map((hex, i) => [i, { hex, locked: true }])))
    // We intentionally key on aiKey rather than aiPalette so a fresh array
    // reference with identical hexes is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiKey])

  if (swatches.length === 0) return null

  const screenRight = bounds.right * scale + offset.x
  const screenTop = bounds.top * scale + offset.y

  // Effective display hex per slot: override (locked) wins over computed.
  const effective = swatches.map((s, i) => (overrides[i]?.locked ? overrides[i]!.hex : s.hex))

  const copy = (hex: string) => {
    const text = hex.toUpperCase()
    if (copyTextSync(text)) {
      showToast(`Copied ${text}`)
      return
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(`Copied ${text}`),
        () => showToast('Copy failed'),
      )
      return
    }
    showToast('Copy failed')
  }

  // Manual hex change → lock that slot to the new value.
  const setHex = (i: number, raw: string) => {
    const hex = normaliseHex(raw)
    if (!hex) return
    setOverrides((o) => ({ ...o, [i]: { hex, locked: true } }))
  }

  // Lock toggles: unlocking removes the override entirely (so the slot
  // can pick up the next computed value); locking captures the currently
  // displayed hex.
  const toggleLock = (i: number) => {
    setOverrides((o) => {
      const current = o[i]
      if (current?.locked) {
        const { [i]: _drop, ...rest } = o
        void _drop
        return rest
      }
      return { ...o, [i]: { hex: effective[i] ?? swatches[i]!.hex, locked: true } }
    })
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
        // Above the analysis panel's z so the popover is never clipped /
        // visually layered behind agent cards from adjacent groups.
        zIndex: openIndex !== null ? 40 : 16,
      }}
    >
      {swatches.map((s, i) => {
        const hex = effective[i]!
        const locked = !!overrides[i]?.locked
        const isOpen = openIndex === i
        return (
          <SwatchCell
            key={`${groupKey}-${i}`}
            index={i}
            hex={hex}
            locked={locked}
            isOpen={isOpen}
            staggerDelay={i * PALETTE_SWATCH_STAGGER}
            onCopy={() => copy(hex)}
            onOpen={() => setOpenIndex((p) => (p === i ? null : i))}
            onClose={() => setOpenIndex(null)}
            onHex={(h) => setHex(i, h)}
            onToggleLock={() => toggleLock(i)}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One swatch + its hover edit + lock badge + popover.
// ---------------------------------------------------------------------------

function SwatchCell({
  hex,
  locked,
  isOpen,
  staggerDelay,
  onCopy,
  onOpen,
  onClose,
  onHex,
  onToggleLock,
}: {
  index: number
  hex: string
  locked: boolean
  isOpen: boolean
  staggerDelay: number
  onCopy: () => void
  onOpen: () => void
  onClose: () => void
  onHex: (h: string) => void
  onToggleLock: () => void
}) {
  return (
    <div className="relative" style={{ width: SWATCH, height: SWATCH }}>
      <motion.button
        type="button"
        onClick={() => (isOpen ? onClose() : onCopy())}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{
          duration: PALETTE_SWATCH_DURATION,
          ease: [...SNAP_CURVE],
          delay: staggerDelay,
        }}
        whileHover={{
          scale: 1.08,
          transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] },
        }}
        aria-label={`Copy ${hex}`}
        title={`${hex.toUpperCase()} — click to copy`}
        className="group block"
        style={{
          width: SWATCH,
          height: SWATCH,
          borderRadius: RADIUS,
          backgroundColor: hex,
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.30), inset 0 0 0 1px rgba(255, 255, 255, 0.10)',
          cursor: 'pointer',
          padding: 0,
          position: 'relative',
        }}
      >
        {/* Edit icon — top-right. Visible on swatch hover. */}
        <span
          className="absolute -top-1.5 -right-1.5 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center"
          style={{
            width: 16,
            height: 16,
            borderRadius: 999,
            backgroundColor: 'var(--bg-card)',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpen()
          }}
          role="button"
          aria-label="Edit color"
          title="Edit color"
        >
          <Pencil size={9} weight="bold" color="var(--text)" />
        </span>

        {/* Lock toggle — top-LEFT, opposite the edit icon. Locked: always
            visible (accent badge). Unlocked: hover-only (muted badge).
            Symmetric affordance to the edit icon on the other corner. */}
        <span
          className={`absolute -top-1.5 -left-1.5 transition-opacity inline-flex items-center justify-center ${
            locked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{
            width: 16,
            height: 16,
            borderRadius: 999,
            backgroundColor: locked ? 'var(--accent)' : 'var(--bg-card)',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleLock()
          }}
          role="button"
          aria-label={locked ? 'Unlock color' : 'Lock color'}
          aria-pressed={locked}
          title={locked ? 'Unlock color' : 'Lock color'}
        >
          {locked ? (
            <LockSimple size={9} weight="bold" color="var(--bg)" />
          ) : (
            <LockSimpleOpen size={9} weight="bold" color="var(--text)" />
          )}
        </span>
      </motion.button>

      {isOpen && <EditPopover hex={hex} onHex={onHex} onClose={onClose} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Popover — color picker + hex input + lock toggle.
// ---------------------------------------------------------------------------

// Lightweight typing for the EyeDropper Web API — TS doesn't ship lib types
// for it yet. Available in Chromium browsers (Chrome / Edge / Arc).
type EyeDropperApi = {
  open: () => Promise<{ sRGBHex: string }>
}
declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperApi
  }
}

function EditPopover({
  hex,
  onHex,
  onClose,
}: {
  hex: string
  onHex: (h: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(hex.toUpperCase())
  // Feature-detect once on mount. Picker support is Chromium-only for now.
  const eyeDropperSupported =
    typeof window !== 'undefined' && typeof window.EyeDropper === 'function'

  const pickWithEyeDropper = async () => {
    if (!window.EyeDropper) return
    try {
      const ed = new window.EyeDropper()
      const result = await ed.open()
      if (result.sRGBHex) onHex(result.sRGBHex)
    } catch {
      // User cancelled with Escape — silent.
    }
  }

  // Keep text in sync when hex changes externally (e.g. color picker firing).
  useEffect(() => {
    setText(hex.toUpperCase())
  }, [hex])

  // Click-outside and Escape to close.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const commitText = () => {
    const next = normaliseHex(text)
    if (next && next !== hex) onHex(next)
    else setText(hex.toUpperCase())
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
      style={{
        position: 'absolute',
        top: SWATCH + 8,
        left: 0,
        width: 180,
        // Explicit solid colour so the popover never reads as transparent —
        // it sits inside the high-z palette container so it stacks above
        // the analysis cards behind it.
        backgroundColor: 'var(--bg-card)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 10px 32px -12px rgba(0,0,0,0.7)',
        padding: 10,
        zIndex: 50,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={text}
          spellCheck={false}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          aria-label="Hex code"
          className="shrink-0 bg-[var(--bg-elevated)] px-2 py-1.5 text-[12px] font-mono text-foreground outline-none ring-1 ring-[var(--border-soft)] focus:ring-[var(--accent)] transition-[box-shadow]"
          style={{ width: 100, borderRadius: 'var(--radius)' }}
        />
        {eyeDropperSupported && (
          <button
            type="button"
            onClick={pickWithEyeDropper}
            className="shrink-0 inline-flex items-center justify-center bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:text-foreground transition-colors"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius)',
            }}
            aria-label="Pick a color from anywhere on screen"
            title="Pick a color from anywhere on screen"
          >
            <Eyedropper size={14} weight="regular" />
          </button>
        )}
      </div>

      {/* react-colorful — inline picker, always visible, no separate OS
          window. Dragging the saturation/value field or the hue bar fires
          onChange synchronously which both displays + auto-locks. */}
      <div className="mt-2 palette-picker">
        <HexColorPicker color={hex} onChange={onHex} />
      </div>
    </motion.div>
  )
}
