import type { CanvasObject, VideoClipData } from '@moodboard/shared'
import { ArrowClockwise, ArrowSquareOut, FilmSlate, Play } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshExternal } from '@/lib/connectionsApi'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'
import { SpawnRing } from './SpawnRing'

// DOM overlay node for a video clip imported via paste (YouTube / TikTok /
// Instagram / X / Vimeo). Mirrors WebPageNode's shell + interaction; the body
// is a 16:9 thumbnail with a play badge over the top, then title / channel /
// duration + a transcript indicator.
//
// The thumbnail and the "Open" chip open the source URL in a new tab; the
// refresh dot re-pulls the snapshot. Everything else is a drag handle.

export function VideoClipNode({
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
  const data = object.data as VideoClipData
  const updateObject = useCanvasStore((s) => s.updateObject)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [thumbErrored, setThumbErrored] = useState(false)
  const [playing, setPlaying] = useState(false)

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 240,
    minHeight: 160,
    haloPx: HALO,
  })

  // YouTube + Vimeo embed cleanly in an iframe; the rest (TikTok / IG / X)
  // don't, so their play button just opens the source instead.
  const inlineEmbed = embedUrl(data.platform, data.videoId)

  const controlPointerDown = (e: React.PointerEvent) => e.stopPropagation()
  const openSource = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    window.open(data.url, '_blank', 'noopener,noreferrer')
  }
  const onPlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (inlineEmbed) setPlaying(true)
    else window.open(data.url, '_blank', 'noopener,noreferrer')
  }

  const onRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const fresh = await refreshExternal(boardId, object.id)
      if (fresh.kind !== 'video-clip') throw new Error('Source changed type — refresh aborted')
      useCanvasStore.getState().commitBeforeAction()
      updateObject(object.id, { data: fresh.data })
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const platformLabel = PLATFORM_LABELS[data.platform] ?? 'source'
  const showThumb = !!data.thumbnailUrl && !thumbErrored

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
          boxSizing: 'border-box',
        }}
      >
        <SpawnRing />

        {/* 16:9 media area. The thumbnail itself is a drag handle (pointer
            events bubble to the wrapper); only the centred play badge is an
            interactive button. On play it swaps to an inline iframe player
            for YouTube/Vimeo (other platforms open the source instead). */}
        <div
          className="relative w-full"
          style={{
            aspectRatio: '16 / 9',
            backgroundColor: 'var(--bg-elevated)',
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          {playing && inlineEmbed ? (
            <iframe
              title={data.title || 'Video'}
              src={inlineEmbed}
              className="w-full h-full"
              style={{ border: 'none', display: 'block' }}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            <>
              {showThumb ? (
                <img
                  src={data.thumbnailUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  draggable={false}
                  onError={() => setThumbErrored(true)}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <FilmSlate size={28} weight="duotone" style={{ color: 'var(--text-faint)' }} />
                </div>
              )}
              {/* Play badge — the only interactive part of the thumbnail, so
                  the surrounding image stays a drag handle. */}
              <button
                type="button"
                onPointerDown={controlPointerDown}
                onClick={onPlay}
                aria-label={inlineEmbed ? 'Play video here' : `Open in ${platformLabel}`}
                title={inlineEmbed ? 'Play here' : `Open in ${platformLabel}`}
                className="absolute flex items-center justify-center transition-transform hover:scale-105"
                style={{
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 46,
                  height: 46,
                  borderRadius: 999,
                  backgroundColor: 'rgba(0, 0, 0, 0.58)',
                  backdropFilter: 'blur(2px)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Play size={20} weight="fill" color="#fff" style={{ marginLeft: 2 }} />
              </button>
              {data.durationSec > 0 && (
                <span
                  className="absolute text-[10.5px] font-medium tabular-nums"
                  style={{
                    right: 6,
                    bottom: 6,
                    padding: '1px 5px',
                    borderRadius: 4,
                    backgroundColor: 'rgba(0, 0, 0, 0.72)',
                    color: '#fff',
                    pointerEvents: 'none',
                  }}
                >
                  {formatDuration(data.durationSec)}
                </span>
              )}
            </>
          )}
        </div>

        {/* Body — title + channel are plain text (drag handle, not links);
            navigation lives in the play badge + the "Open in" chip. */}
        <div className="flex flex-col gap-1" style={{ padding: '10px 12px', minWidth: 0 }}>
          <div className="flex items-start gap-2">
            <div
              className="flex-1 min-w-0 text-[13px] font-semibold leading-snug"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
              title={data.title}
            >
              {data.title || 'Untitled video'}
            </div>
            <RefreshDot refreshing={refreshing} onClick={onRefresh} />
          </div>
          {data.channel && (
            <div className="text-[11px] text-[var(--text-mute)] truncate" title={data.channel}>
              {data.channel}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
              {data.transcript ? 'Transcript captured' : 'No transcript'}
            </span>
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer noopener"
              onPointerDown={controlPointerDown}
              onClick={openSource}
              className="inline-flex items-center gap-1 text-[10.5px] font-medium hover:underline"
              style={{
                color: 'var(--text-mute)',
                textDecoration: 'none',
                padding: '3px 7px',
                borderRadius: 'var(--radius)',
                backgroundColor: 'var(--bg-elevated)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Open in {platformLabel}
              <ArrowSquareOut size={10} weight="bold" />
            </a>
          </div>
          {refreshError && (
            <div className="text-[10.5px] text-destructive" title={refreshError}>
              Refresh failed
            </div>
          )}
        </div>
      </div>
    </motion.div>
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
      title="Refresh from source"
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

const PLATFORM_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  x: 'X',
  vimeo: 'Vimeo',
  other: 'source',
}

// Inline-player embed URL for platforms that play cleanly in an iframe.
// YouTube + Vimeo do; TikTok / Instagram / X need their own embed scripts
// and don't work in a bare iframe, so they return null (play opens source).
function embedUrl(platform: string, videoId: string): string | null {
  if (!videoId) return null
  if (platform === 'youtube') return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`
  if (platform === 'vimeo') return `https://player.vimeo.com/video/${videoId}?autoplay=1`
  return null
}

function formatDuration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}
