import type { CanvasObject, NotionPageData } from '@moodboard/shared'
import { ArrowClockwise, ArrowSquareOut } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshExternal } from '@/lib/connectionsApi'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'
import { SpawnRing } from './SpawnRing'

// DOM overlay node for an imported Notion page. Mirrors FontNode's outer
// shell pattern (motion.div with halo + useBoxInteraction).
//
// Design decision (12q): we do NOT render the page markdown inline. The
// card surfaces title + provider chrome + a clear "Open in Notion ↗"
// link; clicking the title or the chip opens the live page in a new tab.
// The full markdown is still pulled and lives on the object's data so the
// AD/synthesiser has the page content available when this node is in a
// group — the canvas just doesn't try to render it.
//
// Why: rendering complex markdown (columns, embeds, sub-pages) inline made
// the card a hostile drop target — every body click opened the reader, no
// area could be dragged. Stripping the body restores the card to a simple
// "object you can move around" while keeping all the analysis-side value.
//
// Two affordances live on the card:
//   1. Refresh dot — hollow when fetchedAt >= lastEditedAt, solid accent
//      when the source is newer.
//   2. Title + "Open" chip — both are <a> links to data.url. Browser
//      native click-vs-drag semantics mean a drag from anywhere in the
//      card (including over the link) drags; a clean release on the link
//      navigates.

export function NotionPageNode({
  object,
  scale,
  panMode,
  selected,
  boardId,
}: {
  object: CanvasObject
  scale: number
  panMode: boolean
  selected: boolean
  boardId: string
}) {
  const data = object.data as NotionPageData
  const updateObject = useCanvasStore((s) => s.updateObject)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 200,
    minHeight: 96,
    haloPx: HALO,
  })

  const stale = isStale(data)

  // useBoxInteraction calls setPointerCapture on the outer card on
  // pointerdown — that captures the pointer to the card div and the
  // browser fires click on the card (which has no handler) instead of
  // on the <a> child. We block pointerdown on the link elements so
  // capture never starts from them, and back up the native <a>
  // navigation with an explicit window.open in onClick.
  const linkPointerDown = (e: React.PointerEvent) => e.stopPropagation()
  const openInNotion = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    window.open(data.url, '_blank', 'noopener,noreferrer')
  }

  const onRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const fresh = await refreshExternal(boardId, object.id)
      useCanvasStore.getState().commitBeforeAction()
      updateObject(object.id, { data: fresh })
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: OBJECT_SPAWN_DURATION, ease: [...SNAP_CURVE] }}
      onPointerEnter={interaction.onPointerEnter}
      onPointerLeave={interaction.onPointerLeave}
      onPointerMove={interaction.onPointerMove}
      onPointerDown={interaction.onPointerDown}
      onPointerUp={interaction.onPointerUp}
      style={{
        position: 'absolute',
        left: object.position.x - HALO,
        top: object.position.y - HALO,
        width: object.size.width + HALO * 2,
        height: object.size.height + HALO * 2,
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
          padding: '14px 16px',
          boxSizing: 'border-box',
        }}
      >
        <SpawnRing />
        <div className="flex items-start gap-2.5" style={{ minWidth: 0 }}>
          <Icon data={data} />
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer noopener"
            onPointerDown={linkPointerDown}
            onClick={openInNotion}
            // Link colour comes from the surrounding text — no underline
            // until hover, so the title reads as a heading first and a
            // link second. Drag is still possible from any non-link area
            // of the card; the link itself is a click target only.
            className="flex-1 min-w-0 text-[14px] font-semibold leading-snug hover:underline"
            style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
            title={`${data.title} — opens in Notion`}
          >
            {data.title || 'Untitled'}
          </a>
          <RefreshDot stale={stale} refreshing={refreshing} onClick={onRefresh} />
        </div>
        <div
          className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-faint)] mt-1"
          style={{ marginLeft: 32 }}
        >
          Notion{data.lastEditedAt ? ` · edited ${relativeTime(data.lastEditedAt)}` : ''}
        </div>
        <div style={{ flex: 1 }} />
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer noopener"
          onPointerDown={linkPointerDown}
          onClick={openInNotion}
          className="inline-flex items-center gap-1 self-start text-[11.5px] font-medium hover:underline"
          style={{
            color: 'var(--text-mute)',
            textDecoration: 'none',
            padding: '4px 8px',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--bg-elevated)',
            cursor: 'pointer',
          }}
        >
          Open in Notion
          <ArrowSquareOut size={11} weight="bold" />
        </a>
        {refreshError && (
          <div className="text-[11px] text-destructive mt-1.5" title={refreshError}>
            Refresh failed
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Internal pieces
// ---------------------------------------------------------------------------

function Icon({ data }: { data: NotionPageData }) {
  if (data.iconEmoji) {
    return (
      <div
        className="w-6 h-6 flex items-center justify-center text-[18px] leading-none"
        style={{ flexShrink: 0 }}
      >
        {data.iconEmoji}
      </div>
    )
  }
  if (data.iconUrl) {
    return (
      <img
        src={data.iconUrl}
        alt=""
        className="w-6 h-6 object-contain"
        style={{ borderRadius: 4, flexShrink: 0 }}
        loading="lazy"
      />
    )
  }
  return (
    <div
      className="w-6 h-6 rounded-sm flex items-center justify-center text-[10px] font-semibold"
      style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-faint)', flexShrink: 0 }}
    >
      ◌
    </div>
  )
}

function RefreshDot({
  stale,
  refreshing,
  onClick,
}: {
  stale: boolean
  refreshing: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The refresh dot is the only interactive element that needs to
      // intercept pointer events — otherwise a click on it would also
      // start a drag from the surrounding card.
      onPointerDown={(e) => e.stopPropagation()}
      title={stale ? 'Source updated — refresh' : 'Refresh from source'}
      aria-label="Refresh from source"
      className="inline-flex items-center justify-center transition-colors"
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        color: stale ? 'var(--accent)' : 'var(--text-faint)',
        backgroundColor: stale ? 'var(--accent-fade)' : 'transparent',
        flexShrink: 0,
      }}
    >
      <ArrowClockwise
        size={12}
        weight={stale ? 'bold' : 'regular'}
        style={{ animation: refreshing ? 'mb-spin 800ms linear infinite' : 'none' }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Staleness + relative time. fetchedAt and lastEditedAt are ISO strings; we
// just parse them and compare. Both being optional handles legacy snapshots
// from before refresh shipped.
// ---------------------------------------------------------------------------

function isStale(data: NotionPageData): boolean {
  if (!data.lastEditedAt) return false
  const fetched = Date.parse(data.fetchedAt)
  const edited = Date.parse(data.lastEditedAt)
  if (Number.isNaN(fetched) || Number.isNaN(edited)) return false
  return edited > fetched
}

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
