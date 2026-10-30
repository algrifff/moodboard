import type { BoardSummary, Client, LibraryAsset, UpdateAssetRequest } from '@moodboard/shared'
import { Check, Copy, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ghostButton, inputClass, labelClass, primaryButton, selectClass } from '@/components/ui'
import { listBoards } from '@/lib/boardsApi'
import { addLibraryAssetToBoard, updateLibraryAsset } from '@/lib/libraryApi'
import { AssetThumb } from './AssetThumb'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Side panel for one asset: edit what the library knows about it, and put
// it on a board.
export function AssetDetail({
  asset,
  clients,
  onChange,
  onClose,
}: {
  asset: LibraryAsset
  clients: Client[]
  onChange: (asset: LibraryAsset) => void
  onClose: () => void
}) {
  const [name, setName] = useState(asset.name)
  const [caption, setCaption] = useState(asset.caption ?? '')
  const [tagDraft, setTagDraft] = useState('')
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [boardId, setBoardId] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    setName(asset.name)
    setCaption(asset.caption ?? '')
    setTagDraft('')
    setStatus(null)
  }, [asset.id])

  useEffect(() => {
    listBoards()
      .then((b) => {
        setBoards(b)
        setBoardId((cur) => cur || b[0]?.id || '')
      })
      .catch(() => setBoards([]))
  }, [])

  const save = async (patch: UpdateAssetRequest) => {
    try {
      onChange(await updateLibraryAsset(asset.id, patch))
      setStatus(null)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const addTag = async () => {
    const tag = tagDraft.trim().toLowerCase()
    setTagDraft('')
    if (!tag || asset.tags.includes(tag)) return
    await save({ tags: [...asset.tags, tag] })
  }

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => undefined)
    setCopied(text)
    setTimeout(() => setCopied(null), 1500)
  }

  const placeable = asset.kind === 'image' || asset.kind === 'pdf' || asset.kind === 'font'
  const boardsByClient = boards
    ? [...boards].sort(
        (a, b) => Number(b.clientId === asset.clientId) - Number(a.clientId === asset.clientId),
      )
    : []

  return (
    <aside
      className="flex flex-col gap-4 bg-card p-5"
      style={{ borderRadius: 'var(--radius-lg)' }}
      aria-label="Asset details"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">Asset</h3>
        <button type="button" onClick={onClose} className={ghostButton} aria-label="Close details">
          <X size={14} weight="bold" />
        </button>
      </div>

      <div
        className="aspect-[4/3] w-full overflow-hidden bg-[var(--bg-muted)]"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <AssetThumb asset={asset} fit="contain" />
      </div>

      <label className="block">
        <span className={`${labelClass} mb-1 block`}>Name</span>
        <input
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name.trim() !== asset.name && void save({ name: name.trim() })
          }
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className={`${labelClass} mb-1 block`}>Caption</span>
        <textarea
          value={caption}
          rows={3}
          maxLength={500}
          placeholder={asset.kind === 'image' ? 'Not captioned yet' : 'Add a description'}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={() =>
            caption !== (asset.caption ?? '') && void save({ caption: caption.trim() || null })
          }
          className={`${inputClass} resize-y leading-relaxed`}
        />
      </label>

      <div>
        <span className={`${labelClass} mb-1 block`}>Tags</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {asset.tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-soft)]"
              style={{ borderRadius: 'var(--radius)' }}
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                className="text-[var(--text-faint)] hover:text-destructive"
                onClick={() => void save({ tags: asset.tags.filter((x) => x !== t) })}
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                void addTag()
              }
            }}
            onBlur={() => void addTag()}
            placeholder="Add tag"
            aria-label="Add tag"
            maxLength={40}
            className="w-24 bg-transparent px-1 py-0.5 text-xs text-foreground outline-none placeholder:text-[var(--text-faint)]"
          />
        </div>
      </div>

      <div>
        <span className={`${labelClass} mb-1 block`}>Client</span>
        <ClientSelect
          clients={clients}
          value={asset.clientId}
          onChange={(clientId) => void save({ clientId })}
          label="Client"
          className="w-full"
        />
      </div>

      {asset.colors.length > 0 && (
        <div>
          <span className={`${labelClass} mb-1.5 block`}>Colours</span>
          <div className="flex flex-wrap gap-1.5">
            {asset.colors.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => void copy(hex)}
                title={`Copy ${hex}`}
                className="group flex items-center gap-1.5 text-xs text-[var(--text-soft)] hover:text-foreground"
              >
                <span
                  className="h-5 w-5"
                  style={{
                    backgroundColor: hex,
                    borderRadius: 'var(--radius)',
                    boxShadow: 'var(--shadow-small), var(--swatch-inset)',
                  }}
                />
                <span className="font-mono">{copied === hex ? 'copied' : hex}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-[var(--text-mute)]">Type</dt>
        <dd className="text-[var(--text-soft)]">{asset.mimeType}</dd>
        {asset.width && asset.height && (
          <>
            <dt className="text-[var(--text-mute)]">Size</dt>
            <dd className="text-[var(--text-soft)]">
              {asset.width} × {asset.height} px · {formatBytes(asset.size)}
            </dd>
          </>
        )}
        {!(asset.width && asset.height) && (
          <>
            <dt className="text-[var(--text-mute)]">Size</dt>
            <dd className="text-[var(--text-soft)]">{formatBytes(asset.size)}</dd>
          </>
        )}
        <dt className="text-[var(--text-mute)]">Added</dt>
        <dd className="text-[var(--text-soft)]">
          {new Date(asset.createdAt).toLocaleDateString()}
          {asset.createdByName ? ` by ${asset.createdByName}` : ''}
        </dd>
      </dl>

      <div className="flex items-center gap-2">
        <button type="button" className={ghostButton} onClick={() => void copy(asset.url)}>
          {copied === asset.url ? <Check size={13} weight="bold" /> : <Copy size={13} />}
          {copied === asset.url ? 'Copied' : 'Copy URL'}
        </button>
      </div>

      {placeable && (
        <div className="border-t border-[var(--border-soft)] pt-4">
          <span className={`${labelClass} mb-1.5 block`}>Add to a board</span>
          {boards === null ? (
            <p className="text-xs text-[var(--text-mute)]">Loading boards…</p>
          ) : boards.length === 0 ? (
            <p className="text-xs text-[var(--text-mute)]">Create a board first.</p>
          ) : (
            <div className="flex gap-2">
              <select
                value={boardId}
                onChange={(e) => setBoardId(e.target.value)}
                aria-label="Board"
                className={selectClass}
              >
                {boardsByClient.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={primaryButton}
                disabled={!boardId}
                onClick={async () => {
                  try {
                    await addLibraryAssetToBoard(asset.id, boardId)
                    setStatus('Added.')
                  } catch (e) {
                    setStatus(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                Add
              </button>
            </div>
          )}
          {status === 'Added.' && boardId && (
            <p className="mt-2 text-xs text-[var(--text-soft)]">
              Added.{' '}
              <Link to={`/board/${boardId}`} className="text-[var(--accent)] hover:underline">
                Open the board
              </Link>
            </p>
          )}
        </div>
      )}
      {status && status !== 'Added.' && <p className="text-xs text-destructive">{status}</p>}
    </aside>
  )
}
