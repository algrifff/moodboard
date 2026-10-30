import type { PickerTile } from '@moodboard/shared'
import { CaretRight } from '@phosphor-icons/react'
import { motion } from 'framer-motion'

// ---------------------------------------------------------------------------
// Tiny presentational primitives reused across sections.
// ---------------------------------------------------------------------------

export function Section({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
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

export function EmptyHint({ text }: { text: string }) {
  return <div className="text-[12px] text-[var(--text-faint)] text-center py-3 italic">{text}</div>
}

export function TileSkeletonList({ rows }: { rows: number }) {
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

export function TileRow({
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

export function canExpandTile(tile: PickerTile): boolean {
  if (tile.provider === 'drive' && tile.kind === 'folder') return true
  return false
}
