import type { CanvasObject, StickyData } from '@moodboard/shared'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { useFitText } from '@/hooks/useFitText'
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
    min: 14,
    max: 96,
  })

  useEffect(() => {
    if (!editing && textRef.current && textRef.current.innerText !== data.text) {
      textRef.current.innerText = data.text
      refit()
    }
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
        // Snapshot pre-edit state so the whole edit session is one undo step.
        useCanvasStore.getState().commitBeforeAction()
        updateObject(object.id, { data: { ...data, text: next } })
      }
    }
    setEditing(false)
  }

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
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: data.color,
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
          borderRadius: 8,
          padding: '14px 16px',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto',
          lineHeight: 1.2,
          color: '#0f172a',
          overflow: 'hidden',
          boxSizing: 'border-box',
          outline: selected || interaction.nearEdge ? '2px solid #7B5CFF' : 'none',
          outlineOffset: 3,
        }}
      >
        <div
          ref={textRef}
          contentEditable={editing}
          suppressContentEditableWarning
          onBlur={commit}
          onInput={refit}
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
      </div>
    </motion.div>
  )
}
