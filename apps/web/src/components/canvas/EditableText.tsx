import { useLayoutEffect, useRef, useState, type CSSProperties, type ElementType } from 'react'

// Inline-editable text. Single-click enters edit mode (contentEditable);
// Enter or blur commits; Escape cancels. Multi-line bodies skip the
// Enter-commits-on-press behaviour.
//
// View vs edit are rendered as two different JSX branches, so React
// owns the children in view mode (no innerText hacks). When the user
// enters edit mode, a fresh contentEditable element mounts and
// useLayoutEffect seeds it with the current value + selects all,
// before the browser paints — so the cursor lands at the right place
// without a flash of empty.
export function EditableText({
  value,
  onCommit,
  multiline = false,
  className,
  style,
  as = 'div',
  title = 'Click to edit',
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
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLElement>(null)

  // When entering edit mode: write the current value into the freshly-
  // mounted contentEditable, focus, and select all. useLayoutEffect
  // runs before paint so the user never sees the pre-seeded empty box.
  useLayoutEffect(() => {
    if (editing && ref.current) {
      ref.current.innerText = value
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    // Intentionally only on edit transitions — during editing the
    // DOM is the source of truth and we don't want to yank the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const commit = () => {
    if (!ref.current) return
    const next = ref.current.innerText.trim()
    if (next !== value) onCommit(next)
    setEditing(false)
  }

  const cancel = () => setEditing(false)

  const Tag = as

  if (editing) {
    return (
      <Tag
        ref={ref}
        contentEditable
        suppressContentEditableWarning
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
        onPointerDown={(e: React.PointerEvent) => {
          // Don't bubble drag/click events to the panel or canvas
          // while typing — the drawer scrim close handler and the
          // resize handle would otherwise interfere.
          e.stopPropagation()
        }}
        style={{
          outline: '1.5px solid var(--accent)',
          outlineOffset: 2,
          borderRadius: 2,
          cursor: 'text',
          whiteSpace: multiline ? 'pre-wrap' : 'normal',
          minWidth: 12,
          minHeight: '1em',
          ...style,
        }}
        className={className}
      />
    )
  }

  // View mode — React-owned children, click to edit.
  return (
    <Tag
      onClick={(e: React.MouseEvent) => {
        // Don't bubble — clicking the throughline text shouldn't trigger
        // the LogoBlock picker or the drawer scrim close.
        e.stopPropagation()
        setEditing(true)
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // Subtle hover hint so the user sees this is editable — tinted
        // accent fill that matches the brief's accent identity.
        backgroundColor: hover ? 'var(--accent-fade)' : 'transparent',
        transition: 'background-color 120ms',
        cursor: 'text',
        borderRadius: 2,
        whiteSpace: multiline ? 'pre-wrap' : 'normal',
        minHeight: '1em',
        ...style,
      }}
      className={className}
      title={title}
    >
      {value.length > 0 ? (
        value
      ) : (
        <span style={{ opacity: 0.4, fontStyle: 'italic' }}>Click to add</span>
      )}
    </Tag>
  )
}
