import type { PickerTile } from '@moodboard/shared'
import { CaretRight, Trash } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { listChildPages, searchConnection } from '@/lib/connectionsApi'
import type { PickerConnection } from '@/store/sourcePicker'
import { EASE_OUT_QUICK } from '@/lib/motion'
import { ProviderGlyph } from './ConnectSources'
import { canExpandTile, EmptyHint, Section, TileRow, TileSkeletonList } from './tiles'

// ---------------------------------------------------------------------------
// ConnectionSection — per-connection collapsible block with its own state.
// Search query, tiles cursor, infinite-scroll sentinel, expand tree all
// live here. Re-mounting on connection change resets cleanly.
// ---------------------------------------------------------------------------

export function ConnectionSection({
  connection,
  query,
  onImport,
  onDisconnect,
  importingId,
}: {
  connection: PickerConnection
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
