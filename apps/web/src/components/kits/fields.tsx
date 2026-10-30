import { Plus, Trash, UploadSimple } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { ghostButton, inputClass, labelClass } from '@/components/ui'

// Small inputs the kit editor is built from.

export function SectionCard({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-card p-5" style={{ borderRadius: 'var(--radius-lg)' }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-[var(--text-mute)]">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className={`${labelClass} mb-1`}>{children}</div>
}

// A list of short strings edited as one per line. The text is held locally
// while typing (so a trailing newline survives) and only re-read from the
// value when `resetKey` changes — i.e. a different version was loaded.
export function LinesField({
  label,
  hint,
  value,
  onChange,
  resetKey,
  rows = 3,
  disabled,
}: {
  label: string
  hint?: string
  value: string[]
  onChange: (lines: string[]) => void
  resetKey: string | number
  rows?: number
  disabled?: boolean
}) {
  const [text, setText] = useState(value.join('\n'))
  useEffect(() => setText(value.join('\n')), [resetKey])
  return (
    <label className="block">
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={text}
        rows={rows}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value)
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
          )
        }}
        className={`${inputClass} resize-y leading-relaxed`}
      />
      {hint && <span className="mt-1 block text-micro text-[var(--text-faint)]">{hint}</span>}
    </label>
  )
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function HexField({
  value,
  onCommit,
  disabled,
}: {
  value: string
  onCommit: (hex: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const valid = HEX.test(text)
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value.toLowerCase()}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value.toUpperCase())}
        className="h-8 w-8 shrink-0 cursor-pointer border-0 bg-transparent p-0"
        style={{
          boxShadow: 'var(--shadow-small), var(--swatch-inset)',
          borderRadius: 'var(--radius)',
        }}
        aria-label="Pick colour"
      />
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value)
          if (HEX.test(e.target.value)) onCommit(e.target.value.toUpperCase())
        }}
        spellCheck={false}
        maxLength={7}
        aria-label="Hex colour"
        aria-invalid={!valid}
        className={`${inputClass} !w-[88px] font-mono ${valid ? '' : 'border-[var(--danger)]'}`}
      />
    </div>
  )
}

export function UploadButton({
  accept,
  label,
  onFile,
  disabled,
}: {
  accept: string
  label: string
  onFile: (file: File) => Promise<void>
  disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setBusy(true)
          try {
            await onFile(file)
          } finally {
            setBusy(false)
          }
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => ref.current?.click()}
        className={ghostButton}
      >
        <UploadSimple size={13} />
        {busy ? 'Uploading…' : label}
      </button>
    </>
  )
}

export function AddButton({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={ghostButton}>
      <Plus size={13} weight="bold" />
      {children}
    </button>
  )
}

export function RemoveButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`${ghostButton} hover:text-destructive`}
    >
      <Trash size={13} />
    </button>
  )
}
