import { useEffect, useRef, useState, type CSSProperties, type ElementType } from 'react'

// Inline-editable text. Double-click enters edit mode (contentEditable);
// Enter or blur commits; Escape cancels. Empty/whitespace-only values
// commit as empty string — caller can ignore or react. Tag is configurable
// so the same component works for block-level fields (div, p) and inline
// fields embedded inside a sentence or chip (span).
//
// The component manages its own innerText via a ref to avoid React
// re-rendering contentEditable contents under the cursor (which would
// reset selection); it only sync-writes innerText when the external
// `value` changes and the user isn't actively editing.
export function EditableText({
  value,
  onCommit,
  multiline = false,
  className,
  style,
  as = 'div',
  title = 'Double-click to edit',
}: {
  value: string
  onCommit: (next: string) => void
  multiline?: boolean
  className?: string
  style?: CSSProperties
  as?: ElementType
  title?: string
}) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLElement>(null)

  // Keep innerText in sync with the external value when the user isn't
  // editing. While editing, we don't touch innerText — that would yank
  // the cursor out.
  useEffect(() => {
    if (!editing && ref.current && ref.current.innerText !== value) {
      ref.current.innerText = value
    }
  }, [value, editing])

  // On entering edit: focus + select all so a quick "double-click → type"
  // replaces the value, not appends to it.
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [editing])

  const commit = () => {
    if (!ref.current) return
    const next = ref.current.innerText.trim()
    if (next !== value) onCommit(next)
    setEditing(false)
  }

  const cancel = () => {
    // Restore visible text to the prop value, drop unsaved edits.
    if (ref.current) ref.current.innerText = value
    setEditing(false)
  }

  const Tag = as

  return (
    <Tag
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        e.preventDefault()
        setEditing(true)
      }}
      onBlur={commit}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        } else if (e.key === 'Enter' && !multiline) {
          e.preventDefault()
          commit()
        }
      }}
      // Stop pointer-down so dragging inside text doesn't pull the
      // surrounding panel/canvas drag handlers.
      onPointerDown={(e: React.PointerEvent) => {
        if (editing) e.stopPropagation()
      }}
      style={{
        outline: editing ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        borderRadius: 2,
        cursor: editing ? 'text' : 'pointer',
        whiteSpace: multiline ? 'pre-wrap' : 'normal',
        ...style,
      }}
      className={className}
      title={editing ? undefined : title}
    />
  )
}
