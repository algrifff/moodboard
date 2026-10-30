import type { Client } from '@moodboard/shared'
import { Plus, SlidersHorizontal } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ClientFilter } from '@/lib/clientFilter'
import { ClientManagerDialog } from './ClientManagerDialog'

const chip = (active: boolean) =>
  `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors ${
    active
      ? 'bg-[var(--accent-soft)] text-foreground shadow-[inset_0_0_0_1px_var(--accent)]'
      : 'bg-card text-[var(--text-soft)] hover:bg-[var(--bg-elevated)] hover:text-foreground'
  }`

// "All · Unassigned · each client" as a row of chips, with a way to add and
// manage clients. `counts` shows how many items each choice holds.
export function ClientSwitcher({
  clients,
  filter,
  onChange,
  allowNone,
  counts,
}: {
  clients: Client[]
  filter: ClientFilter
  onChange: (next: ClientFilter) => void
  allowNone: boolean
  counts?: { all: number; none: number; byClient: (c: Client) => number }
}) {
  const [managing, setManaging] = useState(false)
  const count = (n: number | undefined) =>
    n === undefined ? null : <span className="text-micro text-[var(--text-faint)]">{n}</span>

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by client">
      <button
        type="button"
        className={chip(filter.kind === 'all')}
        onClick={() => onChange({ kind: 'all' })}
        aria-pressed={filter.kind === 'all'}
      >
        All {count(counts?.all)}
      </button>
      {clients.map((c) => (
        <button
          key={c.id}
          type="button"
          className={chip(filter.kind === 'client' && filter.slug === c.slug)}
          onClick={() => onChange({ kind: 'client', slug: c.slug })}
          aria-pressed={filter.kind === 'client' && filter.slug === c.slug}
        >
          {c.name} {count(counts?.byClient(c))}
        </button>
      ))}
      {allowNone && (
        <button
          type="button"
          className={chip(filter.kind === 'none')}
          onClick={() => onChange({ kind: 'none' })}
          aria-pressed={filter.kind === 'none'}
        >
          Unassigned {count(counts?.none)}
        </button>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-[var(--text-mute)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-foreground"
        onClick={() => setManaging(true)}
        title={clients.length === 0 ? 'Add a client' : 'Add, rename or delete clients'}
      >
        {clients.length === 0 ? (
          <>
            <Plus size={13} weight="bold" /> Add a client
          </>
        ) : (
          <>
            <SlidersHorizontal size={13} /> Manage
          </>
        )}
      </button>
      <ClientManagerDialog open={managing} onClose={() => setManaging(false)} />
    </div>
  )
}
