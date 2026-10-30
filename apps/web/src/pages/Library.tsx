import { ASSET_MEDIA_KINDS, type AssetMediaKind, type LibraryAsset } from '@moodboard/shared'
import { MagnifyingGlass, UploadSimple } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from '@/components/AppHeader'
import { ClientSwitcher } from '@/components/clients/ClientSwitcher'
import { AssetDetail } from '@/components/library/AssetDetail'
import { AssetThumb } from '@/components/library/AssetThumb'
import { ghostButton, inputClass, primaryButton } from '@/components/ui'
import { resolveClientFilter, useClientFilter } from '@/lib/clientFilter'
import { searchLibrary, uploadToLibrary } from '@/lib/libraryApi'
import { useClients } from '@/store/clients'

const KIND_LABEL: Record<AssetMediaKind, string> = {
  image: 'Images',
  pdf: 'PDFs',
  font: 'Fonts',
  audio: 'Audio',
  other: 'Other',
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function LibraryPage() {
  const { clients, loaded } = useClients()
  const [filter, setFilter] = useClientFilter({ allowNone: true })
  const activeClient = resolveClientFilter(filter, clients)
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 250)
  const [kind, setKind] = useState<AssetMediaKind | null>(null)

  const [assets, setAssets] = useState<LibraryAsset[] | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  const clientParam = filter.kind === 'none' ? 'none' : activeClient?.id

  const load = useCallback(async () => {
    const s = ++seq.current
    setError(null)
    try {
      const res = await searchLibrary({
        q: q || undefined,
        client: clientParam,
        kind: kind ?? undefined,
      })
      if (s !== seq.current) return
      setAssets(res.assets)
      setNextOffset(res.nextOffset)
    } catch (e) {
      if (s === seq.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [q, clientParam, kind])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = async () => {
    if (nextOffset === null) return
    setLoadingMore(true)
    try {
      const res = await searchLibrary(
        { q: q || undefined, client: clientParam, kind: kind ?? undefined },
        { offset: nextOffset },
      )
      setAssets((cur) => [...(cur ?? []), ...res.assets])
      setNextOffset(res.nextOffset)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) await uploadToLibrary(file, activeClient?.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const selected = assets?.find((a) => a.id === selectedId) ?? null

  return (
    <div className="min-h-screen bg-background">
      <AppHeader wide />
      <main className="mx-auto max-w-6xl px-6 pb-16 pt-6">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {activeClient ? `${activeClient.name} library` : 'Asset library'}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Everything uploaded or imported on any board, searchable by name, caption and tag.
            </p>
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.woff2,.woff,.ttf,.otf"
              onChange={(e) => void upload(e.target.files)}
            />
            <button
              type="button"
              className={primaryButton}
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              title={activeClient ? `Uploads go to ${activeClient.name}` : 'Upload to the library'}
            >
              <UploadSimple size={14} weight="bold" />
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>

        {loaded && (
          <div className="mb-4">
            <ClientSwitcher
              clients={clients}
              filter={activeClient || filter.kind === 'none' ? filter : { kind: 'all' }}
              onChange={setFilter}
              allowNone
            />
          </div>
        )}

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <MagnifyingGlass
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the library — e.g. warm portrait, logo, hero"
              aria-label="Search the library"
              className={`${inputClass} pl-8`}
            />
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Filter by type">
            {[null, ...ASSET_MEDIA_KINDS.filter((k) => k !== 'other')].map((k) => (
              <button
                key={k ?? 'all'}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                  kind === k
                    ? 'bg-[var(--accent-soft)] text-foreground shadow-[inset_0_0_0_1px_var(--accent)]'
                    : 'text-[var(--text-soft)] hover:bg-[var(--bg-elevated)] hover:text-foreground'
                }`}
              >
                {k ? KIND_LABEL[k] : 'Everything'}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-destructive">Error: {error}</p>}

        <div className={`grid gap-6 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : ''}`}>
          <div>
            {assets === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {assets && assets.length === 0 && (
              <div
                className="bg-card px-6 py-14 text-center"
                style={{ borderRadius: 'var(--radius-lg)' }}
              >
                <h3 className="text-base font-semibold text-foreground">
                  {q || kind || clientParam ? 'Nothing matches' : 'The library is empty'}
                </h3>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  {q || kind || clientParam
                    ? 'Try fewer words, or clear the filters.'
                    : 'Images, PDFs and fonts you add to any board appear here, or upload some above.'}
                </p>
              </div>
            )}
            {assets && assets.length > 0 && (
              <ul
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}
              >
                {assets.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
                      aria-pressed={a.id === selectedId}
                      className={`group block w-full bg-card p-2 text-left transition-colors hover:bg-[var(--bg-elevated)] ${
                        a.id === selectedId ? 'shadow-[0_0_0_1px_var(--accent)]' : ''
                      }`}
                      style={{ borderRadius: 'var(--radius-lg)' }}
                    >
                      <div
                        className="mb-2 aspect-[4/3] overflow-hidden bg-[var(--bg-muted)]"
                        style={{ borderRadius: 'var(--radius)' }}
                      >
                        <AssetThumb asset={a} />
                      </div>
                      <p className="truncate px-0.5 text-sm text-foreground">{a.name}</p>
                      <div className="mt-1 flex items-center gap-1 px-0.5">
                        {a.colors.slice(0, 5).map((c) => (
                          <span
                            key={c}
                            className="h-2.5 w-2.5"
                            style={{ backgroundColor: c, boxShadow: 'var(--swatch-inset)' }}
                          />
                        ))}
                        <span className="ml-auto truncate text-micro text-[var(--text-faint)]">
                          {a.clientName ?? KIND_LABEL[a.kind]}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {nextOffset !== null && (
              <div className="mt-5 text-center">
                <button
                  type="button"
                  className={ghostButton}
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>

          {selected && (
            <div className="lg:sticky lg:top-6 lg:self-start">
              <AssetDetail
                asset={selected}
                clients={clients}
                onClose={() => setSelectedId(null)}
                onChange={(next) =>
                  setAssets((cur) => (cur ? cur.map((a) => (a.id === next.id ? next : a)) : cur))
                }
              />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
