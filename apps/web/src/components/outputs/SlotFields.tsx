import type { OutputSlot } from '@moodboard/shared'
import { ArrowCounterClockwise, ImageSquare } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { ghostButton, labelClass } from '@/components/ui'

// The output's slots as fields. Text commits on blur (or ⌘/Ctrl+Enter) and
// each commit is a new version; null resets a slot to its template default.

export function SlotFields({
  slots,
  disabled,
  focused,
  onCommit,
  onPickImage,
}: {
  slots: OutputSlot[]
  disabled: boolean
  focused: string | null
  onCommit: (name: string, value: string | null) => void
  onPickImage: (slot: OutputSlot) => void
}) {
  if (slots.length === 0) {
    return (
      <p className="px-1 text-[12.5px] text-[var(--text-mute)]">
        This output has no slots. Its HTML can still be edited by an agent.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-3">
      {slots.map((slot) => (
        <li key={slot.name}>
          {slot.kind === 'image' ? (
            <ImageField
              slot={slot}
              disabled={disabled}
              focused={focused === slot.name}
              onPick={() => onPickImage(slot)}
              onReset={() => onCommit(slot.name, null)}
            />
          ) : (
            <TextField
              slot={slot}
              disabled={disabled}
              focused={focused === slot.name}
              onCommit={(value) => onCommit(slot.name, value)}
              onReset={() => onCommit(slot.name, null)}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

function FieldHead({
  slot,
  onReset,
  disabled,
}: {
  slot: OutputSlot
  onReset: () => void
  disabled: boolean
}) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className={labelClass}>{slot.label}</span>
      <span className="font-mono text-[10.5px] text-[var(--text-faint)]">{slot.name}</span>
      <div className="flex-1" />
      {slot.value !== null && !disabled && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-mute)] transition-colors hover:text-foreground"
          title="Back to the template’s default"
        >
          <ArrowCounterClockwise size={11} />
          Default
        </button>
      )}
    </div>
  )
}

function useFocusFlash(focused: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused])
  return ref
}

function TextField({
  slot,
  disabled,
  focused,
  onCommit,
  onReset,
}: {
  slot: OutputSlot
  disabled: boolean
  focused: boolean
  onCommit: (value: string) => void
  onReset: () => void
}) {
  const effective = slot.value ?? slot.defaultValue
  const [draft, setDraft] = useState(effective)
  const ref = useFocusFlash(focused)
  useEffect(() => setDraft(effective), [effective])

  const commit = () => {
    if (draft !== effective) onCommit(draft)
  }
  const rows = Math.min(8, Math.max(1, Math.ceil(draft.length / 38) + draft.split('\n').length - 1))

  return (
    <div ref={ref}>
      <FieldHead slot={slot} disabled={disabled} onReset={onReset} />
      <textarea
        value={draft}
        disabled={disabled}
        rows={rows}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setDraft(effective)
        }}
        maxLength={2000}
        aria-label={slot.label}
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-[13px] leading-snug text-foreground outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] disabled:opacity-60"
        style={focused ? { borderColor: 'var(--accent)' } : undefined}
      />
    </div>
  )
}

function ImageField({
  slot,
  disabled,
  focused,
  onPick,
  onReset,
}: {
  slot: OutputSlot
  disabled: boolean
  focused: boolean
  onPick: () => void
  onReset: () => void
}) {
  const ref = useFocusFlash(focused)
  const url = slot.value ?? slot.defaultValue
  const showsImage = url.startsWith('/api/files/')
  return (
    <div ref={ref}>
      <FieldHead slot={slot} disabled={disabled} onReset={onReset} />
      <div
        className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2"
        style={focused ? { borderColor: 'var(--accent)' } : undefined}
      >
        <div
          className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden bg-[var(--bg-elevated)]"
          style={{ borderRadius: 'var(--radius)' }}
        >
          {showsImage ? (
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageSquare size={20} className="text-[var(--text-faint)]" />
          )}
        </div>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-mute)]">
          {slot.value ? 'From the library' : 'Template artwork'}
        </span>
        <button type="button" className={ghostButton} disabled={disabled} onClick={onPick}>
          Choose…
        </button>
      </div>
    </div>
  )
}
