import { Check, Pencil, Plus, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ghostButton, inputClass, primaryButton } from '@/components/ui'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { useClientsStore, useClients } from '@/store/clients'

// Create, rename and delete clients. Everyone on the team sees the same
// list; deleting one detaches its boards and assets and removes its kits.
export function ClientManagerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated?: (clientId: string) => void
}) {
  return createPortal(
    <AnimatePresence>{open && <Dialog onClose={onClose} onCreated={onCreated} />}</AnimatePresence>,
    document.body,
  )
}

function Dialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated?: (clientId: string) => void
}) {
  const { clients } = useClients()
  const store = useClientsStore
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      const trimmed = name.trim()
      if (!trimmed) return
      await store.getState().create(trimmed)
      setName('')
    })

  const saveRename = (id: string) =>
    run(async () => {
      const trimmed = editName.trim()
      if (trimmed) await store.getState().rename(id, trimmed)
      setEditingId(null)
    })

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh]"
      style={{ backgroundColor: 'var(--scrim)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: [...EASE_OUT_STANDARD] }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <motion.div
        role="dialog"
        aria-label="Clients"
        className="w-full max-w-md bg-card p-5"
        style={{ borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)' }}
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 8, opacity: 0 }}
        transition={{ duration: 0.2, ease: [...EASE_OUT_STANDARD] }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Clients</h2>
          <button type="button" onClick={onClose} className={ghostButton} aria-label="Close">
            <X size={14} weight="bold" />
          </button>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New client name"
            maxLength={80}
            className={inputClass}
            aria-label="New client name"
          />
          <button type="submit" disabled={busy || !name.trim()} className={primaryButton}>
            <Plus size={13} weight="bold" />
            Add
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <ul className="mt-4 max-h-[44vh] divide-y divide-[var(--border-soft)] overflow-y-auto">
          {clients.length === 0 && (
            <li className="py-3 text-sm text-muted-foreground">
              No clients yet. Boards, kits and library assets can each belong to one.
            </li>
          )}
          {clients.map((c) => (
            <li key={c.id} className="group flex items-center gap-2 py-2">
              {editingId === c.id ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename(c.id)
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEditingId(null)
                      }
                    }}
                    className={inputClass}
                    aria-label={`Rename ${c.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => void saveRename(c.id)}
                    className={ghostButton}
                    aria-label="Save name"
                  >
                    <Check size={14} weight="bold" />
                  </button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{c.name}</div>
                    <div className="text-micro text-[var(--text-faint)]">
                      {c.boardCount} board{c.boardCount === 1 ? '' : 's'} · {c.kitCount} kit
                      {c.kitCount === 1 ? '' : 's'} · /{c.slug}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(c.id)
                      setEditName(c.name)
                    }}
                    className={`${ghostButton} opacity-0 focus:opacity-100 group-hover:opacity-100`}
                    aria-label={`Rename ${c.name}`}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const kits = c.kitCount
                      const msg = `Delete ${c.name}? Its boards and assets stay, unassigned.${
                        kits > 0
                          ? ` Its ${kits} style kit${kits === 1 ? '' : 's'} will be deleted.`
                          : ''
                      }`
                      if (confirm(msg)) void run(() => store.getState().remove(c.id))
                    }}
                    className={`${ghostButton} opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100`}
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash size={13} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </motion.div>
    </motion.div>
  )
}
