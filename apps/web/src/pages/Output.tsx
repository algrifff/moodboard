import {
  OUTPUT_FORMAT_LABELS,
  outputRenderPath,
  SLOT_EDIT_MESSAGE,
  SLOT_FOCUS_MESSAGE,
  type CreateOutputVersionRequest,
  type KitSummary,
  type OutputDetail,
  type OutputSlot,
} from '@moodboard/shared'
import {
  ArrowLeft,
  DesktopTower,
  DeviceMobile,
  DeviceTablet,
  DownloadSimple,
  ShareNetwork,
  SquaresFour,
  Trash,
  BookmarkSimple,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { showToast, ToastHost } from '@/components/canvas/Toast'
import { KitSelect } from '@/components/outputs/NewOutputDialog'
import {
  AddToBoardDialog,
  AssetPickerDialog,
  SaveTemplateDialog,
  ShareOutputDialog,
} from '@/components/outputs/OutputDialogs'
import { OutputFrame } from '@/components/outputs/OutputFrame'
import { SlotFields } from '@/components/outputs/SlotFields'
import { ghostButton, labelClass, primaryButton, relativeTime } from '@/components/ui'
import { ApiError } from '@/lib/http'
import { listKits } from '@/lib/kitsApi'
import { addOutputVersion, deleteOutput, getOutput, updateOutput } from '@/lib/outputsApi'
import { AGENT_SIDEBAR_WIDTH } from '@/store/agentSidebar'
import { useClients } from '@/store/clients'

const DEVICES = [
  { id: 'phone', label: 'Phone', width: 390, icon: DeviceMobile },
  { id: 'tablet', label: 'Tablet', width: 820, icon: DeviceTablet },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: DesktopTower },
] as const

type Dialog = 'share' | 'board' | 'template' | null

// One output: a large sandboxed preview, and on the left (where the agent
// sidebar sits on a board) its slots, kit and versions. Every edit — a
// field, an inline edit in the preview, a kit switch, a restore — appends a
// version; nothing is overwritten.
export function OutputPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const requested = params.get('version') ? Number(params.get('version')) : undefined
  const { clients } = useClients()

  const [detail, setDetail] = useState<OutputDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [kits, setKits] = useState<KitSummary[]>([])
  const [tab, setTab] = useState<'slots' | 'versions'>('slots')
  const [device, setDevice] = useState<(typeof DEVICES)[number]['id']>('desktop')
  const [focusedSlot, setFocusedSlot] = useState<string | null>(null)
  const [picking, setPicking] = useState<OutputSlot | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  // The version the preview iframe shows. An inline edit made inside the
  // preview is already on screen, so saving it doesn't reload the frame.
  const [frameVersion, setFrameVersion] = useState<number | null>(null)
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const latestRef = useRef(0)

  const load = useCallback(
    async (version?: number) => {
      try {
        const next = await getOutput(id, version)
        setDetail(next)
        setName(next.output.name)
        setFrameVersion(next.version.version)
        latestRef.current = next.output.latestVersion
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

  const clientId = detail?.output.clientId ?? null
  useEffect(() => {
    if (!clientId) {
      setKits([])
      return
    }
    listKits(clientId)
      .then(setKits)
      .catch(() => setKits([]))
  }, [clientId])

  const viewingOld = detail !== null && detail.version.version !== detail.output.latestVersion

  // Saves run one at a time, each on top of the version the last one made,
  // so quick successive edits don't trip over each other. A teammate's
  // newer save is a 409: reload theirs rather than bury it.
  const save = useCallback(
    (
      patch: Omit<CreateOutputVersionRequest, 'baseVersion'>,
      opts: { reloadFrame?: boolean } = {},
    ) => {
      const run = async () => {
        setSaving(true)
        try {
          const next = await addOutputVersion(id, { ...patch, baseVersion: latestRef.current })
          latestRef.current = next.output.latestVersion
          setDetail(next)
          if (opts.reloadFrame !== false) setFrameVersion(next.version.version)
          if (requested) setParams({}, { replace: true })
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            showToast('A teammate saved a newer version — showing theirs')
            await load()
          } else {
            showToast(`Couldn’t save: ${e instanceof Error ? e.message : String(e)}`)
          }
        } finally {
          setSaving(false)
        }
      }
      saveQueue.current = saveQueue.current.then(run, run)
      return saveQueue.current
    },
    [id, load, requested, setParams],
  )

  const onFrameMessage = useCallback(
    (data: unknown) => {
      if (!data || typeof data !== 'object') return
      const msg = data as { type?: unknown; name?: unknown; value?: unknown }
      if (typeof msg.name !== 'string') return
      if (msg.type === SLOT_FOCUS_MESSAGE) {
        setTab('slots')
        setFocusedSlot(msg.name)
        const slot = detail?.version.slots.find((s) => s.name === msg.name)
        if (slot?.kind === 'image' && !viewingOld) setPicking(slot)
      }
      if (msg.type === SLOT_EDIT_MESSAGE && typeof msg.value === 'string' && !viewingOld) {
        void save({ slotValues: { [msg.name]: msg.value.slice(0, 2000) } }, { reloadFrame: false })
      }
    },
    [detail, save, viewingOld],
  )

  const commitName = async () => {
    if (!detail) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === detail.output.name) {
      setName(detail.output.name)
      return
    }
    try {
      const output = await updateOutput(detail.output.id, { name: trimmed })
      setDetail({ ...detail, output })
    } catch (e) {
      setName(detail.output.name)
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const moveToClient = async (next: string | null) => {
    if (!detail) return
    try {
      const output = await updateOutput(detail.output.id, { clientId: next })
      setDetail({ ...detail, output })
      // The kit belongs to the old client; the house style is the honest
      // default until one of the new client's kits is picked.
      if (detail.version.kitId) await save({ kitId: null })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center">
          <h2 className="text-base font-semibold text-foreground">Output not found</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">It may have been deleted.</p>
          <Link to="/outputs" className={`${primaryButton} mt-5`}>
            Back to outputs
          </Link>
        </div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        {error ?? 'Loading…'}
      </div>
    )
  }

  const { output, version } = detail
  const responsive = output.viewport.kind === 'responsive'
  const deviceWidth = DEVICES.find((d) => d.id === device)!.width
  const src = outputRenderPath(output.id, {
    version: frameVersion ?? version.version,
    edit: !viewingOld,
  })
  const kitBehind =
    version.kitId !== null &&
    version.kitLatestVersion !== null &&
    version.kitVersion !== null &&
    version.kitLatestVersion > version.kitVersion

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <Link
          to="/outputs"
          className="inline-flex h-8 w-8 items-center justify-center text-[var(--text-mute)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-foreground"
          style={{ borderRadius: 'var(--radius)' }}
          aria-label="All outputs"
          title="All outputs"
        >
          <ArrowLeft size={15} />
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          maxLength={120}
          aria-label="Output name"
          className="min-w-0 max-w-[340px] flex-1 bg-transparent px-1 text-[14px] font-medium text-foreground outline-none focus:shadow-[0_1px_0_var(--accent)]"
        />
        <span className="hidden truncate text-[12px] text-[var(--text-mute)] md:inline">
          {OUTPUT_FORMAT_LABELS[output.format]} · v{version.version}
          {viewingOld ? ` of ${output.latestVersion}` : ''}
          {saving ? ' · saving…' : ''}
        </span>
        <div className="flex-1" />
        {responsive && (
          <div
            className="mr-2 flex items-center gap-0.5 bg-[var(--bg-elevated)] p-0.5"
            style={{ borderRadius: 'var(--radius-lg)' }}
            role="radiogroup"
            aria-label="Preview width"
          >
            {DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={device === d.id}
                onClick={() => setDevice(d.id)}
                title={`${d.label} · ${d.width}px`}
                className={`inline-flex h-7 w-8 items-center justify-center transition-colors ${
                  device === d.id
                    ? 'bg-card text-foreground'
                    : 'text-[var(--text-mute)] hover:text-foreground'
                }`}
                style={{ borderRadius: 'var(--radius)' }}
              >
                <d.icon size={15} />
              </button>
            ))}
          </div>
        )}
        <button type="button" className={ghostButton} onClick={() => setDialog('board')}>
          <SquaresFour size={14} />
          <span className="hidden lg:inline">Add to board</span>
        </button>
        <button type="button" className={ghostButton} onClick={() => setDialog('template')}>
          <BookmarkSimple size={14} />
          <span className="hidden lg:inline">Save as template</span>
        </button>
        <a
          href={outputRenderPath(output.id, { version: version.version, download: true })}
          className={ghostButton}
          download
        >
          <DownloadSimple size={14} />
          <span className="hidden lg:inline">Download HTML</span>
        </a>
        <button type="button" className={primaryButton} onClick={() => setDialog('share')}>
          <ShareNetwork size={14} weight="bold" />
          Share
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col bg-card"
          style={{ width: AGENT_SIDEBAR_WIDTH, boxShadow: '1px 0 0 var(--border-soft)' }}
          aria-label="Output"
        >
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border-soft)] px-2">
            {(['slots', 'versions'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-2.5 py-1 text-[13px] capitalize transition-colors ${
                  tab === t
                    ? 'bg-[var(--bg-elevated)] text-foreground'
                    : 'text-[var(--text-mute)] hover:text-foreground'
                }`}
                style={{ borderRadius: 'var(--radius)' }}
              >
                {t === 'versions' ? `Versions · ${output.latestVersion}` : 'Slots'}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === 'slots' ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className={`${labelClass} mb-1 block`}>Client</span>
                    <ClientSelect
                      clients={clients}
                      value={output.clientId}
                      onChange={(c) => void moveToClient(c)}
                      label="Client"
                      className="w-full"
                    />
                  </label>
                  <label className="block">
                    <span className={`${labelClass} mb-1 block`}>Style kit</span>
                    <KitSelect
                      kits={kits}
                      value={version.kitId}
                      pinnedVersion={version.kitVersion}
                      onChange={(kitId) => !viewingOld && void save({ kitId })}
                    />
                  </label>
                </div>
                {kitBehind && !viewingOld && (
                  <button
                    type="button"
                    onClick={() => void save({ kitId: version.kitId })}
                    className="mb-4 w-full px-3 py-2 text-left text-[12.5px] text-foreground transition-colors hover:brightness-110"
                    style={{
                      borderRadius: 'var(--radius-lg)',
                      backgroundColor: 'var(--accent-soft)',
                    }}
                  >
                    {output.kitName} has a newer version (v{version.kitLatestVersion}). Use it →
                  </button>
                )}
                <p className="mb-3 text-[12px] text-[var(--text-mute)]">
                  Edit here or click text in the preview. Each change saves a version.
                </p>
                <SlotFields
                  slots={version.slots}
                  disabled={viewingOld}
                  focused={focusedSlot}
                  onCommit={(name, value) => void save({ slotValues: { [name]: value } })}
                  onPickImage={setPicking}
                />
              </>
            ) : (
              <ul className="flex flex-col">
                {detail.versions.map((v) => {
                  const active = v.version === version.version
                  return (
                    <li key={v.version}>
                      <button
                        type="button"
                        onClick={() =>
                          setParams(
                            v.version === output.latestVersion
                              ? {}
                              : { version: String(v.version) },
                            { replace: true },
                          )
                        }
                        className={`flex w-full items-baseline gap-2 px-2 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--bg-elevated)] ${
                          active ? 'bg-[var(--bg-elevated)]' : ''
                        }`}
                        style={{ borderRadius: 'var(--radius)' }}
                      >
                        <span className="w-8 shrink-0 font-mono text-foreground">v{v.version}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--text-soft)]">
                          {v.note}
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--text-faint)]">
                          {v.createdByName ? `${v.createdByName.split(' ')[0]} · ` : ''}
                          {relativeTime(v.createdAt)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--border-soft)] px-3 py-2 text-[11.5px] text-[var(--text-faint)]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {output.templateName ? `From ${output.templateName}` : 'Template deleted'}
                {output.createdByName ? ` · by ${output.createdByName}` : ''}
              </span>
              <button
                type="button"
                className="shrink-0 transition-colors hover:text-destructive"
                aria-label="Delete output"
                title="Delete output"
                onClick={async () => {
                  if (!confirm(`Delete “${output.name}” and all its versions?`)) return
                  await deleteOutput(output.id)
                  navigate('/outputs')
                }}
              >
                <Trash size={13} />
              </button>
            </div>
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col bg-[var(--bg-muted)]">
          {viewingOld && (
            <div
              className="mx-4 mt-4 flex flex-wrap items-center gap-3 bg-[var(--accent-soft)] px-4 py-2.5 text-sm text-foreground"
              style={{ borderRadius: 'var(--radius-lg)' }}
            >
              <span>
                Viewing version {version.version}. Restoring saves it as a new version; nothing is
                lost.
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
                onClick={() => void save({ restoreVersion: version.version })}
              >
                Restore as v{output.latestVersion + 1}
              </button>
            </div>
          )}
          <OutputFrame
            src={src}
            viewport={output.viewport}
            deviceWidth={deviceWidth}
            interactive
            title={output.name}
            onMessage={onFrameMessage}
            className="min-h-0 flex-1 p-6"
          />
          <ToastHost />
        </main>
      </div>

      <AssetPickerDialog
        open={picking !== null}
        onClose={() => setPicking(null)}
        clientId={output.clientId}
        onPick={(url) => {
          const slot = picking
          setPicking(null)
          if (slot) void save({ slotValues: { [slot.name]: url } })
        }}
      />
      <AddToBoardDialog
        open={dialog === 'board'}
        onClose={() => setDialog(null)}
        outputId={output.id}
        clientId={output.clientId}
      />
      <ShareOutputDialog
        open={dialog === 'share'}
        onClose={() => setDialog(null)}
        detail={detail}
        onChange={(share) => setDetail({ ...detail, share })}
      />
      <SaveTemplateDialog
        open={dialog === 'template'}
        onClose={() => setDialog(null)}
        detail={detail}
        onSaved={(templateName) => {
          setDialog(null)
          showToast(`Saved “${templateName}” as a template`)
        }}
      />
    </div>
  )
}
