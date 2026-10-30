import type { KitSummary } from '@moodboard/shared'
import { Plus } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppHeader } from '@/components/AppHeader'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ClientSwitcher } from '@/components/clients/ClientSwitcher'
import { inputClass, primaryButton, relativeTime } from '@/components/ui'
import { resolveClientFilter, useClientFilter } from '@/lib/clientFilter'
import { createKit, listKits } from '@/lib/kitsApi'
import { useClients } from '@/store/clients'

export function KitsPage() {
  const navigate = useNavigate()
  const { clients, loaded } = useClients()
  const [filter, setFilter] = useClientFilter({ allowNone: false })
  const activeClient = resolveClientFilter(filter, clients)
  const [kits, setKits] = useState<KitSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newClientId, setNewClientId] = useState<string | null>(null)

  useEffect(() => {
    listKits()
      .then(setKits)
      .catch((e: Error) => setError(e.message))
  }, [])

  const visible = useMemo(
    () =>
      kits ? (activeClient ? kits.filter((k) => k.clientId === activeClient.id) : kits) : null,
    [kits, activeClient],
  )

  const startCreate = () => {
    setNewClientId(activeClient?.id ?? clients[0]?.id ?? null)
    setNewName('')
    setCreating(true)
  }

  const submit = async () => {
    if (!newClientId || !newName.trim()) return
    try {
      const kit = await createKit({ clientId: newClientId, name: newName.trim() })
      navigate(`/kits/${kit.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-16 pt-6">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {activeClient ? `${activeClient.name} kits` : 'Style kits'}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Palette, fonts, logos and voice, versioned. Save one from a group’s brief on a board.
            </p>
          </div>
          <button
            type="button"
            className={primaryButton}
            onClick={startCreate}
            disabled={loaded && clients.length === 0}
            title={loaded && clients.length === 0 ? 'Add a client first' : undefined}
          >
            <Plus size={14} weight="bold" />
            New kit
          </button>
        </div>

        {loaded && (
          <div className="mb-6">
            <ClientSwitcher
              clients={clients}
              filter={activeClient ? filter : { kind: 'all' }}
              onChange={setFilter}
              allowNone={false}
              counts={
                kits
                  ? {
                      all: kits.length,
                      none: 0,
                      byClient: (c) => kits.filter((k) => k.clientId === c.id).length,
                    }
                  : undefined
              }
            />
          </div>
        )}

        {creating && (
          <form
            className="mb-6 flex flex-wrap items-end gap-3 bg-card p-4"
            style={{ borderRadius: 'var(--radius-lg)' }}
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <label className="min-w-[200px] flex-1">
              <span className="mb-1 block text-micro uppercase tracking-[0.12em] text-[var(--text-mute)]">
                Name
              </span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
                placeholder="Brand kit"
                className={inputClass}
              />
            </label>
            <div className="w-52">
              <span className="mb-1 block text-micro uppercase tracking-[0.12em] text-[var(--text-mute)]">
                Client
              </span>
              <ClientSelect
                clients={clients}
                value={newClientId}
                allowNone={false}
                onChange={setNewClientId}
                label="Client for the new kit"
                className="w-full"
              />
            </div>
            <button
              type="submit"
              className={primaryButton}
              disabled={!newName.trim() || !newClientId}
            >
              Create
            </button>
            <button
              type="button"
              className="px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </form>
        )}

        {error && <p className="mb-4 text-sm text-destructive">Error: {error}</p>}
        {visible === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {visible && visible.length === 0 && (
          <div
            className="bg-card px-6 py-14 text-center"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <h3 className="text-base font-semibold text-foreground">
              {activeClient ? `No kits for ${activeClient.name} yet` : 'No style kits yet'}
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Group the references for a brand on a board, run a brief, then use “Save as style kit”
              in the sidebar. Or start an empty kit and fill it in.
            </p>
          </div>
        )}
        {visible && visible.length > 0 && (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((k) => (
              <li key={k.id}>
                <Link
                  to={`/kits/${k.id}`}
                  className="block bg-card p-4 transition-colors hover:bg-[var(--bg-elevated)]"
                  style={{ borderRadius: 'var(--radius-lg)' }}
                >
                  <div
                    className="mb-3 flex h-12 overflow-hidden"
                    style={{ borderRadius: 'var(--radius)' }}
                  >
                    {k.preview.palette.length === 0 ? (
                      <div className="flex-1 bg-[var(--bg-muted)]" />
                    ) : (
                      k.preview.palette.map((hex, i) => (
                        <div
                          key={`${hex}-${i}`}
                          className="flex-1"
                          style={{ backgroundColor: hex }}
                        />
                      ))
                    )}
                  </div>
                  <p className="truncate text-sm font-medium text-foreground">{k.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {k.clientName} · v{k.latestVersion} · {relativeTime(k.updatedAt)}
                  </p>
                  {(k.preview.display || k.preview.body) && (
                    <p className="mt-1 truncate text-xs text-[var(--text-faint)]">
                      {[k.preview.display, k.preview.body].filter(Boolean).join(' / ')}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
