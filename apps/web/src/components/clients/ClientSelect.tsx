import type { Client } from '@moodboard/shared'
import { CaretDown } from '@phosphor-icons/react'
import { selectClass } from '@/components/ui'

// A native select over the team's clients. `null` is "no client" and is
// only offered when `allowNone` is set.
export function ClientSelect({
  clients,
  value,
  onChange,
  allowNone = true,
  noneLabel = 'No client',
  className = '',
  label,
}: {
  clients: Client[]
  value: string | null
  onChange: (clientId: string | null) => void
  allowNone?: boolean
  noneLabel?: string
  className?: string
  label: string
}) {
  return (
    <span className={`relative inline-block ${className}`}>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={selectClass}
      >
        {allowNone && <option value="">{noneLabel}</option>}
        {!allowNone && value === null && (
          <option value="" disabled>
            Choose a client…
          </option>
        )}
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <CaretDown
        size={11}
        weight="bold"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-mute)]"
      />
    </span>
  )
}
