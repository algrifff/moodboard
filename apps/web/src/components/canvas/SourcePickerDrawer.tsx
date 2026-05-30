import type { ConnectionSummary, NotionPageData, PickerTile } from '@moodboard/shared'
import { CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  importNotionPage,
  listChildPages,
  listRecents,
  searchConnection,
} from '@/lib/connectionsApi'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { createNotionPage } from '@/lib/objectFactory'
import { screenToWorld } from '@/lib/transform'
import { useCanvasStore } from '@/store/canvas'
import { useSourcePickerStore } from '@/store/sourcePicker'

// ---------------------------------------------------------------------------
// Left-side drawer mirroring the right-side AIAnalysisPanel FullscreenDrawer
// (apps/web/src/components/canvas/AIAnalysisPanel.tsx:638).
//
// Layout:
//   ┌─ Drawer ──────────────────────────────────┐
//   │ Sources                            [✕]    │
//   │ ┌──────────────────────────────────────┐  │
//   │ │ 🔍 Search across {connection}        │  │
//   │ └──────────────────────────────────────┘  │
//   │ [Notion]  [Recents]                       │
//   │ ── Recent ─────────────────────────────── │
//   │ tile grid (4 col responsive)              │
//   │ ── All ───────────────────────────────── │
//   │ infinite-scroll tile grid                 │
//   └────── notion · alex@… ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
//
// Tabs auto-derive from active connections + a permanent Recents tab. If
// the user has no connections yet, the body switches to a connect CTA card.
// ---------------------------------------------------------------------------

const DRAWER_WIDTH = 'min(720px, max(480px, 50vw))'

export function SourcePickerDrawer({ onConnectNotion }: { onConnectNotion: () => void }) {
  const open = useSourcePickerStore((s) => s.open)
  const closePicker = useSourcePickerStore((s) => s.closePicker)
  const connections = useSourcePickerStore((s) => s.connections)
  const loadingConnections = useSourcePickerStore((s) => s.loadingConnections)

  return (
    <>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                key="source-picker-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT_STANDARD }}
                onClick={closePicker}
                style={{
                  position: 'fixed',
                  inset: 0,
                  backgroundColor: 'var(--scrim)',
                  zIndex: 79,
                  pointerEvents: 'auto',
                }}
                aria-hidden
              />
            )}
            {open && (
              <DrawerContent
                key="source-picker-drawer"
                connections={connections}
                loadingConnections={loadingConnections}
                onConnectNotion={onConnectNotion}
                onClose={closePicker}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  )
}

function DrawerContent({
  connections,
  loadingConnections,
  onConnectNotion,
  onClose,
}: {
  connections: ConnectionSummary[]
  loadingConnections: boolean
  onConnectNotion: () => void
  onClose: () => void
}) {
  // Tab IDs: 'recents' | connectionId. Default to the first connection
  // (most-recently-created) or recents if there are no connections.
  const [tab, setTab] = useState<string>(connections[0]?.id ?? 'recents')

  // If connections load after mount, default into the first one.
  useEffect(() => {
    if (tab === 'recents' && connections[0]) setTab(connections[0].id)
  }, [connections, tab])

  // Escape closes the drawer — same affordance as the modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <motion.div
      data-canvas-scrollable
      initial={{ x: '-100%' }}
      animate={{ x: 0 }}
      exit={{ x: '-100%' }}
      transition={{ duration: 0.32, ease: EASE_OUT_STANDARD }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        width: DRAWER_WIDTH,
        backgroundColor: 'var(--bg-card)',
        boxShadow: 'var(--shadow-drawer)',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      <Header onClose={onClose} />
      {connections.length === 0 ? (
        <EmptyConnectionsState loading={loadingConnections} onConnectNotion={onConnectNotion} />
      ) : (
        <>
          <Tabs connections={connections} tab={tab} onSelect={setTab} />
          <ActivePanel key={tab} tab={tab} connections={connections} onClose={onClose} />
        </>
      )}
    </motion.div>
  )
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="flex items-center justify-between gap-2"
      style={{
        padding: '14px 18px',
        borderBottom: '1px solid var(--border-soft)',
      }}
    >
      <span className="text-[12.5px] uppercase tracking-[0.12em] text-[var(--text-mute)]">
        Sources
      </span>
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center justify-center text-[var(--text-mute)] hover:text-foreground transition-colors"
        style={{ width: 28, height: 28, borderRadius: 999 }}
        aria-label="Close source picker"
        title="Close (Esc)"
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  )
}

function EmptyConnectionsState({
  loading,
  onConnectNotion,
}: {
  loading: boolean
  onConnectNotion: () => void
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-4">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <MagnifyingGlass size={28} weight="duotone" />
      </div>
      <div className="space-y-1">
        <div className="text-base font-semibold text-foreground">No sources connected yet</div>
        <div className="text-[13px] text-[var(--text-faint)] max-w-[40ch]">
          Connect a workspace to pull pages and files onto the canvas alongside your visual
          references.
        </div>
      </div>
      <button
        type="button"
        onClick={onConnectNotion}
        disabled={loading}
        className="px-4 py-2 text-sm font-medium bg-foreground text-[var(--bg-card)] hover:opacity-90 disabled:opacity-40 transition-opacity"
        style={{ borderRadius: 'var(--radius)' }}
      >
        Connect Notion workspace →
      </button>
    </div>
  )
}

function Tabs({
  connections,
  tab,
  onSelect,
}: {
  connections: ConnectionSummary[]
  tab: string
  onSelect: (id: string) => void
}) {
  return (
    <div
      className="flex items-center gap-1 px-4 pt-3 pb-2 overflow-x-auto"
      style={{ borderBottom: '1px solid var(--border-soft)' }}
    >
      {connections.map((c) => (
        <TabButton
          key={c.id}
          active={tab === c.id}
          onClick={() => onSelect(c.id)}
          label={providerLabel(c.provider)}
          sublabel={c.accountEmail}
        />
      ))}
      <TabButton active={tab === 'recents'} onClick={() => onSelect('recents')} label="Recents" />
    </div>
  )
}

function providerLabel(p: 'notion' | 'drive') {
  return p === 'notion' ? 'Notion' : 'Drive'
}

function TabButton({
  active,
  onClick,
  label,
  sublabel,
}: {
  active: boolean
  onClick: () => void
  label: string
  sublabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium transition-colors"
      style={{
        borderRadius: 'var(--radius)',
        backgroundColor: active ? 'var(--bg-elevated)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-mute)',
      }}
    >
      <span>{label}</span>
      {sublabel && (
        <span className="text-[11px] text-[var(--text-faint)] truncate max-w-[16ch]">
          {sublabel}
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Active panel — search input + tile list.
//
// Two layout decisions:
//   1. Vertical list (not grid) — makes tree expansion read naturally. Tile
//      indentation maps to "sub-page of" without fighting a grid.
//   2. Tree expansion + infinite scroll live here. Tile state is cumulative
//      (append on cursor) and `expandedChildren` holds per-tile sub-page
//      lists. The expand chevron fires `listChildPages`; the IntersectionObserver
//      sentinel at the bottom fires the next `searchConnection` call.
//
// Tab is `key`-remounted by the parent, so changing connection / Recents
// fully resets state — no stale tiles from another connection ever leak.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

function ActivePanel({
  tab,
  connections,
  onClose,
}: {
  tab: string
  connections: ConnectionSummary[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  // Cumulative result list. Replaced when query / tab changes; appended when
  // the sentinel fires.
  const [tiles, setTiles] = useState<PickerTile[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadingInitial, setLoadingInitial] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  // Tree expansion — per-tile children + in-flight markers.
  const [expandedChildren, setExpandedChildren] = useState<Record<string, PickerTile[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(() => new Set())
  // requestSeq guards out-of-order resolutions from a fast typer.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSeq = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const activeConnection = useMemo(() => {
    if (tab === 'recents') return null
    return connections.find((c) => c.id === tab) ?? null
  }, [tab, connections])

  // Run the initial query when tab / query changes. Replaces tiles + cursor.
  useEffect(() => {
    const seq = ++requestSeq.current
    setError(null)
    setExpandedChildren({})
    setLoadingChildren(new Set())

    if (tab === 'recents') {
      setLoadingInitial(true)
      Promise.all(connections.map((c) => listRecents(c.id)))
        .then((all) => {
          if (seq !== requestSeq.current) return
          const flat = all.flat().sort((a, b) => {
            const ta = a.lastEditedAt ? Date.parse(a.lastEditedAt) : 0
            const tb = b.lastEditedAt ? Date.parse(b.lastEditedAt) : 0
            return tb - ta
          })
          setTiles(flat)
          setNextCursor(undefined)
        })
        .catch((e: Error) => {
          if (seq !== requestSeq.current) return
          setError(e.message)
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoadingInitial(false)
        })
      return
    }

    if (!activeConnection) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    setLoadingInitial(true)
    debounceTimer.current = setTimeout(() => {
      const localSeq = seq
      searchConnection(activeConnection.id, query)
        .then((res) => {
          if (localSeq !== requestSeq.current) return
          setTiles(res.tiles)
          setNextCursor(res.nextCursor)
        })
        .catch((e: Error) => {
          if (localSeq !== requestSeq.current) return
          setError(e.message)
        })
        .finally(() => {
          if (localSeq === requestSeq.current) setLoadingInitial(false)
        })
    }, 240)

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [tab, query, activeConnection, connections])

  // Infinite scroll — IntersectionObserver on the sentinel. When it crosses
  // the viewport we fetch the next page using the saved cursor and append.
  const loadMore = useCallback(() => {
    if (!activeConnection || !nextCursor || loadingMore || loadingInitial) return
    const seq = requestSeq.current
    setLoadingMore(true)
    searchConnection(activeConnection.id, query, nextCursor)
      .then((res) => {
        if (seq !== requestSeq.current) return
        setTiles((prev) => [...prev, ...res.tiles])
        setNextCursor(res.nextCursor)
      })
      .catch((e: Error) => {
        if (seq !== requestSeq.current) return
        setError(e.message)
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoadingMore(false)
      })
  }, [activeConnection, nextCursor, loadingMore, loadingInitial, query])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { rootMargin: '200px' },
    )
    io.observe(node)
    return () => io.disconnect()
  }, [loadMore])

  const onImport = async (tile: PickerTile) => {
    if (importingId) return
    setImportingId(tile.id)
    try {
      if (tile.provider === 'notion') {
        const data = await importNotionPage(tile.connectionId, tile.id)
        spawnNotionAtViewportCenter(data)
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImportingId(null)
    }
  }

  // Toggle tree expansion. First open fetches children; subsequent toggles
  // are local. Closed state keeps the cached children so a re-open is free.
  const onToggleExpand = useCallback(
    async (tile: PickerTile) => {
      const key = `${tile.connectionId}:${tile.id}`
      if (expandedChildren[key]) {
        setExpandedChildren((m) => {
          const next = { ...m }
          delete next[key]
          return next
        })
        return
      }
      if (loadingChildren.has(key)) return
      setLoadingChildren((s) => new Set(s).add(key))
      try {
        const children = await listChildPages(tile.connectionId, tile.id)
        setExpandedChildren((m) => ({ ...m, [key]: children }))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load sub-pages')
      } finally {
        setLoadingChildren((s) => {
          const next = new Set(s)
          next.delete(key)
          return next
        })
      }
    },
    [expandedChildren, loadingChildren],
  )

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {tab !== 'recents' && (
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-soft)' }}>
          <div className="relative">
            <MagnifyingGlass
              size={16}
              weight="regular"
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
              }}
            />
            <input
              type="search"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${providerLabel(activeConnection?.provider ?? 'notion')}…`}
              className="w-full text-[14px] outline-none transition-colors"
              style={{
                padding: '8px 12px 8px 32px',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text)',
                border: '1px solid transparent',
              }}
            />
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {error && <div className="text-[13px] text-destructive px-2 py-1 mb-2">{error}</div>}
        {loadingInitial && tiles.length === 0 && <TileSkeletonList />}
        {!loadingInitial && tiles.length === 0 && (
          <div className="text-[13px] text-[var(--text-faint)] text-center py-12">
            {tab === 'recents'
              ? 'Nothing here yet. Add a page from the search to start a recents list.'
              : query.length > 0
                ? `Nothing matched "${query}".`
                : 'Search results will appear here.'}
          </div>
        )}
        {tiles.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {tiles.map((t) => (
              <TileRow
                key={`${t.connectionId}:${t.id}`}
                tile={t}
                depth={0}
                onImport={onImport}
                onToggleExpand={onToggleExpand}
                expandedChildren={expandedChildren}
                loadingChildren={loadingChildren}
                importingId={importingId}
              />
            ))}
          </div>
        )}
        {/* Sentinel — when this enters the viewport we fetch the next page. */}
        {nextCursor && tab !== 'recents' && (
          <div ref={sentinelRef} className="text-center text-[11px] text-[var(--text-faint)] py-4">
            {loadingMore ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </div>
  )
}

function TileSkeletonList() {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 36,
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-elevated)',
            animation: 'mb-shimmer 1.2s ease-in-out infinite',
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One row in the tree. Recursive — its expanded children render via the
// same component at depth + 1. Depth indents 16px each level. The expand
// chevron rotates 90° when open.
// ---------------------------------------------------------------------------

function TileRow({
  tile,
  depth,
  onImport,
  onToggleExpand,
  expandedChildren,
  loadingChildren,
  importingId,
}: {
  tile: PickerTile
  depth: number
  // Takes a tile arg so the recursive sub-rows call it with their own tile.
  onImport: (tile: PickerTile) => void
  onToggleExpand: (tile: PickerTile) => void
  expandedChildren: Record<string, PickerTile[]>
  loadingChildren: Set<string>
  importingId: string | null
}) {
  const key = `${tile.connectionId}:${tile.id}`
  const children = expandedChildren[key]
  const isExpanded = !!children
  const isLoadingChildren = loadingChildren.has(key)
  const importing = importingId === tile.id

  return (
    <>
      <div
        className="flex items-center gap-1 group transition-colors"
        style={{
          paddingLeft: 8 + depth * 16,
          paddingRight: 8,
          paddingTop: 6,
          paddingBottom: 6,
          borderRadius: 'var(--radius)',
          minHeight: 36,
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand(tile)
          }}
          disabled={isLoadingChildren}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          className="inline-flex items-center justify-center transition-colors disabled:opacity-40"
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            color: 'var(--text-faint)',
            flexShrink: 0,
          }}
        >
          <CaretRight
            size={11}
            weight="bold"
            style={{
              transform: isExpanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              animation: isLoadingChildren ? 'mb-spin 800ms linear infinite' : 'none',
            }}
          />
        </button>
        <motion.button
          type="button"
          onClick={() => onImport(tile)}
          disabled={importing || importingId !== null}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.1, ease: [0.2, 0.8, 0.2, 1] }}
          className="flex-1 min-w-0 flex items-center gap-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
          style={{
            padding: '4px 8px',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            cursor: importing ? 'wait' : 'pointer',
            opacity: importing ? 0.6 : 1,
          }}
        >
          <TileIcon tile={tile} />
          <div className="flex-1 min-w-0 truncate text-[13px] font-medium leading-tight">
            {tile.title || 'Untitled'}
          </div>
          {tile.lastEditedAt && (
            <div className="text-[10.5px] text-[var(--text-faint)] flex-shrink-0">
              {relativeTime(tile.lastEditedAt)}
            </div>
          )}
        </motion.button>
      </div>
      {isExpanded && children.length === 0 && (
        <div
          className="text-[11px] text-[var(--text-faint)] italic"
          style={{ paddingLeft: 8 + (depth + 1) * 16 + 18 + 8, paddingTop: 2, paddingBottom: 4 }}
        >
          No sub-pages
        </div>
      )}
      {isExpanded &&
        children.map((c) => (
          <TileRow
            key={`${c.connectionId}:${c.id}`}
            tile={c}
            depth={depth + 1}
            onImport={onImport}
            onToggleExpand={onToggleExpand}
            expandedChildren={expandedChildren}
            loadingChildren={loadingChildren}
            importingId={importingId}
          />
        ))}
    </>
  )
}

function TileIcon({ tile }: { tile: PickerTile }) {
  if (tile.iconEmoji) {
    return (
      <div className="text-[14px] leading-none w-4 h-4 flex items-center justify-center flex-shrink-0">
        {tile.iconEmoji}
      </div>
    )
  }
  if (tile.iconUrl) {
    return (
      <img
        src={tile.iconUrl}
        alt=""
        className="w-4 h-4 object-contain flex-shrink-0"
        style={{ borderRadius: 3 }}
        loading="lazy"
      />
    )
  }
  // Default page glyph — keep the alignment column even when no icon.
  return (
    <div
      className="w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-semibold flex-shrink-0"
      style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-faint)' }}
    >
      ◌
    </div>
  )
}

// "2d ago" / "5h ago" / "just now" — coarse, sufficient for tile subtext.
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// ---------------------------------------------------------------------------
// Spawn helper. The new node lands at the centre of whatever the user is
// currently looking at — same convention as the toolbar add buttons. The
// canvas store's autosave hook persists the change.
// ---------------------------------------------------------------------------
function spawnNotionAtViewportCenter(data: NotionPageData) {
  const { scale, offset, viewportSize, objects, addObject, commitBeforeAction } =
    useCanvasStore.getState()
  const center = screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
  commitBeforeAction()
  addObject(createNotionPage(center, objects.length, data))
}
