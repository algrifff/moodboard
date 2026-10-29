import type {
  ConnectionSummary,
  DriveFileData,
  DriveFolderData,
  ImageData,
  PDFData,
  PickerTile,
} from '@moodboard/shared'
import { CaretRight, CheckCircle, MagnifyingGlass, Plus, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteConnection,
  importDriveFile,
  importSpotifyRef,
  type SpotifyImportResult,
  listChildPages,
  listRecents,
  searchConnection,
} from '@/lib/connectionsApi'
import { EASE_OUT_QUICK, EASE_OUT_STANDARD } from '@/lib/motion'
import {
  createDriveFile,
  createDriveFolder,
  createSpotifyAlbum,
  createSpotifyPlaylist,
  createSpotifyTrack,
} from '@/lib/objectFactory'
import { screenToWorld } from '@moodboard/shared'
import { useCanvasStore } from '@/store/canvas'
import { useSourcePickerStore } from '@/store/sourcePicker'
import { DriveLogo, SpotifyLogo } from './sourceLogos'
import { showToast } from './Toast'

// ---------------------------------------------------------------------------
// Left-side drawer mirroring the right-side AIAnalysisPanel FullscreenDrawer
// (apps/web/src/components/canvas/AIAnalysisPanel.tsx:638).
//
// Structure (extensible — adding a new provider needs no UI changes here):
//
//   ┌─ Drawer ──────────────────────────────────┐
//   │ Sources                            [✕]    │
//   │ [🔍 Search across all sources           ] │
//   │                                            │
//   │ ┌─ + SOURCES ────────────────────────────┐│
//   │ │ [G] Google Drive        ✓ Connected   ││
//   │ │     1 connected · add another          ││
//   │ │ [S] Spotify                            ││
//   │ │     Connect                            ││
//   │ └────────────────────────────────────────┘│
//   │                                            │
//   │  Recently added                            │
//   │  · Brand Bible                       2d   │
//   │  · Q4 strategy                       5d   │
//   │                                            │
//   │  Google Drive · alex@gmail.com    [—]      │
//   │  📁 Brand Assets                           │
//   │  📄 Brand Doc                              │
//   └────────────────────────────────────────────┘
//
// Each connection is its own collapsible section that owns its tile/cursor/
// expand state. Add Source sits at the top so adding a new workspace is
// always one click away. Recents lives between Add Source and the
// per-connection sections. When the user has no connections the body
// switches to a centred empty state with the same provider chips.
// ---------------------------------------------------------------------------

const DRAWER_WIDTH = 'min(720px, max(480px, 50vw))'

type ConnectProps = {
  onConnectDrive: () => void
  onConnectSpotify: () => void
}

export function SourcePickerDrawer({ onConnectDrive, onConnectSpotify }: ConnectProps) {
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
                onConnectDrive={onConnectDrive}
                onConnectSpotify={onConnectSpotify}
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
  onConnectDrive,
  onConnectSpotify,
  onClose,
}: {
  connections: ConnectionSummary[]
  loadingConnections: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
  onClose: () => void
}) {
  // Global search query — fans out to every connection section. Empty
  // string hides per-section searches and shows the Recents block.
  const [query, setQuery] = useState('')
  const [importingId, setImportingId] = useState<string | null>(null)

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

  const onImport = useCallback(
    async (tile: PickerTile) => {
      if (importingId) return
      setImportingId(tile.id)
      // Immediate toast so the user has feedback while the upstream call
      // is in flight. Spotify playlists in particular pull metadata +
      // audio features + artists in parallel — can take a few seconds.
      const provider = tile.provider
      const inFlightLabel =
        provider === 'spotify'
          ? tile.spotifyKind === 'track'
            ? `Reading "${tile.title || 'track'}" — pulling audio features + genres…`
            : `Reading "${tile.title || 'playlist'}" — pulling audio features, genres, era…`
          : `Importing "${tile.title || 'item'}"…`
      showToast(inFlightLabel)
      try {
        if (provider === 'drive') {
          const result = await importDriveFile(tile.connectionId, tile.id)
          spawnDriveAtViewportCenter(result)
        } else if (provider === 'spotify') {
          // The tile carries its Spotify kind — playlists come from
          // browsing /me/playlists, tracks from catalog search. Default to
          // playlist for back-compat with any tile that predates the field.
          const result = await importSpotifyRef(tile.connectionId, {
            kind: tile.spotifyKind ?? 'playlist',
            id: tile.id,
          })
          spawnSpotifyAtViewportCenter(result)
        }
        onClose()
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error'
        console.warn('[picker] import failed', { provider, id: tile.id, error: e })
        showToast(`${provider} import failed: ${msg}`)
      } finally {
        setImportingId(null)
      }
    },
    [importingId, onClose],
  )

  const onDisconnect = useCallback(async (connectionId: string) => {
    try {
      await deleteConnection(connectionId)
      await useSourcePickerStore.getState().refreshConnections()
    } catch (e) {
      console.error('Disconnect failed', e)
    }
  }, [])

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
        <EmptySourcesState
          loading={loadingConnections}
          onConnectDrive={onConnectDrive}
          onConnectSpotify={onConnectSpotify}
        />
      ) : (
        <>
          <SearchBar query={query} onChange={setQuery} />
          <div className="flex-1 overflow-y-auto px-3 pb-3">
            <AddSourceSection
              connections={connections}
              loading={loadingConnections}
              onConnectDrive={onConnectDrive}
              onConnectSpotify={onConnectSpotify}
            />
            {!query && (
              <RecentsSection
                connections={connections}
                onImport={onImport}
                importingId={importingId}
              />
            )}
            {connections.map((c) => (
              <ConnectionSection
                key={c.id}
                connection={c}
                query={query}
                onImport={onImport}
                onDisconnect={() => onDisconnect(c.id)}
                importingId={importingId}
              />
            ))}
          </div>
        </>
      )}
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Header + global search
// ---------------------------------------------------------------------------

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

function SearchBar({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  return (
    <div style={{ padding: '12px 18px 10px', borderBottom: '1px solid var(--border-soft)' }}>
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
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search across all sources…"
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
  )
}

// ---------------------------------------------------------------------------
// Empty state — no connections yet. Centred hero with both providers.
// ---------------------------------------------------------------------------

function EmptySourcesState({
  loading,
  onConnectDrive,
  onConnectSpotify,
}: {
  loading: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
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
      <div className="flex flex-col gap-2 w-full max-w-[280px]">
        <ConnectProviderButton
          provider="drive"
          connectedCount={0}
          onClick={onConnectDrive}
          disabled={loading}
        />
        <ConnectProviderButton
          provider="spotify"
          connectedCount={0}
          onClick={onConnectSpotify}
          disabled={loading}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recents — across-connection recently imported items.
// ---------------------------------------------------------------------------

function RecentsSection({
  connections,
  onImport,
  importingId,
}: {
  connections: ConnectionSummary[]
  onImport: (tile: PickerTile) => void
  importingId: string | null
}) {
  const [tiles, setTiles] = useState<PickerTile[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const s = ++seq.current
    setLoading(true)
    Promise.all(connections.map((c) => listRecents(c.id)))
      .then((all) => {
        if (s !== seq.current) return
        const flat = all.flat().sort((a, b) => {
          const ta = a.lastEditedAt ? Date.parse(a.lastEditedAt) : 0
          const tb = b.lastEditedAt ? Date.parse(b.lastEditedAt) : 0
          return tb - ta
        })
        setTiles(flat)
      })
      .catch(() => {
        // Best-effort — leave previous tiles in place.
      })
      .finally(() => {
        if (s === seq.current) setLoading(false)
      })
  }, [connections])

  // No recents and no connection? The empty state takes over. With at
  // least one connection but no recents we still show a tidy "nothing yet"
  // so the structure stays consistent.
  return (
    <Section title="Recently added">
      {loading && tiles.length === 0 ? (
        <TileSkeletonList rows={3} />
      ) : tiles.length === 0 ? (
        <EmptyHint text="Nothing here yet. Import from a source below to start." />
      ) : (
        <div className="flex flex-col gap-0.5">
          {tiles.slice(0, 8).map((t) => (
            <TileRow
              key={`recents:${t.connectionId}:${t.id}`}
              tile={t}
              depth={0}
              onImport={onImport}
              onToggleExpand={() => {}}
              expandedChildren={{}}
              loadingChildren={NO_LOADING}
              importingId={importingId}
              canExpand={false}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

const NO_LOADING = new Set<string>()

// ---------------------------------------------------------------------------
// ConnectionSection — per-connection collapsible block with its own state.
// Search query, tiles cursor, infinite-scroll sentinel, expand tree all
// live here. Re-mounting on connection change resets cleanly.
// ---------------------------------------------------------------------------

function ConnectionSection({
  connection,
  query,
  onImport,
  onDisconnect,
  importingId,
}: {
  connection: ConnectionSummary
  query: string
  onImport: (tile: PickerTile) => void
  onDisconnect: () => void
  importingId: string | null
}) {
  // Default: collapsed. With several connections + recents up top, an
  // all-expanded view buries the connection list under hundreds of tiles
  // — the user wanted to see what's connected first, then drill in.
  // A non-empty search query overrides this so results stay visible
  // across every connection at once.
  const [userCollapsed, setUserCollapsed] = useState(true)
  const collapsed = query.length === 0 ? userCollapsed : false
  const [tiles, setTiles] = useState<PickerTile[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [loadingInitial, setLoadingInitial] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedChildren, setExpandedChildren] = useState<Record<string, PickerTile[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(() => new Set())
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // On first mount we skip the debounce — there's no typing to coalesce
  // yet, and waiting 240ms after a freshly-connected provider just looks
  // like "nothing happened" until the user gives up. After the first run
  // we debounce normally for query changes.
  const hasMounted = useRef(false)

  // Reset clean when the global query changes. Debounced 240ms so typing
  // doesn't hammer upstream APIs. Empty query loads the most recent items.
  useEffect(() => {
    const s = ++seq.current
    setError(null)
    setExpandedChildren({})
    setLoadingChildren(new Set())
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    setLoadingInitial(true)
    const delay = hasMounted.current ? 240 : 0
    hasMounted.current = true
    debounceTimer.current = setTimeout(() => {
      searchConnection(connection.id, query)
        .then((res) => {
          if (s !== seq.current) return
          setTiles(res.tiles)
          setNextCursor(res.nextCursor)
        })
        .catch((e: Error) => {
          if (s !== seq.current) return
          setError(e.message)
        })
        .finally(() => {
          if (s === seq.current) setLoadingInitial(false)
        })
    }, delay)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [connection.id, query])

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || loadingInitial) return
    const s = seq.current
    setLoadingMore(true)
    searchConnection(connection.id, query, nextCursor)
      .then((res) => {
        if (s !== seq.current) return
        setTiles((prev) => [...prev, ...res.tiles])
        setNextCursor(res.nextCursor)
      })
      .catch((e: Error) => {
        if (s !== seq.current) return
        setError(e.message)
      })
      .finally(() => {
        if (s === seq.current) setLoadingMore(false)
      })
  }, [connection.id, query, nextCursor, loadingMore, loadingInitial])

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

  // Tree expansion: drive folders (kind === 'folder').
  // The TileRow takes a `canExpand` prop; collapse decisions live there but
  // toggling happens through this section's handler.
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
      setLoadingChildren((ls) => new Set(ls).add(key))
      try {
        const children = await listChildPages(tile.connectionId, tile.id)
        setExpandedChildren((m) => ({ ...m, [key]: children }))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load children')
      } finally {
        setLoadingChildren((ls) => {
          const next = new Set(ls)
          next.delete(key)
          return next
        })
      }
    },
    [expandedChildren, loadingChildren],
  )

  const handleDisconnectClick = () => {
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true)
      // Auto-cancel the confirmation after 4s so a stray click doesn't
      // leave the button armed.
      setTimeout(() => setConfirmingDisconnect(false), 4000)
      return
    }
    onDisconnect()
  }

  return (
    <Section
      title={
        <ConnectionHeader
          provider={connection.provider}
          email={connection.accountEmail}
          confirming={confirmingDisconnect}
          onDisconnect={handleDisconnectClick}
          collapsed={collapsed}
          onToggleCollapse={() => setUserCollapsed((v) => !v)}
        />
      }
    >
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT_QUICK }}
            style={{ overflow: 'hidden' }}
          >
            {error && <div className="text-[12px] text-destructive px-2 py-1 mb-1">{error}</div>}
            {loadingInitial && tiles.length === 0 ? (
              <TileSkeletonList rows={4} />
            ) : tiles.length === 0 ? (
              <EmptyHint
                text={query.length > 0 ? `Nothing matched "${query}".` : 'No items here yet.'}
              />
            ) : (
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
                    canExpand={canExpandTile(t)}
                  />
                ))}
              </div>
            )}
            {nextCursor && (
              <div
                ref={sentinelRef}
                className="text-center text-[10.5px] text-[var(--text-faint)] py-2"
              >
                {loadingMore ? 'Loading more…' : 'Scroll for more'}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  )
}

function canExpandTile(tile: PickerTile): boolean {
  if (tile.provider === 'drive' && tile.kind === 'folder') return true
  return false
}

function ConnectionHeader({
  provider,
  email,
  confirming,
  onDisconnect,
  collapsed,
  onToggleCollapse,
}: {
  provider: 'drive' | 'spotify'
  email: string
  confirming: boolean
  onDisconnect: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const label = provider === 'drive' ? 'Google Drive' : 'Spotify'
  return (
    <div className="flex items-center gap-2 w-full">
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        className="inline-flex items-center justify-center text-[var(--text-faint)] hover:text-foreground transition-colors"
        style={{ width: 14, height: 14, flexShrink: 0 }}
      >
        <CaretRight
          size={10}
          weight="bold"
          style={{
            transform: collapsed ? 'none' : 'rotate(90deg)',
            transition: 'transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        />
      </button>
      <ProviderGlyph provider={provider} />
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text)]">
        {label}
      </span>
      <span className="text-[11px] text-[var(--text-faint)] truncate flex-1">{email}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDisconnect()
        }}
        className="inline-flex items-center gap-1 transition-colors"
        style={{
          padding: '2px 6px',
          borderRadius: 'var(--radius)',
          color: confirming ? 'var(--destructive)' : 'var(--text-faint)',
          backgroundColor: confirming ? 'var(--accent-fade)' : 'transparent',
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
        title={confirming ? 'Click again to confirm' : 'Disconnect this source'}
      >
        <Trash size={10} weight="bold" />
        {confirming ? 'Confirm' : 'Disconnect'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add another source — always-visible. New providers slot in by appending
// to the chip list.
// ---------------------------------------------------------------------------

function AddSourceSection({
  connections,
  loading,
  onConnectDrive,
  onConnectSpotify,
}: {
  connections: ConnectionSummary[]
  loading: boolean
  onConnectDrive: () => void
  onConnectSpotify: () => void
}) {
  const driveCount = connections.filter((c) => c.provider === 'drive').length
  const spotifyCount = connections.filter((c) => c.provider === 'spotify').length

  return (
    <div
      className="mt-2 mb-3"
      style={{
        padding: '12px',
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-soft)',
      }}
    >
      <div className="flex items-center gap-1.5 mb-2.5 px-0.5">
        <Plus size={11} weight="bold" style={{ color: 'var(--text-mute)' }} />
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
          Sources
        </span>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <ConnectProviderButton
          provider="drive"
          connectedCount={driveCount}
          onClick={onConnectDrive}
          disabled={loading}
        />
        <ConnectProviderButton
          provider="spotify"
          connectedCount={spotifyCount}
          onClick={onConnectSpotify}
          disabled={loading}
        />
      </div>
    </div>
  )
}

// Provider connect button. When the user already has at least one
// connection for this provider, the button label switches to "Add
// another" and a small accent checkmark indicates the connected state —
// extra accounts are first-class (Google allows multiple accounts).
function ConnectProviderButton({
  provider,
  connectedCount,
  onClick,
  disabled,
}: {
  provider: 'drive' | 'spotify'
  connectedCount: number
  onClick: () => void
  disabled?: boolean
}) {
  const label = provider === 'drive' ? 'Google Drive' : 'Spotify'
  const isConnected = connectedCount > 0
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.1, ease: [0.2, 0.8, 0.2, 1] }}
      className="inline-flex items-center gap-2 text-left transition-colors disabled:opacity-40 hover:bg-[var(--bg-card)]"
      style={{
        padding: '9px 12px',
        borderRadius: 'var(--radius)',
        backgroundColor: 'var(--bg-card)',
        color: 'var(--text)',
        border: '1px solid var(--border-soft)',
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      <ProviderGlyph provider={provider} size={18} />
      <div className="flex flex-col items-start flex-1 min-w-0">
        <span className="text-[12.5px] font-semibold leading-tight truncate w-full">{label}</span>
        <span className="text-[10px] text-[var(--text-faint)] leading-tight truncate w-full">
          {isConnected
            ? connectedCount === 1
              ? 'Connected · add another'
              : `${connectedCount} connected · add another`
            : 'Connect'}
        </span>
      </div>
      {isConnected && (
        <CheckCircle
          size={13}
          weight="fill"
          style={{ color: 'var(--accent)', flexShrink: 0 }}
          aria-label="Connected"
        />
      )}
    </motion.button>
  )
}

function ProviderGlyph({ provider, size = 14 }: { provider: 'drive' | 'spotify'; size?: number }) {
  if (provider === 'drive') return <DriveLogo size={size} />
  return <SpotifyLogo size={size} />
}

// ---------------------------------------------------------------------------
// Tiny presentational primitives reused across sections.
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3 first:mt-2">
      <div
        className="flex items-center gap-2 px-2 pb-1.5"
        style={{ borderBottom: '1px solid var(--border-soft)' }}
      >
        {typeof title === 'string' ? (
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--text-mute)] font-semibold">
            {title}
          </span>
        ) : (
          title
        )}
      </div>
      <div className="pt-1">{children}</div>
    </section>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-[12px] text-[var(--text-faint)] text-center py-3 italic">{text}</div>
}

function TileSkeletonList({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 30,
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
// Tree row — same recursive component used by every section. Decoupled from
// where it sits (recents vs a connection's own tree) via the `canExpand` +
// callbacks.
// ---------------------------------------------------------------------------

function TileRow({
  tile,
  depth,
  onImport,
  onToggleExpand,
  expandedChildren,
  loadingChildren,
  importingId,
  canExpand,
}: {
  tile: PickerTile
  depth: number
  onImport: (tile: PickerTile) => void
  onToggleExpand: (tile: PickerTile) => void
  expandedChildren: Record<string, PickerTile[]>
  loadingChildren: Set<string>
  importingId: string | null
  canExpand: boolean
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
          paddingTop: 5,
          paddingBottom: 5,
          borderRadius: 'var(--radius)',
          minHeight: 32,
        }}
      >
        {canExpand ? (
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
              width: 16,
              height: 16,
              borderRadius: 4,
              color: 'var(--text-faint)',
              flexShrink: 0,
            }}
          >
            <CaretRight
              size={10}
              weight="bold"
              style={{
                transform: isExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
                animation: isLoadingChildren ? 'mb-spin 800ms linear infinite' : 'none',
              }}
            />
          </button>
        ) : (
          <div style={{ width: 16, height: 16, flexShrink: 0 }} />
        )}
        <motion.button
          type="button"
          onClick={() => onImport(tile)}
          disabled={importing || importingId !== null}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.1, ease: [0.2, 0.8, 0.2, 1] }}
          className="flex-1 min-w-0 flex items-center gap-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            cursor: importing ? 'wait' : 'pointer',
            opacity: importing ? 0.6 : 1,
          }}
        >
          <TileIcon tile={tile} />
          <div className="flex-1 min-w-0">
            <div className="truncate text-[12.5px] font-medium leading-tight">
              {tile.title || 'Untitled'}
            </div>
            {tile.subtitle && (
              <div className="truncate text-[10.5px] leading-tight text-[var(--text-faint)] mt-0.5">
                {tile.subtitle}
              </div>
            )}
          </div>
          {tile.lastEditedAt && (
            <div className="text-[10px] text-[var(--text-faint)] flex-shrink-0">
              {relativeTime(tile.lastEditedAt)}
            </div>
          )}
        </motion.button>
      </div>
      {isExpanded && children.length === 0 && (
        <div
          className="text-[11px] text-[var(--text-faint)] italic"
          style={{ paddingLeft: 8 + (depth + 1) * 16 + 16 + 8, paddingTop: 2, paddingBottom: 4 }}
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
            canExpand={canExpandTile(c)}
          />
        ))}
    </>
  )
}

function TileIcon({ tile }: { tile: PickerTile }) {
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
  // Default glyph keyed by tile kind so Drive folders read differently from
  // pages even before we have a thumbnail.
  return (
    <div
      className="w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-semibold flex-shrink-0"
      style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-faint)' }}
    >
      {tile.kind === 'folder' ? '▸' : '◌'}
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
// Spawn helpers — same as before, kept here so the picker drawer is the only
// surface that talks to the canvas store directly from a tile import.
// ---------------------------------------------------------------------------

function spawnDriveAtViewportCenter(
  result:
    | { kind: 'file'; data: DriveFileData }
    | { kind: 'folder'; data: DriveFolderData }
    | { kind: 'pdf'; data: PDFData }
    | { kind: 'image'; data: ImageData },
) {
  const { scale, offset, viewportSize, objects, addObject, commitBeforeAction } =
    useCanvasStore.getState()
  const center = screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
  commitBeforeAction()
  if (result.kind === 'file') {
    addObject(createDriveFile(center, objects.length, result.data))
  } else if (result.kind === 'folder') {
    addObject(createDriveFolder(center, objects.length, result.data))
  } else if (result.kind === 'pdf') {
    addObject({
      id: nanoid(),
      type: 'pdf',
      position: { x: center.x - 90, y: center.y - 120 },
      size: { width: 180, height: 240 },
      rotation: 0,
      zIndex: objects.length,
      data: result.data,
    })
  } else {
    addObject({
      id: nanoid(),
      type: 'image',
      position: { x: center.x - 200, y: center.y - 150 },
      size: { width: 400, height: 300 },
      rotation: 0,
      zIndex: objects.length,
      data: result.data,
    })
  }
}

function spawnSpotifyAtViewportCenter(result: SpotifyImportResult) {
  const { scale, offset, viewportSize, objects, addObject, commitBeforeAction } =
    useCanvasStore.getState()
  const center = screenToWorld(
    { x: viewportSize.width / 2, y: viewportSize.height / 2 },
    { scale, x: offset.x, y: offset.y },
  )
  commitBeforeAction()
  if (result.kind === 'playlist') {
    addObject(createSpotifyPlaylist(center, objects.length, result.data))
  } else if (result.kind === 'track') {
    addObject(createSpotifyTrack(center, objects.length, result.data))
  } else {
    addObject(createSpotifyAlbum(center, objects.length, result.data))
  }
}
