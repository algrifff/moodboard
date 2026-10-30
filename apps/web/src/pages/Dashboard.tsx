import type { BoardPreview, BoardSummary } from '@moodboard/shared'
import { Plus, Trash } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AppHeader } from '@/components/AppHeader'
import { ensureFontLoaded } from '@/components/canvas/FontNode'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ClientSwitcher } from '@/components/clients/ClientSwitcher'
import { createBoard, deleteBoard, listBoards, setBoardClient } from '@/lib/boardsApi'
import { resolveClientFilter, useClientFilter } from '@/lib/clientFilter'
import { useClients, useClientsStore } from '@/store/clients'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return date.toLocaleDateString()
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { clients, loaded: clientsLoaded } = useClients()
  const [filter, setFilter] = useClientFilter({ allowNone: true })
  const activeClient = resolveClientFilter(filter, clients)
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    listBoards()
      .then((b) => {
        if (!cancelled) setBoards(b)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const board = await createBoard(activeClient ? { clientId: activeClient.id } : {})
      navigate(`/board/${board.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this board? This cannot be undone.')) return
    await deleteBoard(id)
    setBoards((b) => (b ? b.filter((x) => x.id !== id) : b))
  }

  const handleAssign = async (id: string, clientId: string | null) => {
    const previous = boards
    setBoards((b) => (b ? b.map((x) => (x.id === id ? { ...x, clientId } : x)) : b))
    try {
      await setBoardClient(id, clientId)
      void useClientsStore.getState().load()
    } catch (e) {
      setBoards(previous)
      setError((e as Error).message)
    }
  }

  // A filter naming a client that no longer exists shows everything.
  const visible = useMemo(() => {
    if (!boards) return null
    if (filter.kind === 'none') return boards.filter((b) => b.clientId === null)
    if (activeClient) return boards.filter((b) => b.clientId === activeClient.id)
    return boards
  }, [boards, filter.kind, activeClient])

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="max-w-5xl mx-auto px-6 pt-6 pb-16">
        <div className="flex items-end justify-between mb-5">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {activeClient
                ? `${activeClient.name} boards`
                : filter.kind === 'none'
                  ? 'Unassigned boards'
                  : 'Team boards'}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Drop, group, and let the read come to you.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground pl-3 pr-3.5 py-2 text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,opacity]"
            style={{ borderRadius: 'var(--radius)' }}
          >
            <Plus size={14} weight="bold" />
            {creating ? 'Creating…' : 'New board'}
          </button>
        </div>

        {clientsLoaded && (
          <div className="mb-6">
            <ClientSwitcher
              clients={clients}
              filter={activeClient || filter.kind === 'none' ? filter : { kind: 'all' }}
              onChange={setFilter}
              allowNone
              counts={
                boards
                  ? {
                      all: boards.length,
                      none: boards.filter((b) => b.clientId === null).length,
                      byClient: (c) => boards.filter((b) => b.clientId === c.id).length,
                    }
                  : undefined
              }
            />
          </div>
        )}

        {error && <p className="text-sm text-destructive mb-4">Error: {error}</p>}
        {boards === null && !error && <DashboardSkeleton />}
        {boards && boards.length > 0 && visible && visible.length === 0 && (
          <div
            className="bg-card py-12 px-6 text-center"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <h3 className="text-base font-semibold text-foreground">
              {activeClient ? `No boards for ${activeClient.name} yet` : 'No unassigned boards'}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeClient
                ? 'Start one here, or assign an existing board from its card.'
                : 'Every board belongs to a client.'}
            </p>
            {activeClient && (
              <button
                type="button"
                onClick={handleCreate}
                className="inline-flex items-center gap-1.5 mt-5 bg-primary text-primary-foreground pl-3 pr-3.5 py-2 text-sm font-medium hover:brightness-110 transition-[filter]"
                style={{ borderRadius: 'var(--radius)' }}
              >
                <Plus size={14} weight="bold" />
                New {activeClient.name} board
              </button>
            )}
          </div>
        )}
        {boards && boards.length === 0 && (
          <div
            className="bg-card py-16 px-6 text-center"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <h3 className="text-lg font-semibold text-foreground">No boards yet</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-sm mx-auto">
              Start a board to drop in images, sticky notes, and PDFs. Group them on the canvas and
              see what Claude sees.
            </p>
            <button
              type="button"
              onClick={handleCreate}
              className="inline-flex items-center gap-1.5 mt-6 bg-primary text-primary-foreground pl-3 pr-3.5 py-2 text-sm font-medium hover:brightness-110 transition-[filter]"
              style={{ borderRadius: 'var(--radius)' }}
            >
              <Plus size={14} weight="bold" />
              Create your first board
            </button>
          </div>
        )}

        {visible && visible.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {visible.map((b) => (
              <li key={b.id} className="group relative">
                <Link
                  to={`/board/${b.id}`}
                  className="block bg-card p-4 hover:bg-[var(--bg-elevated)] transition-colors"
                  style={{ borderRadius: 'var(--radius-lg)' }}
                >
                  <BoardPreviewCard preview={b.preview} />
                  <p className="text-sm font-medium text-foreground truncate">{b.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Edited {formatWhen(b.updatedAt)}
                  </p>
                </Link>
                <div className="absolute bottom-3 right-3 w-[42%] opacity-80 transition-opacity focus-within:opacity-100 hover:opacity-100">
                  <ClientSelect
                    clients={clients}
                    value={b.clientId}
                    onChange={(clientId) => void handleAssign(b.id, clientId)}
                    noneLabel="Unassigned"
                    label={`Client for ${b.name}`}
                    className="w-full"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(b.id)}
                  className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive hover:bg-[var(--bg-elevated)] transition-[opacity,color,background-color]"
                  style={{ borderRadius: 'var(--radius)' }}
                  aria-label="Delete board"
                  title="Delete board"
                >
                  <Trash size={14} weight="regular" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

// Mini representation of a board's canvas. SVG so the viewBox handles the
// world-space → thumbnail-space scaling automatically. Empty boards fall
// back to the muted swatch (same look the dashboard had before previews).
function BoardPreviewCard({ preview }: { preview?: BoardPreview }) {
  if (!preview || !preview.bounds || preview.objects.length === 0) {
    return (
      <div
        className="aspect-[4/3] mb-3 bg-[var(--bg-muted)]"
        style={{ borderRadius: 'var(--radius)' }}
      />
    )
  }
  const { bounds, objects } = preview
  // Small breathing room around the bounding box so objects don't kiss the
  // card edge. 5% of the longest side.
  const pad = Math.max(bounds.w, bounds.h) * 0.05
  const vbX = bounds.x - pad
  const vbY = bounds.y - pad
  const vbW = bounds.w + pad * 2
  const vbH = bounds.h + pad * 2
  return (
    <div
      className="aspect-[4/3] mb-3 bg-[var(--bg-muted)] overflow-hidden"
      style={{ borderRadius: 'var(--radius)' }}
    >
      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full block"
        aria-hidden
      >
        {objects.map((o, i) => (
          <PreviewObject key={i} o={o} />
        ))}
      </svg>
    </div>
  )
}

function PreviewObject({ o }: { o: BoardPreview['objects'][number] }) {
  if (o.type === 'image' || o.type === 'pdf') {
    if (!o.thumbnailUrl) {
      // Image/PDF that hasn't finished uploading yet — fall back to a
      // neutral filled rect so the layout still reads.
      return <rect x={o.x} y={o.y} width={o.w} height={o.h} fill="var(--bg-elevated)" />
    }
    return (
      <image
        href={o.thumbnailUrl}
        x={o.x}
        y={o.y}
        width={o.w}
        height={o.h}
        preserveAspectRatio="xMidYMid slice"
      />
    )
  }
  if (o.type === 'sticky') {
    return <rect x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color ?? '#fde68a'} />
  }
  if (o.type === 'font') {
    return <FontPreviewCell o={o} />
  }
  // Text — render as a faint underline at the baseline. No content, no
  // height ratios; just enough to communicate "text is here".
  return (
    <rect
      x={o.x}
      y={o.y + o.h * 0.75}
      width={o.w * 0.85}
      height={Math.max(2, o.h * 0.06)}
      fill="var(--text-mute)"
      opacity={0.6}
    />
  )
}

// Renders a font specimen in the actual uploaded font. Loads the
// FontFace on mount (shared cache with FontNode — one fetch per family
// across the whole app) and falls back to a serif "Aa" until the load
// resolves. The dashboard only paints "Aa" rather than a full sentence
// because thumbnails are too small to read body copy.
function FontPreviewCell({ o }: { o: BoardPreview['objects'][number] }) {
  const family = o.family ?? 'Custom Font'
  const url = o.url
  const [loaded, setLoaded] = useState(() =>
    typeof document !== 'undefined' ? document.fonts.check(`16px "${family}"`) : false,
  )
  useEffect(() => {
    if (!url || loaded) return
    let cancelled = false
    ensureFontLoaded(family, url)
      .then(() => {
        if (!cancelled) setLoaded(true)
      })
      .catch(() => {
        // Quiet — fallback serif stays.
      })
    return () => {
      cancelled = true
    }
  }, [family, url, loaded])

  const aaSize = Math.min(o.w * 0.5, o.h * 0.7)
  const fontFamily = loaded
    ? `"${family}", ui-serif, Georgia, "Iowan Old Style", serif`
    : 'ui-serif, Georgia, "Iowan Old Style", serif'
  return (
    <g>
      <rect
        x={o.x}
        y={o.y}
        width={o.w}
        height={o.h}
        fill="var(--bg-card)"
        stroke="var(--border-soft)"
        strokeWidth={1}
      />
      <text
        x={o.x + o.w / 2}
        y={o.y + o.h / 2}
        fontFamily={fontFamily}
        fontSize={aaSize}
        fontWeight={500}
        fill="var(--text)"
        textAnchor="middle"
        dominantBaseline="central"
      >
        Aa
      </text>
    </g>
  )
}

function DashboardSkeleton() {
  // Three placeholder tiles matching the real card layout. Pulse subtly so
  // the page doesn't read as broken while the list is in flight.
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="bg-card p-4 animate-pulse"
          aria-hidden
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          <div
            className="aspect-[4/3] mb-3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
          <div
            className="h-3.5 w-2/3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
          <div
            className="mt-2 h-3 w-1/3 bg-[var(--bg-muted)]"
            style={{ borderRadius: 'var(--radius)' }}
          />
        </li>
      ))}
    </ul>
  )
}
