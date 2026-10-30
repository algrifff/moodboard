import type { BoardSummary, LibraryAsset, OutputDetail, OutputShare } from '@moodboard/shared'
import { slotNameSchema } from '@moodboard/shared'
import { Check, Copy, UploadSimple } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { AssetThumb } from '@/components/library/AssetThumb'
import { ghostButton, inputClass, labelClass, primaryButton, relativeTime } from '@/components/ui'
import { listBoards } from '@/lib/boardsApi'
import { searchLibrary, uploadToLibrary } from '@/lib/libraryApi'
import {
  placeOutput,
  proposedSlots,
  saveAsTemplate,
  sharePageUrl,
  shareOutput,
  unshareOutput,
} from '@/lib/outputsApi'
import { useClients } from '@/store/clients'
import { Modal } from './Modal'

// ---------------------------------------------------------------------------
// Image slot → a library asset
// ---------------------------------------------------------------------------

export function AssetPickerDialog({
  open,
  onClose,
  clientId,
  onPick,
}: {
  open: boolean
  onClose: () => void
  clientId: string | null
  onPick: (url: string) => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Choose an image" width="max-w-3xl">
      <AssetPicker clientId={clientId} onPick={onPick} />
    </Modal>
  )
}

function AssetPicker({
  clientId,
  onPick,
}: {
  clientId: string | null
  onPick: (url: string) => void
}) {
  const [query, setQuery] = useState('')
  const [onlyClient, setOnlyClient] = useState(clientId !== null)
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(
      () => {
        searchLibrary(
          {
            q: query.trim() || undefined,
            kind: 'image',
            client: onlyClient && clientId ? clientId : undefined,
          },
          { limit: 30 },
        )
          .then((res) => setAssets(res.assets))
          .catch((e: Error) => setError(e.message))
      },
      query ? 250 : 0,
    )
    return () => clearTimeout(timer)
  }, [query, onlyClient, clientId])

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const res = await uploadToLibrary(file, clientId ?? undefined)
      onPick(res.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the library…"
          className={`${inputClass} max-w-xs`}
          aria-label="Search the library"
        />
        {clientId && (
          <label className="inline-flex items-center gap-1.5 text-sm text-[var(--text-soft)]">
            <input
              type="checkbox"
              checked={onlyClient}
              onChange={(e) => setOnlyClient(e.target.checked)}
            />
            This client only
          </label>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className={ghostButton}
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          <UploadSimple size={13} />
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
          }}
        />
      </div>
      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
      {assets === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : assets.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No images match. Upload one, or add some in the library.
        </p>
      ) : (
        <ul className="grid max-h-[56vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onPick(a.url)}
                title={[a.name, a.caption].filter(Boolean).join(' — ')}
                aria-label={`Use ${a.name}`}
                className="block aspect-square w-full overflow-hidden bg-[var(--bg-elevated)] transition-opacity hover:opacity-85"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <AssetThumb asset={a} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Put the output on a board
// ---------------------------------------------------------------------------

export function AddToBoardDialog({
  open,
  onClose,
  outputId,
  clientId,
}: {
  open: boolean
  onClose: () => void
  outputId: string
  clientId: string | null
}) {
  return (
    <Modal open={open} onClose={onClose} title="Add to a board">
      <BoardPicker outputId={outputId} clientId={clientId} />
    </Modal>
  )
}

function BoardPicker({ outputId, clientId }: { outputId: string; clientId: string | null }) {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [placed, setPlaced] = useState<BoardSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listBoards()
      .then((list) =>
        // The output's own client first.
        setBoards(
          [...list].sort(
            (a, b) => Number(b.clientId === clientId) - Number(a.clientId === clientId),
          ),
        ),
      )
      .catch((e: Error) => setError(e.message))
  }, [clientId])

  if (placed) {
    return (
      <div className="text-sm text-foreground">
        <p>
          Added to <strong>{placed.name}</strong> as a live card.
        </p>
        <Link to={`/board/${placed.id}`} className={`${primaryButton} mt-4`}>
          Open the board
        </Link>
      </div>
    )
  }
  return (
    <div>
      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
      {boards === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="text-sm text-muted-foreground">No boards yet.</p>
      ) : (
        <ul className="max-h-[50vh] divide-y divide-[var(--border-soft)] overflow-y-auto">
          {boards.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(b.id)
                  try {
                    await placeOutput(outputId, b.id)
                    setPlaced(b)
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                  } finally {
                    setBusy(null)
                  }
                }}
                className="flex w-full items-center gap-3 px-1 py-2.5 text-left text-sm transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{b.name}</span>
                <span className="shrink-0 text-xs text-[var(--text-faint)]">
                  {busy === b.id ? 'Adding…' : relativeTime(b.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Share link (pinned to a version; "update" moves the pin, keeps the link)
// ---------------------------------------------------------------------------

export function ShareOutputDialog({
  open,
  onClose,
  detail,
  onChange,
}: {
  open: boolean
  onClose: () => void
  detail: OutputDetail
  onChange: (share: OutputShare | null) => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Share">
      <ShareBody detail={detail} onChange={onChange} />
    </Modal>
  )
}

function ShareBody({
  detail,
  onChange,
}: {
  detail: OutputDetail
  onChange: (share: OutputShare | null) => void
}) {
  const { share } = detail
  const latest = detail.output.latestVersion
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  if (!share) {
    return (
      <div className="text-sm text-[var(--text-soft)]">
        <p>
          Anyone with the link sees version {latest} as a page they can view and download — no
          sign-in. Later edits stay private until you update the link.
        </p>
        {error && <p className="mt-2 text-destructive">{error}</p>}
        <button
          type="button"
          className={`${primaryButton} mt-4`}
          disabled={busy}
          onClick={() => run(async () => onChange(await shareOutput(detail.output.id)))}
        >
          Create link
        </button>
      </div>
    )
  }

  const url = sharePageUrl(share.token)
  return (
    <div className="text-sm">
      <div className="flex gap-2">
        <input readOnly value={url} className={inputClass} aria-label="Share link" />
        <button
          type="button"
          className={ghostButton}
          onClick={async () => {
            await navigator.clipboard.writeText(url).catch(() => undefined)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-[var(--text-mute)]">
        Shows v{share.version}
        {share.version < latest ? ` — v${latest} is newer` : ' (latest)'} · updated{' '}
        {relativeTime(share.updatedAt)}
      </p>
      {error && <p className="mt-2 text-destructive">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {share.version < latest && (
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => run(async () => onChange(await shareOutput(detail.output.id)))}
          >
            Update link to v{latest}
          </button>
        )}
        <a href={url} target="_blank" rel="noreferrer" className={ghostButton}>
          Open
        </a>
        <button
          type="button"
          className={`${ghostButton} hover:text-destructive`}
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (!confirm('Stop sharing? The link will stop working.')) return
              await unshareOutput(detail.output.id)
              onChange(null)
            })
          }
        >
          Stop sharing
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Save as template
// ---------------------------------------------------------------------------

type SlotRow = {
  from: string
  to: string
  label: string
  keep: boolean
  kind: string
  sample: string
}

export function SaveTemplateDialog({
  open,
  onClose,
  detail,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  detail: OutputDetail
  onSaved: (name: string) => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Save as template" width="max-w-2xl">
      <SaveTemplateForm detail={detail} onSaved={onSaved} />
    </Modal>
  )
}

function SaveTemplateForm({
  detail,
  onSaved,
}: {
  detail: OutputDetail
  onSaved: (name: string) => void
}) {
  const { clients } = useClients()
  const [name, setName] = useState(`${detail.output.name} template`)
  const [clientId, setClientId] = useState<string | null>(detail.output.clientId)
  const [rows, setRows] = useState<SlotRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The slot proposer: the markers the output already has, renamed and
    // joined by new candidates (`from` = @n) when the server has a model.
    proposedSlots(detail.output.id, detail.version.version)
      .then((slots) =>
        setRows(
          slots.map((s) => ({
            from: s.from,
            to: s.name,
            label: s.label,
            keep: true,
            kind: s.kind,
            sample: s.sample,
          })),
        ),
      )
      .catch((e: Error) => setError(e.message))
  }, [detail.output.id, detail.version.version])

  const problems = useMemo(() => {
    if (!rows) return []
    const kept = rows.filter((r) => r.keep)
    const bad = kept.filter((r) => !slotNameSchema.safeParse(r.to).success).map((r) => r.to)
    const names = kept.map((r) => r.to)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    return [
      ...bad.map(
        (n) => `“${n || '(empty)'}” isn’t a valid slot name — lowercase letters, digits, dashes`,
      ),
      ...[...new Set(dupes)].map((n) => `“${n}” is used twice`),
    ]
  }, [rows])

  const update = (i: number, patch: Partial<SlotRow>) =>
    setRows((prev) => prev?.map((r, j) => (j === i ? { ...r, ...patch } : r)) ?? null)

  const submit = async () => {
    if (!rows || problems.length > 0 || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await saveAsTemplate({
        outputId: detail.output.id,
        version: detail.version.version,
        name: name.trim(),
        clientId,
        slots: rows.map((r) => ({
          from: r.from,
          to: r.keep ? r.to : null,
          label: r.label.trim() || undefined,
        })),
      })
      onSaved(name.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <p className="mb-4 text-sm text-[var(--text-soft)]">
        The current version becomes the template, its copy the new defaults. Name the slots people
        (and agents) will fill; untick one to make it fixed content.
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px]">
        <label>
          <span className={`${labelClass} mb-1 block`}>Template name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className={inputClass}
          />
        </label>
        <label>
          <span className={`${labelClass} mb-1 block`}>Client</span>
          <ClientSelect
            clients={clients}
            value={clientId}
            onChange={setClientId}
            noneLabel="Everyone"
            label="Template client"
            className="w-full"
          />
        </label>
      </div>
      <div className={`${labelClass} mb-1.5 grid grid-cols-[24px_1fr_1fr_48px] gap-2 px-1`}>
        <span />
        <span>Slot name</span>
        <span>Label</span>
        <span>Kind</span>
      </div>
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Reading slots…</p>
      ) : (
        <ul className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto px-1">
          {rows.map((r, i) => (
            <li
              key={r.from}
              className="grid grid-cols-[24px_1fr_1fr_48px] items-center gap-x-2 gap-y-0.5"
            >
              <input
                type="checkbox"
                checked={r.keep}
                onChange={(e) => update(i, { keep: e.target.checked })}
                aria-label={`Keep ${r.from} as a slot`}
              />
              <input
                value={r.to}
                disabled={!r.keep}
                onChange={(e) => update(i, { to: e.target.value.toLowerCase() })}
                className={`${inputClass} font-mono text-[12.5px]`}
                aria-label={`Name for ${r.from}`}
              />
              <input
                value={r.label}
                disabled={!r.keep}
                onChange={(e) => update(i, { label: e.target.value })}
                maxLength={60}
                className={inputClass}
                aria-label={`Label for ${r.from}`}
              />
              <span className="text-xs text-[var(--text-mute)]">
                {r.kind}
                {r.from.startsWith('@') && (
                  <span className="ml-1 text-[var(--accent)]" title="Proposed new slot">
                    new
                  </span>
                )}
              </span>
              {r.sample && r.kind === 'text' && (
                <span className="col-span-3 col-start-2 truncate text-[11px] text-[var(--text-faint)]">
                  {r.sample}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {[...problems, ...(error ? [error] : [])].map((p) => (
        <p key={p} className="mt-2 text-sm text-destructive">
          {p}
        </p>
      ))}
      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || rows === null || problems.length > 0 || !name.trim()}
        >
          {busy ? 'Saving…' : 'Save template'}
        </button>
      </div>
    </form>
  )
}
