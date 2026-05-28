import type { CanvasObject, TextData } from '@moodboard/shared'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { useFitText } from '@/hooks/useFitText'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'

export function TextObject({
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
  const data = object.data as TextData
  const [editing, setEditing] = useState(() => data.text === '')
  const [isEmpty, setIsEmpty] = useState(data.text === '')
  const textRef = useRef<HTMLDivElement>(null)
  const updateObject = useCanvasStore((s) => s.updateObject)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing,
    minWidth: 60,
    minHeight: 32,
    haloPx: HALO,
  })

  const refit = useFitText(textRef, {
    width: object.size.width,
    height: object.size.height,
    min: 12,
    max: 64,
  })

  useEffect(() => {
    if (!editing && textRef.current && textRef.current.innerText !== data.text) {
      textRef.current.innerText = data.text
      setIsEmpty(data.text === '')
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
        fontFamily: data.font,
        lineHeight: 1.25,
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          padding: '6px 8px',
          borderRadius: 4,
          boxSizing: 'border-box',
          overflow: 'hidden',
          outline:
            selected || interaction.nearEdge
              ? '2px solid #7B5CFF'
              : interaction.hovering || editing
                ? '1.5px dashed rgba(123, 92, 255, 0.55)'
                : 'none',
          outlineOffset: selected || interaction.nearEdge ? 3 : 2,
        }}
      >
        <div
          ref={textRef}
          contentEditable={editing}
          suppressContentEditableWarning
          onInput={(e) => {
            setIsEmpty(e.currentTarget.innerText.length === 0)
            refit()
          }}
          onBlur={commit}
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
        {isEmpty && !editing && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: 8,
              color: 'var(--text-faint)',
              pointerEvents: 'none',
              fontSize: 18,
            }}
          >
            Text
          </div>
        )}
      </div>
    </motion.div>
  )
}
