import {
  OUTPUT_FORMAT_LABELS,
  outputRenderPath,
  type OutputSummary,
  type TemplateSummary,
} from '@moodboard/shared'
import { Plus, Trash } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AppHeader } from '@/components/AppHeader'
import { ClientSwitcher } from '@/components/clients/ClientSwitcher'
import { NewOutputDialog, TemplateTile } from '@/components/outputs/NewOutputDialog'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { ghostButton, primaryButton, relativeTime } from '@/components/ui'
import { resolveClientFilter, useClientFilter } from '@/lib/clientFilter'
import { deleteTemplate, listOutputs, listTemplates } from '@/lib/outputsApi'
import { useClients } from '@/store/clients'

// Every design output the team has made, filterable by client, plus the
// templates they start from.
export function OutputsPage() {
  const { clients, loaded } = useClients()
  const [filter, setFilter] = useClientFilter({ allowNone: true })
  const activeClient = resolveClientFilter(filter, clients)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'templates' ? 'templates' : 'outputs'
  const [outputs, setOutputs] = useState<OutputSummary[] | null>(null)
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ templateId: string | null } | null>(null)

  useEffect(() => {
    listOutputs()
      .then(setOutputs)
      .catch((e: Error) => setError(e.message))
    listTemplates()
      .then(setTemplates)
      .catch((e: Error) => setError(e.message))
  }, [])

  const visible = useMemo(() => {
    if (!outputs) return null
    if (filter.kind === 'none') return outputs.filter((o) => o.clientId === null)
    return activeClient ? outputs.filter((o) => o.clientId === activeClient.id) : outputs
  }, [outputs, filter.kind, activeClient])

  const visibleTemplates = useMemo(
    () =>
      templates && activeClient
        ? templates.filter((t) => t.clientId === null || t.clientId === activeClient.id)
        : templates,
    [templates, activeClient],
  )

  const setTab = (next: 'outputs' | 'templates') =>
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        if (next === 'templates') copy.set('tab', 'templates')
        else copy.delete('tab')
        return copy
      },
      { replace: true },
    )

  return (
    <div className="min-h-screen bg-background">
      <AppHeader wide />
      <main className="mx-auto max-w-6xl px-6 pb-16 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {activeClient ? `${activeClient.name} outputs` : 'Outputs'}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Thumbnails, posts, decks, landing pages and one-pagers — HTML, skinned by a style kit.
            </p>
          </div>
          <button
            type="button"
            className={primaryButton}
            onClick={() => setCreating({ templateId: null })}
          >
            <Plus size={14} weight="bold" />
            New output
          </button>
        </div>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          {loaded && (
            <ClientSwitcher
              clients={clients}
              filter={filter}
              onChange={setFilter}
              allowNone
              counts={
                outputs
                  ? {
                      all: outputs.length,
                      none: outputs.filter((o) => o.clientId === null).length,
                      byClient: (c) => outputs.filter((o) => o.clientId === c.id).length,
                    }
                  : undefined
              }
            />
          )}
          <div
            className="flex items-center gap-1 bg-card p-1"
            style={{ borderRadius: 'var(--radius-lg)' }}
            role="tablist"
          >
            {(['outputs', 'templates'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1 text-sm capitalize transition-colors ${
                  tab === t
                    ? 'bg-[var(--bg-elevated)] text-foreground'
                    : 'text-[var(--text-mute)] hover:text-foreground'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-destructive">Error: {error}</p>}

        {tab === 'outputs' ? (
          visible === null ? (
            !error && <p className="text-sm text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <div
              className="bg-card px-6 py-14 text-center"
              style={{ borderRadius: 'var(--radius-lg)' }}
            >
              <h3 className="text-base font-semibold text-foreground">
                {activeClient ? `No outputs for ${activeClient.name} yet` : 'No outputs yet'}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                Start from a template, pick the client’s kit, and fill in the copy. Everything is
                versioned and shareable as a link.
              </p>
              <button
                type="button"
                className={`${primaryButton} mt-5`}
                onClick={() => setCreating({ templateId: null })}
              >
                <Plus size={14} weight="bold" />
                New output
              </button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((o) => (
                <li key={o.id}>
                  <Link
                    to={`/outputs/${o.id}`}
                    className="block bg-card p-3 transition-colors hover:bg-[var(--bg-elevated)]"
                    style={{ borderRadius: 'var(--radius-lg)' }}
                  >
                    <OutputFrame
                      src={outputRenderPath(o.id, { version: o.latestVersion })}
                      viewport={o.viewport}
                      title={o.name}
                      className="aspect-[16/10] w-full bg-[var(--bg-muted)]"
                      shadow={false}
                    />
                    <p className="mt-3 truncate text-sm font-medium text-foreground">{o.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[
                        OUTPUT_FORMAT_LABELS[o.format],
                        o.clientName,
                        o.kitName ?? 'House style',
                        `v${o.latestVersion}`,
                        relativeTime(o.updatedAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : visibleTemplates === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleTemplates.map((t) => (
              <li key={t.id} className="group relative">
                <TemplateTile
                  template={t}
                  kitId={null}
                  selected={false}
                  onSelect={() => setCreating({ templateId: t.id })}
                />
                <div className="pointer-events-none absolute right-4 top-4 flex gap-1">
                  {t.starter ? (
                    <span className="bg-card px-2 py-0.5 text-micro uppercase tracking-[0.12em] text-[var(--text-mute)]">
                      Starter
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`${ghostButton} pointer-events-auto bg-card opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100`}
                      aria-label={`Delete ${t.name}`}
                      onClick={async () => {
                        if (
                          !confirm(
                            `Delete the template “${t.name}”? Outputs made from it keep working.`,
                          )
                        )
                          return
                        await deleteTemplate(t.id)
                        setTemplates((prev) => prev?.filter((x) => x.id !== t.id) ?? null)
                      }}
                    >
                      <Trash size={13} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      <NewOutputDialog
        open={creating !== null}
        onClose={() => setCreating(null)}
        initialClientId={activeClient?.id ?? null}
        initialTemplateId={creating?.templateId}
      />
    </div>
  )
}
