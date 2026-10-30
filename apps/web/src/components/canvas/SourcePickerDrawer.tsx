import type { ConnectionSummary, PickerTile } from '@moodboard/shared'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { deleteConnection, importDriveFile, importSpotifyRef } from '@/lib/connectionsApi'
import { connectFigma } from '@/lib/figmaPaste'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { AGENT_SIDEBAR_WIDTH, useAgentSidebarStore } from '@/store/agentSidebar'
import { useLinearStore } from '@/store/linear'
import { isPickerConnection, useSourcePickerStore } from '@/store/sourcePicker'
import { AddSourceSection } from './sourcePicker/ConnectSources'
import { ConnectionSection } from './sourcePicker/ConnectionSection'
import { FigmaSection } from './sourcePicker/FigmaSection'
import { LibrarySection } from './sourcePicker/LibrarySection'
import { OutputsSection } from './sourcePicker/OutputsSection'
import { LinearSection } from './sourcePicker/LinearSection'
import { RecentsSection } from './sourcePicker/RecentsSection'
import { spawnDriveAtViewportCenter, spawnSpotifyAtViewportCenter } from './sourcePicker/spawn'
import { showToast } from './Toast'

// ---------------------------------------------------------------------------
// Left-side drawer, opening from the canvas edge next to the agent sidebar.
//
// Structure (extensible — adding a new provider needs no UI changes here):
//
//   ┌─ Drawer ──────────────────────────────────┐
//   │ Sources                            [✕]    │
//   │ [🔍 Search across all sources           ] │
//   │                                            │
//   │ ┌─ + SOURCES ────────────────────────────┐│
//   │ │ [G] Drive   [S] Spotify                ││
//   │ │ [L] Linear  [F] Figma                  ││
//   │ └────────────────────────────────────────┘│
//   │                                            │
//   │  Asset library     (click or drag to add)  │
//   │  Figma             (paste a link → frames) │
//   │  Outputs           (click to add)          │
//   │  Linear            (pick an issue → thread)│
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
// always one click away. The asset library and Linear issues follow, then
// Recents and the per-connection sections. Library and Linear don't need a
// Drive/Spotify connection, so they show regardless.
// ---------------------------------------------------------------------------

const DRAWER_WIDTH = 'min(720px, max(480px, 50vw))'

type ConnectProps = {
  boardId: string
  onConnectDrive: () => void
  onConnectSpotify: () => void
}

export function SourcePickerDrawer({ boardId, onConnectDrive, onConnectSpotify }: ConnectProps) {
  const open = useSourcePickerStore((s) => s.open)
  const closePicker = useSourcePickerStore((s) => s.closePicker)
  const draggingAsset = useSourcePickerStore((s) => s.draggingAsset)
  const connections = useSourcePickerStore((s) => s.connections)
  const loadingConnections = useSourcePickerStore((s) => s.loadingConnections)
  const sidebarWidth = useAgentSidebarStore((s) => (s.open ? AGENT_SIDEBAR_WIDTH : 0))

  return (
    <>
      {typeof document !== 'undefined' &&
        createPortal(
          <>
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
                    left: sidebarWidth,
                    backgroundColor: 'var(--scrim)',
                    zIndex: 79,
                    pointerEvents: draggingAsset ? 'none' : 'auto',
                  }}
                  aria-hidden
                />
              )}
            </AnimatePresence>
            {/* Slides out from the canvas edge, beside the agent sidebar
                rather than over it. */}
            <div
              style={{
                position: 'fixed',
                top: 0,
                bottom: 0,
                left: sidebarWidth,
                right: 0,
                overflow: 'hidden',
                pointerEvents: 'none',
                zIndex: 80,
              }}
            >
              <AnimatePresence>
                {open && (
                  <DrawerContent
                    key="source-picker-drawer"
                    boardId={boardId}
                    passThrough={draggingAsset}
                    connections={connections}
                    loadingConnections={loadingConnections}
                    onConnectDrive={onConnectDrive}
                    onConnectSpotify={onConnectSpotify}
                    onClose={closePicker}
                  />
                )}
              </AnimatePresence>
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

function DrawerContent({
  boardId,
  passThrough,
  connections,
  loadingConnections,
  onConnectDrive,
  onConnectSpotify,
  onClose,
}: {
  boardId: string
  // A library asset is mid-drag: let the drop reach the canvas underneath.
  passThrough: boolean
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
  const connectLinear = useLinearStore((s) => s.connect)
  const pickerConnections = connections.filter(isPickerConnection)

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
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
        width: DRAWER_WIDTH,
        backgroundColor: 'var(--bg-card)',
        boxShadow: 'var(--shadow-drawer)',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: passThrough ? 'none' : 'auto',
      }}
    >
      <Header onClose={onClose} />

      <SearchBar query={query} onChange={setQuery} />
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <AddSourceSection
          connections={connections}
          loading={loadingConnections}
          onConnectDrive={onConnectDrive}
          onConnectSpotify={onConnectSpotify}
          onConnectLinear={() => void connectLinear()}
          onConnectFigma={() => void connectFigma(boardId)}
        />
        <LibrarySection boardId={boardId} query={query} />
        <FigmaSection boardId={boardId} query={query} />
        <OutputsSection boardId={boardId} query={query} />
        <LinearSection boardId={boardId} query={query} />
        {!query && pickerConnections.length > 0 && (
          <RecentsSection
            connections={pickerConnections}
            onImport={onImport}
            importingId={importingId}
          />
        )}
        {pickerConnections.map((c) => (
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
