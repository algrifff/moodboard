import {
  OUTPUT_FORMAT_LABELS,
  viewportSize,
  type KitSummary,
  type TemplateSummary,
} from '@moodboard/shared'
import { CaretDown } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { inputClass, labelClass, primaryButton, selectClass } from '@/components/ui'
import { listKits } from '@/lib/kitsApi'
import { createOutput, listTemplates, templateRenderUrl } from '@/lib/outputsApi'
import { useClients } from '@/store/clients'
import { Modal } from './Modal'
import { OutputFrame } from './OutputFrame'

// New output: client → kit → template. Every template previews live with
// the chosen kit, so the pick is made on the real thing.
export function NewOutputDialog({
  open,
  onClose,
  initialClientId,
  initialTemplateId,
}: {
  open: boolean
  onClose: () => void
  initialClientId: string | null
  initialTemplateId?: string | null
}) {
  return (
    <Modal open={open} onClose={onClose} title="New output" width="max-w-5xl">
      <Form
        onClose={onClose}
        initialClientId={initialClientId}
        initialTemplateId={initialTemplateId ?? null}
      />
    </Modal>
  )
}

function Form({
  onClose,
  initialClientId,
  initialTemplateId,
}: {
  onClose: () => void
  initialClientId: string | null
  initialTemplateId: string | null
}) {
  const navigate = useNavigate()
  const { clients } = useClients()
  const [clientId, setClientId] = useState<string | null>(initialClientId)
  const [kits, setKits] = useState<KitSummary[]>([])
  const [kitId, setKitId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(initialTemplateId)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listTemplates(clientId ? { client: clientId } : {})
      .then((list) => {
        setTemplates(list)
        setTemplateId((current) =>
          current && list.some((t) => t.id === current) ? current : (list[0]?.id ?? null),
        )
      })
      .catch((e: Error) => setError(e.message))
  }, [clientId])

  useEffect(() => {
    if (!clientId) {
      setKits([])
      setKitId(null)
      return
    }
    listKits(clientId)
      .then((list) => {
        setKits(list)
        setKitId(list[0]?.id ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [clientId])

  const template = templates?.find((t) => t.id === templateId) ?? null

  const submit = async () => {
    if (!template) return
    setBusy(true)
    setError(null)
    try {
      const output = await createOutput({
        templateId: template.id,
        clientId,
        kitId,
        name: name.trim() || undefined,
      })
      onClose()
      navigate(`/outputs/${output.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className={`${labelClass} mb-1 block`}>Client</span>
          <ClientSelect
            clients={clients}
            value={clientId}
            onChange={setClientId}
            label="Client"
            className="w-full"
          />
        </label>
        <label className="block">
          <span className={`${labelClass} mb-1 block`}>Style kit</span>
          <KitSelect kits={kits} value={kitId} onChange={setKitId} />
          {clientId && kits.length === 0 && (
            <span className="mt-1 block text-xs text-[var(--text-faint)]">
              This client has no kits yet — the house style is used.
            </span>
          )}
        </label>
        <label className="block">
          <span className={`${labelClass} mb-1 block`}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={template?.name ?? 'Untitled'}
            maxLength={120}
            className={inputClass}
          />
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" className={primaryButton} disabled={!template || busy}>
          {busy ? 'Creating…' : 'Create output'}
        </button>
      </div>

      <div>
        <span className={`${labelClass} mb-2 block`}>Template</span>
        {templates === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul
            className="grid max-h-[62vh] grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3"
            role="radiogroup"
            aria-label="Template"
          >
            {templates.map((t) => (
              <li key={t.id}>
                <TemplateTile
                  template={t}
                  kitId={kitId}
                  selected={t.id === templateId}
                  onSelect={() => setTemplateId(t.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  )
}

export function KitSelect({
  kits,
  value,
  onChange,
  pinnedVersion,
}: {
  kits: KitSummary[]
  value: string | null
  onChange: (kitId: string | null) => void
  pinnedVersion?: number | null
}) {
  return (
    <span className="relative block">
      <select
        aria-label="Style kit"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={selectClass}
      >
        <option value="">House style (no kit)</option>
        {kits.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.id === value && pinnedVersion ? ` · v${pinnedVersion}` : ''}
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

export function TemplateTile({
  template,
  kitId,
  selected,
  onSelect,
}: {
  template: TemplateSummary
  kitId: string | null
  selected: boolean
  onSelect: () => void
}) {
  const size = viewportSize(template.viewport)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="block w-full p-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: selected
          ? 'inset 0 0 0 2px var(--accent)'
          : 'inset 0 0 0 1px var(--border-soft)',
      }}
    >
      <OutputFrame
        src={templateRenderUrl(template.id, kitId)}
        viewport={template.viewport}
        title={template.name}
        className="aspect-[4/3] w-full bg-[var(--bg-muted)]"
        shadow={false}
      />
      <span className="mt-2 block truncate text-sm font-medium text-foreground">
        {template.name}
      </span>
      <span className="block truncate text-xs text-[var(--text-mute)]">
        {OUTPUT_FORMAT_LABELS[template.format]} ·{' '}
        {template.viewport.kind === 'fixed' ? `${size.width}×${size.height}` : 'Responsive'}
        {template.clientName ? ` · ${template.clientName}` : ''}
      </span>
    </button>
  )
}
