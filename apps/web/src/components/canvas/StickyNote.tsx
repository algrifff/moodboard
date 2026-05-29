import type { CanvasObject, StickyData } from '@moodboard/shared'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { HexColorPicker } from 'react-colorful'
import ReactMarkdown from 'react-markdown'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { useFitText } from '@/hooks/useFitText'
import { readableOn } from '@/lib/color'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'

export function StickyNote({
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
  const data = object.data as StickyData
  const [editing, setEditing] = useState(() => data.text === '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)
  const updateObject = useCanvasStore((s) => s.updateObject)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing,
    minWidth: 100,
    minHeight: 100,
    haloPx: HALO,
  })

  const refit = useFitText(textRef, {
    width: object.size.width,
    height: object.size.height,
    // 12-px floor instead of 14 — gives auto-fit some extra headroom
    // before content overflows. For genuine "I just pasted an essay"
    // cases the paste handler below grows the box instead of letting
    // the font shrink past readability.
    min: 12,
    max: 96,
  })

  // Auto-grow the note when a large body of text is pasted. Default
  // useFitText behaviour would shrink the font to fit the existing box,
  // which makes a pasted document microscopic. Instead, on paste we
  // measure the new content and resize the box so the text lands at a
  // comfortable reading size (~14 px). The fit step then refines the
  // exact font size to fill the new dimensions.
  const handlePaste = () => {
    requestAnimationFrame(() => {
      if (!textRef.current) return
      const text = textRef.current.innerText
      const fontPx = 14
      // Rough average character width for proportional sans at the
      // target font size. The exact number doesn't matter — close enough
      // gets the box into the right ballpark and useFitText handles the
      // final layout.
      const charWidth = fontPx * 0.55
      const lineHeight = fontPx * 1.5
      const horizontalPadding = 32 // 16-px each side from the note card
      const verticalPadding = 36 // includes the outline + outlineOffset
      // Keep current width unless it's too narrow to read in (< 360);
      // grow height to fit. If the user wants narrower, they can drag
      // the resize handle after — but a 100-px wide note isn't useful
      // for a paragraph.
      const targetWidth = Math.max(object.size.width, 360)
      const innerWidth = targetWidth - horizontalPadding
      const charsPerLine = Math.max(1, Math.floor(innerWidth / charWidth))
      const explicitLines = text.split('\n').length
      const softLines = Math.max(explicitLines, Math.ceil(text.length / charsPerLine))
      const targetHeight = Math.max(
        object.size.height,
        Math.ceil(softLines * lineHeight + verticalPadding),
      )
      if (targetWidth !== object.size.width || targetHeight !== object.size.height) {
        useCanvasStore.getState().commitBeforeAction()
        updateObject(object.id, {
          size: { width: targetWidth, height: targetHeight },
        })
      }
    })
  }

  // When entering view mode after an edit, sync innerText so the markdown
  // renderer receives the latest source. In view mode the contentEditable
  // is off, so we render `data.text` through ReactMarkdown — innerText
  // sync only matters during edit transitions.
  useEffect(() => {
    if (editing && textRef.current && textRef.current.innerText !== data.text) {
      textRef.current.innerText = data.text
    }
    // Refit on data/mode change. View mode swaps to JSX markdown which
    // can change measured size; edit mode swaps to plain contentEditable.
    refit()
  }, [data.text, editing, refit])

  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.focus()
      const range = document.createRange()
      range.selectNodeContents(textRef.current)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [editing])

  const commit = () => {
    if (textRef.current) {
      const next = textRef.current.innerText
      if (next !== data.text) {
        useCanvasStore.getState().commitBeforeAction()
        updateObject(object.id, { data: { ...data, text: next } })
      }
    }
    setEditing(false)
  }

  const toggleTransparent = () => {
    useCanvasStore.getState().commitBeforeAction()
    updateObject(object.id, { data: { ...data, transparent: !data.transparent } })
  }

  const setColor = (hex: string) => {
    useCanvasStore.getState().commitBeforeAction()
    // Picking a colour also implies "not transparent" — user has chosen
    // a fill explicitly. They can re-enable transparency from the toolbar.
    updateObject(object.id, { data: { ...data, color: hex, transparent: false } })
  }

  const isTransparent = !!data.transparent
  const textColor = isTransparent ? 'var(--text)' : readableOn(data.color)

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
      onDoubleClick={(e) => {
        if (panMode) return
        e.stopPropagation()
        setEditing(true)
      }}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        userSelect: editing ? 'text' : 'none',
        pointerEvents: 'auto',
      }}
    >
      {/* Floating widget — colour + transparency toggle. Shows when the
          note is selected and the user isn't actively editing. Sits above
          the note via absolute positioning so it doesn't affect layout. */}
      {selected && !editing && (
        <NoteToolbar
          color={data.color}
          transparent={isTransparent}
          pickerOpen={pickerOpen}
          onToggleTransparent={toggleTransparent}
          onTogglePicker={() => setPickerOpen((v) => !v)}
          onClosePicker={() => setPickerOpen(false)}
          onPickColor={setColor}
        />
      )}

      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: isTransparent ? 'transparent' : data.color,
          boxShadow: isTransparent ? 'none' : '0 4px 12px rgba(15, 23, 42, 0.12)',
          borderRadius: isTransparent ? 0 : 8,
          padding: '14px 16px',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
          lineHeight: 1.2,
          color: textColor,
          overflow: 'hidden',
          boxSizing: 'border-box',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
        }}
      >
        {editing ? (
          // Edit mode — raw markdown source in contentEditable.
          <div
            ref={textRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={commit}
            onInput={refit}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                commit()
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              outline: 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              cursor: 'inherit',
            }}
          />
        ) : (
          // View mode — rendered markdown. The `note-markdown` class
          // carries em-based sizing for headings/lists so useFitText can
          // scale everything proportionally with the root font-size.
          <div
            ref={textRef}
            className="note-markdown"
            style={{
              width: '100%',
              height: '100%',
              wordBreak: 'break-word',
              cursor: 'inherit',
            }}
          >
            {data.text.trim().length > 0 ? (
              <ReactMarkdown>{data.text}</ReactMarkdown>
            ) : (
              <span style={{ opacity: 0.45 }}>Double-click to edit</span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Floating widget above selected notes — transparency toggle + colour swatch.
// ---------------------------------------------------------------------------

function NoteToolbar({
  color,
  transparent,
  pickerOpen,
  onToggleTransparent,
  onTogglePicker,
  onClosePicker,
  onPickColor,
}: {
  color: string
  transparent: boolean
  pickerOpen: boolean
  onToggleTransparent: () => void
  onTogglePicker: () => void
  onClosePicker: () => void
  onPickColor: (hex: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Click outside the picker closes it. Toolbar swatch itself is excluded
  // (its own toggle handler manages open/close).
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClosePicker()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClosePicker()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen, onClosePicker])

  return (
    <div
      ref={ref}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: -2,
        left: '50%',
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 4,
        backgroundColor: 'var(--bg-card)',
        borderRadius: 999,
        boxShadow: 'var(--shadow-popover)',
        zIndex: 40,
      }}
    >
      <SwatchButton
        ariaLabel={transparent ? 'Use a solid colour' : 'Make transparent'}
        title={transparent ? 'Use a solid colour' : 'Make transparent'}
        onClick={onToggleTransparent}
        active={transparent}
      >
        <CheckerboardIcon />
      </SwatchButton>
      <SwatchButton
        ariaLabel="Pick a colour"
        title="Pick a colour"
        onClick={onTogglePicker}
        active={!transparent}
      >
        <span
          style={{
            display: 'inline-block',
            width: 18,
            height: 18,
            borderRadius: 999,
            backgroundColor: color,
            boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.15)',
          }}
        />
      </SwatchButton>

      {pickerOpen && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 180,
            backgroundColor: 'var(--bg-card)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-popover)',
            padding: 10,
            zIndex: 50,
          }}
        >
          <div className="palette-picker">
            <HexColorPicker color={color} onChange={onPickColor} />
          </div>
        </div>
      )}
    </div>
  )
}

function SwatchButton({
  children,
  active,
  ariaLabel,
  title,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  ariaLabel: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={ariaLabel}
      title={title}
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        background: 'transparent',
        border: 'none',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        outline: active ? '2px solid var(--accent)' : 'none',
        outlineOffset: 1,
      }}
    >
      {children}
    </button>
  )
}

// Small inline SVG — checkered pattern as the universal "transparent"
// indicator (image editors, file-format previews). Kept here so the
// component is self-contained; if more note-specific icons appear later
// they can move to a sibling icons module.
function CheckerboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 12 12" aria-hidden style={{ display: 'block' }}>
      <rect width="12" height="12" fill="var(--bg-elevated)" />
      <rect x="0" y="0" width="3" height="3" fill="var(--text-faint)" />
      <rect x="6" y="0" width="3" height="3" fill="var(--text-faint)" />
      <rect x="3" y="3" width="3" height="3" fill="var(--text-faint)" />
      <rect x="9" y="3" width="3" height="3" fill="var(--text-faint)" />
      <rect x="0" y="6" width="3" height="3" fill="var(--text-faint)" />
      <rect x="6" y="6" width="3" height="3" fill="var(--text-faint)" />
      <rect x="3" y="9" width="3" height="3" fill="var(--text-faint)" />
      <rect x="9" y="9" width="3" height="3" fill="var(--text-faint)" />
    </svg>
  )
}
