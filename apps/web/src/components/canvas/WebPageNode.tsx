import type { CanvasObject, WebPageData } from '@moodboard/shared'
import { ArrowClockwise, ArrowSquareOut, Globe } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshExternal } from '@/lib/connectionsApi'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'
import { SpawnRing } from './SpawnRing'

// DOM overlay node for a web page imported via paste. Mirrors NotionPageNode
// in shell + interaction; the body is bespoke because a brand homepage has
// different signal than a Notion page (favicon + sampled palette swatches +
// host strapline rather than a refreshable markdown body).
//
// Card anatomy:
//   ┌────────────────────────────────────────┐
//   │ [favicon]  Title of the page    ↻      │
//   │           HOST                          │
//   │  ▢ ▢ ▢ ▢ ▢   ← brand palette swatches  │
//   │                                         │
//   │  Open ↗                                 │
//   └────────────────────────────────────────┘
//
// The whole card is a drag handle (per useBoxInteraction) except for the
// favicon/title link, the refresh dot, and the "Open" chip — those swallow
// pointerdown so the user can click them without dragging.

export function WebPageNode({
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
  const data = object.data as WebPageData
  const updateObject = useCanvasStore((s) => s.updateObject)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [faviconErrored, setFaviconErrored] = useState(false)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 220,
    minHeight: 120,
    haloPx: HALO,
  })

  const linkPointerDown = (e: React.PointerEvent) => e.stopPropagation()
  const openInBrowser = (e: React.MouseEvent) => {
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
      if (fresh.kind !== 'web-page') {
        throw new Error('Source changed type — refresh aborted')
      }
      useCanvasStore.getState().commitBeforeAction()
      updateObject(object.id, { data: fresh.data })
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
          <Favicon
            faviconUrl={data.faviconUrl}
            host={data.host}
            errored={faviconErrored}
            onError={() => setFaviconErrored(true)}
          />
          <div className="flex-1 min-w-0">
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer noopener"
              onPointerDown={linkPointerDown}
              onClick={openInBrowser}
              className="block text-[14px] font-semibold leading-snug hover:underline truncate"
              style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
              title={`${data.title} — opens in a new tab`}
            >
              {data.title || data.host}
            </a>
            <div
              className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-faint)] mt-0.5 truncate"
              title={data.host}
            >
              {data.host}
            </div>
          </div>
          <RefreshDot refreshing={refreshing} onClick={onRefresh} />
        </div>
        <Summary text={data.description} fallback={data.readableText} />
        <Palette colours={data.colours} />
        <div style={{ flex: 1 }} />
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer noopener"
          onPointerDown={linkPointerDown}
          onClick={openInBrowser}
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
          Open ↗
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

function Favicon({
  faviconUrl,
  host,
  errored,
  onError,
}: {
  faviconUrl?: string
  host: string
  errored: boolean
  onError: () => void
}) {
  if (faviconUrl && !errored) {
    return (
      <img
        src={faviconUrl}
        alt=""
        className="w-6 h-6 object-contain"
        style={{
          borderRadius: 4,
          flexShrink: 0,
          backgroundColor: 'var(--bg-elevated)',
        }}
        loading="lazy"
        onError={onError}
      />
    )
  }
  // Fallback — a globe glyph on the elevated surface so the layout column
  // still aligns even when the favicon 404s or the page declared none.
  return (
    <div
      className="w-6 h-6 rounded-sm flex items-center justify-center"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-faint)',
        flexShrink: 0,
      }}
      aria-label={host}
      title={host}
    >
      <Globe size={14} weight="regular" />
    </div>
  )
}

// Short blurb under the title — the og:description first, with a
// truncated readable-text fallback when the page didn't supply one. 3-line
// clamp keeps the card hugging its default height; the full text lives on
// the object's data for the AD prompt.
function Summary({ text, fallback }: { text: string; fallback: string }) {
  const blurb = text?.trim() || firstSentences(fallback, 200)
  if (!blurb) return null
  return (
    <div
      className="text-[12px] leading-snug mt-2 text-[var(--text-mute)]"
      style={{
        marginLeft: 32,
        marginRight: 8,
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      title={blurb}
    >
      {blurb}
    </div>
  )
}

// Pull the first ~maxChars of a long readable-text block, ending on the
// last sentence boundary so the card doesn't trail off mid-word.
function firstSentences(text: string, maxChars: number): string {
  if (!text) return ''
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= maxChars) return trimmed
  const slice = trimmed.slice(0, maxChars)
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  )
  if (lastStop > maxChars * 0.5) return slice.slice(0, lastStop + 1)
  return slice + '…'
}

function Palette({ colours }: { colours: WebPageData['colours'] }) {
  if (colours.length === 0) return null
  return (
    <div
      className="flex items-center gap-1.5 mt-3"
      style={{ marginLeft: 32 }}
      aria-label="Brand palette"
    >
      {colours.slice(0, 5).map((c, i) => (
        <div
          key={`${c.hex}-${i}`}
          title={`${c.hex} · ${c.role}`}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            backgroundColor: c.hex,
            boxShadow: 'var(--shadow-small), var(--swatch-inset)',
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  )
}

function RefreshDot({
  refreshing,
  onClick,
}: {
  refreshing: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      title="Re-pull colours, fonts, and excerpt"
      aria-label="Refresh from source"
      className="inline-flex items-center justify-center transition-colors"
      style={{
        width: 22,
        height: 22,
        borderRadius: 999,
        color: 'var(--text-faint)',
        backgroundColor: 'transparent',
        flexShrink: 0,
      }}
    >
      <ArrowClockwise
        size={12}
        weight="regular"
        style={{ animation: refreshing ? 'mb-spin 800ms linear infinite' : 'none' }}
      />
    </button>
  )
}
