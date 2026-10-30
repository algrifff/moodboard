import { kitToCss, type KitDetail, type KitTokens } from '@moodboard/shared'
import { ArrowLeft, Check, Copy, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { FigmaKitDialog } from '@/components/kits/FigmaKitDialog'
import { KitEditor } from '@/components/kits/KitEditor'
import { FigmaLogo } from '@/components/canvas/sourceLogos'
import { KitPreview } from '@/components/kits/KitPreview'
import { ghostButton, inputClass, labelClass, primaryButton, relativeTime } from '@/components/ui'
import { ApiError } from '@/lib/http'
import { addKitVersion, deleteKit, getKit, updateKit } from '@/lib/kitsApi'
import { useClients, useClientsStore } from '@/store/clients'

// One style kit: view and edit its tokens. Saving never edits a version —
// it appends a new one — so an older version can always be opened and
// restored.
export function KitPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { clients } = useClients()
  const requested = params.get('version') ? Number(params.get('version')) : undefined

  const [detail, setDetail] = useState<KitDetail | null>(null)
  const [draft, setDraft] = useState<KitTokens | null>(null)
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [fromFigma, setFromFigma] = useState(false)

  const load = useCallback(
    async (version?: number) => {
      try {
        const next = await getKit(id, version)
        setDetail(next)
        setDraft(structuredClone(next.version.tokens))
        setName(next.kit.name)
        setNote('')
        setError(null)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setNotFound(true)
        else setError(e instanceof Error ? e.message : String(e))
      }
    },
    [id],
  )

  useEffect(() => {
    void load(requested)
  }, [load, requested])

  const viewingOld = detail !== null && detail.version.version !== detail.kit.latestVersion
  const dirty = useMemo(
    () =>
      detail !== null &&
      draft !== null &&
      JSON.stringify(draft) !== JSON.stringify(detail.version.tokens),
    [detail, draft],
  )

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const css = useMemo(() => (draft ? kitToCss(draft) : ''), [draft])

  const save = async (force = false) => {
    if (!detail || !draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await addKitVersion(detail.kit.id, {
        tokens: draft,
        note: note.trim() || (viewingOld ? `Restored v${detail.version.version}` : undefined),
        baseVersion: force ? undefined : detail.kit.latestVersion,
      })
      setParams({}, { replace: true })
      setDetail(next)
      setDraft(structuredClone(next.version.tokens))
      setNote('')
      void useClientsStore.getState().load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const latest = (e.body as { latest?: number } | undefined)?.latest
        const again = confirm(
          `A teammate saved v${latest ?? 'a newer version'} while you were editing.\n\nSave yours on top of it? (Cancel to reload their version instead.)`,
        )
        if (again) await save(true)
        else {
          setParams({}, { replace: true })
          await load()
        }
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const commitName = async () => {
    if (!detail) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === detail.kit.name) {
      setName(detail.kit.name)
      return
    }
    try {
      const kit = await updateKit(detail.kit.id, { name: trimmed })
      setDetail({ ...detail, kit })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setName(detail.kit.name)
    }
  }

  const moveToClient = async (clientId: string | null) => {
    if (!detail || !clientId) return
    try {
      const kit = await updateKit(detail.kit.id, { clientId })
      setDetail({ ...detail, kit })
      void useClientsStore.getState().load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center">
          <h2 className="text-base font-semibold text-foreground">Kit not found</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">It may have been deleted.</p>
          <Link to="/kits" className={`${primaryButton} mt-5`}>
            Back to kits
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto max-w-6xl px-6 pb-3 pt-6">
        <Link
          to="/kits"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-mute)] transition-colors hover:text-foreground"
        >
          <ArrowLeft size={13} />
          All kits
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-2">
        {!detail || !draft ? (
          <p className="text-sm text-muted-foreground">{error ?? 'Loading…'}</p>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-end gap-4">
              <div className="min-w-[240px] flex-1">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void commitName()}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  maxLength={80}
                  aria-label="Kit name"
                  className="w-full bg-transparent text-2xl font-semibold tracking-tight text-foreground outline-none focus:shadow-[0_1px_0_var(--accent)]"
                />
                <p className="mt-1 text-sm text-[var(--text-mute)]">
                  Version {detail.version.version}
                  {viewingOld ? ` of ${detail.kit.latestVersion}` : ''} · saved{' '}
                  {relativeTime(detail.version.createdAt)}
                  {detail.version.createdByName ? ` by ${detail.version.createdByName}` : ''}
                  {detail.version.note ? ` — ${detail.version.note}` : ''}
                </p>
              </div>
              <button
                type="button"
                className={ghostButton}
                disabled={dirty || viewingOld}
                title={
                  dirty
                    ? 'Save or discard your edits first'
                    : viewingOld
                      ? 'Go back to the latest version first'
                      : 'Read a Figma file’s styles into a new version'
                }
                onClick={() => setFromFigma(true)}
              >
                <FigmaLogo size={12} />
                Update from Figma
              </button>
              <div>
                <div className={`${labelClass} mb-1`}>Client</div>
                <ClientSelect
                  clients={clients}
                  value={detail.kit.clientId}
                  allowNone={false}
                  onChange={(id) => void moveToClient(id)}
                  label="Client"
                  className="w-48"
                />
              </div>
            </div>

            {fromFigma && (
              <FigmaKitDialog
                mode="version"
                kit={detail.kit}
                onClose={() => setFromFigma(false)}
                onSaved={() => {
                  setFromFigma(false)
                  setParams({}, { replace: true })
                  void load()
                }}
              />
            )}

            {viewingOld && (
              <div
                className="mb-5 flex flex-wrap items-center gap-3 bg-[var(--accent-soft)] px-4 py-3 text-sm text-foreground"
                style={{ borderRadius: 'var(--radius-lg)' }}
              >
                <span>
                  You’re looking at version {detail.version.version}. Restoring saves it as a new
                  version; nothing is lost.
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  className={ghostButton}
                  onClick={() => setParams({}, { replace: true })}
                >
                  Back to latest
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  Restore as v{detail.kit.latestVersion + 1}
                </button>
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <KitEditor
                tokens={draft}
                onChange={setDraft}
                resetKey={`${detail.kit.id}:${detail.version.version}`}
                disabled={viewingOld}
              />

              <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
                <KitPreview tokens={draft} />

                <section className="bg-card p-4" style={{ borderRadius: 'var(--radius-lg)' }}>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">Versions</h3>
                  <ul className="flex max-h-56 flex-col overflow-y-auto">
                    {detail.versions.map((v) => {
                      const active = v.version === detail.version.version
                      return (
                        <li key={v.version}>
                          <button
                            type="button"
                            onClick={() =>
                              setParams(
                                v.version === detail.kit.latestVersion
                                  ? {}
                                  : { version: String(v.version) },
                                {
                                  replace: true,
                                },
                              )
                            }
                            className={`flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-elevated)] ${
                              active ? 'bg-[var(--bg-elevated)]' : ''
                            }`}
                            style={{ borderRadius: 'var(--radius)' }}
                          >
                            <span className="w-7 shrink-0 font-mono text-foreground">
                              v{v.version}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[var(--text-soft)]">
                              {v.note || (v.version === 1 ? 'Created' : 'Edited')}
                            </span>
                            <span className="shrink-0 text-[var(--text-faint)]">
                              {v.createdByName ? `${v.createdByName.split(' ')[0]} · ` : ''}
                              {relativeTime(v.createdAt)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>

                <details className="bg-card p-4" style={{ borderRadius: 'var(--radius-lg)' }}>
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">
                    Compiled CSS
                  </summary>
                  <div className="mt-3">
                    <button
                      type="button"
                      className={ghostButton}
                      onClick={async () => {
                        await navigator.clipboard.writeText(css).catch(() => undefined)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                      }}
                    >
                      {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <pre className="mt-2 max-h-72 overflow-auto bg-[var(--bg-muted)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-soft)]">
                      {css}
                    </pre>
                  </div>
                </details>

                <button
                  type="button"
                  className={`${ghostButton} justify-start hover:text-destructive`}
                  onClick={async () => {
                    if (
                      !confirm(
                        `Delete “${detail.kit.name}” and all ${detail.kit.latestVersion} versions?`,
                      )
                    )
                      return
                    await deleteKit(detail.kit.id)
                    navigate('/kits')
                  }}
                >
                  <Trash size={13} />
                  Delete kit
                </button>
              </aside>
            </div>

            {!viewingOld && (
              <div
                className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border-soft)] bg-card/95 backdrop-blur-md"
                style={{ boxShadow: dirty ? 'var(--shadow-pill)' : 'none' }}
              >
                <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
                  <span className="text-sm text-[var(--text-mute)]">
                    {dirty ? 'Unsaved changes' : 'Up to date'}
                  </span>
                  {error && <span className="text-sm text-destructive">{error}</span>}
                  <div className="flex-1" />
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    placeholder="What changed? (optional)"
                    aria-label="Change note"
                    className={`${inputClass} max-w-xs`}
                    disabled={!dirty}
                  />
                  <button
                    type="button"
                    className={ghostButton}
                    disabled={!dirty || saving}
                    onClick={() => setDraft(structuredClone(detail.version.tokens))}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving…' : `Save as v${detail.kit.latestVersion + 1}`}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
