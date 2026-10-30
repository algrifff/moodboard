import {
  kitFromBrief,
  type CanvasObject,
  type KitSummary,
  type SynthesisBrief,
} from '@moodboard/shared'
import { ArrowSquareOut, Palette } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ghostButton, inputClass, primaryButton, selectClass } from '@/components/ui'
import { addKitVersion, createKit, listKits } from '@/lib/kitsApi'
import { useClients, useClientsStore } from '@/store/clients'

const NEW_KIT = ''

// "Save as style kit": distils the group's brief into kit tokens, as a new
// kit or a new version of an existing one for the chosen client.
export function SaveKitPanel({
  brief,
  items,
  clientId,
}: {
  brief: SynthesisBrief
  items: CanvasObject[]
  clientId: string | null
}) {
  const { clients } = useClients()
  const [open, setOpen] = useState(false)
  const [chosenClient, setChosenClient] = useState<string | null>(clientId)
  const [kits, setKits] = useState<KitSummary[]>([])
  const [target, setTarget] = useState(NEW_KIT)
  const [name, setName] = useState('')
  const [newClientName, setNewClientName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ kitId: string; version: number; name: string } | null>(null)

  const tokens = useMemo(
    () =>
      kitFromBrief(brief, {
        uploadedFonts: items.flatMap((o) => {
          if (o.type !== 'font') return []
          const d = o.data as { family?: string; url?: string }
          return d.family && d.url ? [{ family: d.family, url: d.url }] : []
        }),
      }),
    [brief, items],
  )

  const client = clients.find((c) => c.id === chosenClient) ?? null

  useEffect(() => {
    if (open && !chosenClient) setChosenClient(clientId ?? clients[0]?.id ?? null)
  }, [open, chosenClient, clientId, clients])

  useEffect(() => {
    if (!open || !chosenClient) {
      setKits([])
      return
    }
    let cancelled = false
    listKits(chosenClient)
      .then((k) => {
        if (cancelled) return
        setKits(k)
        setTarget(NEW_KIT)
      })
      .catch(() => !cancelled && setKits([]))
    return () => {
      cancelled = true
    }
  }, [open, chosenClient])

  useEffect(() => {
    if (client && !name) setName(`${client.name} kit`)
  }, [client, name])

  const summary = [
    `${tokens.palette.length} colour${tokens.palette.length === 1 ? '' : 's'}`,
    `${[tokens.fonts.display, tokens.fonts.body, tokens.fonts.mono].filter(Boolean).length} fonts`,
    `${tokens.logos.length} logo${tokens.logos.length === 1 ? '' : 's'}`,
    `${tokens.voice.tone.length + tokens.voice.donts.length} voice lines`,
  ].join(' · ')

  const createClientInline = async () => {
    const trimmed = newClientName.trim()
    if (!trimmed) return
    try {
      const created = await useClientsStore.getState().create(trimmed)
      setChosenClient(created.id)
      setName(`${created.name} kit`)
      setNewClientName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const save = async () => {
    if (!chosenClient) return
    setSaving(true)
    setError(null)
    try {
      if (target === NEW_KIT) {
        const kit = await createKit({
          clientId: chosenClient,
          name: name.trim(),
          tokens,
          note: 'From a group brief',
        })
        setSaved({ kitId: kit.id, version: 1, name: kit.name })
      } else {
        const detail = await addKitVersion(target, { tokens, note: 'From a group brief' })
        setSaved({ kitId: target, version: detail.version.version, name: detail.kit.name })
      }
      void useClientsStore.getState().load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setSaved(null)
          setOpen(true)
        }}
        className={`${ghostButton} -ml-2.5 text-[12.5px]`}
      >
        <Palette size={14} />
        Save as style kit
      </button>
    )
  }

  return (
    <div
      className="flex flex-col gap-2.5 p-3"
      style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <Palette size={14} className="text-[var(--accent)]" />
          Save as style kit
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[12px] text-[var(--text-mute)] hover:text-foreground"
        >
          Close
        </button>
      </div>

      {saved ? (
        <div className="flex flex-col gap-2 text-[12.5px] text-[var(--text-soft)]">
          <p>
            Saved “{saved.name}” as version {saved.version}.
          </p>
          <a
            href={`/kits/${saved.kitId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-[var(--accent)] hover:brightness-110"
          >
            <ArrowSquareOut size={13} weight="bold" />
            Open the kit
          </a>
        </div>
      ) : (
        <>
          <p className="text-[12px] text-[var(--text-mute)]">{summary}</p>

          {clients.length === 0 ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void createClientInline()
              }}
            >
              <input
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder="Name the client this is for"
                aria-label="New client name"
                className={inputClass}
              />
              <button type="submit" className={primaryButton} disabled={!newClientName.trim()}>
                Add
              </button>
            </form>
          ) : (
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--text-mute)]">Client</span>
              <ClientSelect
                clients={clients}
                value={chosenClient}
                allowNone={false}
                onChange={(id) => {
                  setChosenClient(id)
                  setName('')
                }}
                label="Client for the kit"
                className="w-full"
              />
            </label>
          )}

          {chosenClient && (
            <>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--text-mute)]">Save as</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-label="Kit to save into"
                  className={selectClass}
                >
                  <option value={NEW_KIT}>A new kit</option>
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>
                      New version of “{k.name}” (v{k.latestVersion})
                    </option>
                  ))}
                </select>
              </label>
              {target === NEW_KIT && (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="Kit name"
                  aria-label="Kit name"
                  className={inputClass}
                />
              )}
              <button
                type="button"
                className={primaryButton}
                disabled={saving || (target === NEW_KIT && !name.trim())}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : target === NEW_KIT ? 'Create kit' : 'Save version'}
              </button>
            </>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </>
      )}
    </div>
  )
}
