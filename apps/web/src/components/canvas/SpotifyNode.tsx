import type {
  CanvasObject,
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
} from '@moodboard/shared'
import { ArrowClockwise, ArrowSquareOut, Info, ListBullets } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useBoxInteraction } from '@/hooks/useBoxInteraction'
import { refreshExternal } from '@/lib/connectionsApi'
import { OBJECT_SPAWN_DURATION, SNAP_CURVE } from '@/lib/motion'
import { useCanvasStore } from '@/store/canvas'
import { SpotifyDetailModal } from './SpotifyDetailModal'
import { SpotifyEmbed } from './SpotifyEmbed'
import { SpawnRing } from './SpawnRing'

// Single DOM overlay for all three Spotify canvas types (playlist, track,
// album). They share the same shell — cover art on the left, name +
// subtitle on the right, audio-feature bars at the bottom — so it makes
// more sense to discriminate inside the component than to have three
// near-identical files.
//
// Why DOM and not Konva: cover art needs to be a real <img> with native
// loading + Spotify-CDN cache headers, and the audio-feature bars want
// CSS transitions when an aiPalette later overrides them. Same hybrid-
// render reasoning as DriveNode / WebPageNode.

type AnySpotifyData = SpotifyPlaylistData | SpotifyTrackData | SpotifyAlbumData

export function SpotifyNode({
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
  const kind = object.type as 'spotify-playlist' | 'spotify-track' | 'spotify-album'
  const data = object.data as AnySpotifyData
  const updateObject = useCanvasStore((s) => s.updateObject)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  // All three kinds expand: playlists/albums into a per-track table, a
  // single track into its full audio-feature breakdown. Every detail view
  // carries a Spotify embed player so the user can hear it.
  const canExpand = true

  const HALO = 14
  const interaction = useBoxInteraction(object.id, scale, {
    panMode,
    editing: false,
    minWidth: 240,
    minHeight: 120,
    haloPx: HALO,
  })

  const linkPointerDown = (e: React.PointerEvent) => e.stopPropagation()
  const openInSpotify = (e: React.MouseEvent) => {
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
      // refreshExternal returns 'playlist' / 'track' / 'album' for spotify
      // kinds (matching the import response). Any other kind means the
      // server resolved the object to a different shape; bail rather than
      // silently change the canvas object type.
      const expected =
        kind === 'spotify-playlist' ? 'playlist' : kind === 'spotify-track' ? 'track' : 'album'
      if (fresh.kind !== expected) {
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

  // Display labels per kind. Title + subtitle pulled from the right place
  // on each data shape.
  const title = data.name
  const subtitle = subtitleFor(kind, data)
  const coverUrl = coverFor(kind, data)

  // Audio-feature bars. Playlist + album have aggregate; single track has
  // raw per-track features. Either way we surface energy / valence /
  // tempo as three little bars.
  const bars = barsFor(kind, data)

  // A single track gets an inline Spotify player (play + scrubber) right on
  // the card so it's audible without opening the detail modal. Playlists /
  // albums keep playback in the modal (their cards stay compact).
  const inlineEmbed = kind === 'spotify-track' ? (data as SpotifyTrackData).trackId : null

  // Auto-height: the card has no fixed height — it wraps its content — and we
  // sync the measured height back to the object so grouping / bounding-box
  // math stays correct. The previous fixed height left an empty gap below
  // short content. Width stays user-resizable; height is owned by content.
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const sync = () => {
      const h = Math.round(el.offsetHeight)
      const current = useCanvasStore.getState().objects.find((o) => o.id === object.id)
      if (!current) return
      if (Math.abs(current.size.height - h) > 1) {
        updateObject(object.id, { size: { width: current.size.width, height: h } })
      }
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [object.id, updateObject])

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
        // No fixed height — the wrapper auto-sizes to the card content (plus
        // the halo padding). object.size.height is kept in sync via the
        // ResizeObserver above for grouping math.
        padding: HALO,
        boxSizing: 'border-box',
        cursor: interaction.cursor,
        pointerEvents: 'auto',
      }}
    >
      <div
        ref={cardRef}
        style={{
          position: 'relative',
          width: '100%',
          backgroundColor: 'var(--bg-card)',
          boxShadow: 'var(--shadow-card)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          outline: selected || interaction.nearEdge ? '2px solid var(--accent)' : 'none',
          outlineOffset: 3,
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 12px',
          boxSizing: 'border-box',
          gap: 6,
        }}
      >
        <SpawnRing />
        {/* Playlists / albums show a header row (cover + name + meta). A
            single track skips it entirely — the inline embed below already
            renders the cover, title, artist and duration, so a header would
            just duplicate all of it. */}
        {kind !== 'spotify-track' && (
          <div className="flex items-start gap-2.5" style={{ minWidth: 0 }}>
            <Cover url={coverUrl} kind={kind} />
            <div className="flex-1 min-w-0">
              <a
                href={data.url}
                target="_blank"
                rel="noreferrer noopener"
                onPointerDown={linkPointerDown}
                onClick={openInSpotify}
                className="block text-[13px] font-semibold leading-tight hover:underline truncate"
                style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                title={`${title} — opens in Spotify`}
              >
                {title}
              </a>
              <div
                className="text-[10.5px] text-[var(--text-mute)] mt-0.5 truncate"
                title={subtitle}
              >
                {subtitle}
              </div>
              <KindBadge kind={kind} data={data} />
            </div>
            <RefreshDot refreshing={refreshing} onClick={onRefresh} />
          </div>
        )}
        {inlineEmbed && (
          // Inline player — native play button + scrubber, audible straight
          // from the canvas. The iframe captures its own pointer events; the
          // wrapper stops propagation so a press here never starts a drag.
          <div onPointerDown={(e) => e.stopPropagation()}>
            <SpotifyEmbed type="track" id={inlineEmbed} compact />
          </div>
        )}
        <Description kind={kind} data={data} />
        <AudioFeatureBars bars={bars} />
        <MetaRow kind={kind} data={data} />
        <NoDataNotice kind={kind} data={data} />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setDetailOpen(true)
            }}
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold transition-colors hover:brightness-110"
            style={{
              color: 'var(--accent-foreground)',
              backgroundColor: 'var(--accent-soft)',
              textDecoration: 'none',
              padding: '3px 8px',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
            }}
            title={
              kind === 'spotify-track'
                ? 'Full audio-feature breakdown'
                : 'Play + view every track with per-track BPM, genre, energy'
            }
          >
            {kind === 'spotify-track' ? (
              <>
                <Info size={11} weight="bold" />
                Details
              </>
            ) : (
              <>
                <ListBullets size={11} weight="bold" />
                View {(data as SpotifyPlaylistData | SpotifyAlbumData).trackCount} tracks
              </>
            )}
          </button>
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer noopener"
            onPointerDown={linkPointerDown}
            onClick={openInSpotify}
            className="inline-flex items-center gap-1 text-[10.5px] font-medium hover:underline"
            style={{
              color: 'var(--text-mute)',
              textDecoration: 'none',
              padding: '3px 7px',
              borderRadius: 'var(--radius)',
              backgroundColor: 'var(--bg-elevated)',
              cursor: 'pointer',
            }}
          >
            Open
            <ArrowSquareOut size={10} weight="bold" />
          </a>
          {/* Tracks have no header, so the refresh control lives here. */}
          {kind === 'spotify-track' && (
            <div className="ml-auto">
              <RefreshDot refreshing={refreshing} onClick={onRefresh} />
            </div>
          )}
        </div>
        {refreshError && (
          <div className="text-[10.5px] text-destructive" title={refreshError}>
            Refresh failed
          </div>
        )}
      </div>
      {detailOpen && (
        <SpotifyDetailModal kind={kind} data={data} onClose={() => setDetailOpen(false)} />
      )}
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

function Cover({
  url,
  kind,
}: {
  url: string | undefined
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album'
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="object-cover"
        style={{
          width: 52,
          height: 52,
          borderRadius: 5,
          flexShrink: 0,
          backgroundColor: 'var(--bg-elevated)',
        }}
        loading="lazy"
      />
    )
  }
  // No cover (rare — Spotify almost always returns one). Fall back to a
  // grey square so the layout doesn't shift.
  return (
    <div
      className="flex items-center justify-center text-[10px] uppercase tracking-wider"
      style={{
        width: 52,
        height: 52,
        borderRadius: 5,
        flexShrink: 0,
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-faint)',
      }}
    >
      {kind === 'spotify-playlist' ? 'PL' : kind === 'spotify-track' ? 'TR' : 'AL'}
    </div>
  )
}

function KindBadge({
  kind,
  data,
}: {
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album'
  data: AnySpotifyData
}) {
  // Pack the kind label + the headline count onto one line so we don't burn
  // a row purely on a "PLAYLIST" chip. Tracks show duration; playlists +
  // albums show track count.
  let label: string
  if (kind === 'spotify-playlist') {
    const d = data as SpotifyPlaylistData
    label = `PLAYLIST · ${d.trackCount} TRACKS`
  } else if (kind === 'spotify-album') {
    const d = data as SpotifyAlbumData
    label = `ALBUM · ${d.trackCount} TRACKS`
  } else {
    const d = data as SpotifyTrackData
    label = `TRACK · ${formatDuration(d.durationMs)}`
  }
  return (
    <div
      className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)] mt-1 truncate"
      style={{ letterSpacing: '0.08em' }}
    >
      {label}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

// Owner-written playlist description. Often where the actual mood/intent
// lives ("rainy day study", "summer 2024 hype mix"). One line, ellipsised.
function Description({
  kind,
  data,
}: {
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album'
  data: AnySpotifyData
}) {
  if (kind !== 'spotify-playlist') return null
  const d = data as SpotifyPlaylistData
  const text = stripHtml(d.description).trim()
  if (!text) return null
  return (
    <div
      className="text-[11px] leading-snug text-[var(--text-mute)]"
      style={{
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
      title={text}
    >
      {text}
    </div>
  )
}

// Spotify's playlist descriptions sometimes contain HTML entities + a
// few wrapping tags (Spotify lets owners use limited HTML). Strip them so
// the card shows plain text — the AD prompt also gets the cleaned form.
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

// One compact row showing genre chips + era. Replaces the previous two
// stacked rows so we save vertical space.
function MetaRow({
  kind,
  data,
}: {
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album'
  data: AnySpotifyData
}) {
  const genres = genresFor(kind, data)
  const eraLine = eraLineFor(kind, data)
  if (genres.length === 0 && !eraLine) return null
  return (
    <div
      className="flex flex-wrap items-center gap-1 leading-none"
      style={{ overflow: 'hidden', maxHeight: 36 }}
    >
      {genres.slice(0, 3).map((g) => (
        <span
          key={g}
          className="text-[9.5px] font-medium tracking-wide"
          style={{
            padding: '3px 6px',
            borderRadius: 999,
            color: 'var(--text-mute)',
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-soft)',
            whiteSpace: 'nowrap',
            lineHeight: 1,
          }}
          title={g}
        >
          {g}
        </span>
      ))}
      {eraLine && (
        <span
          className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)]"
          style={{ lineHeight: 1, padding: '3px 2px' }}
          title={eraLine}
        >
          {/* Only show the dot separator when genre chips precede it. */}
          {genres.length > 0 ? `· ${eraLine}` : eraLine}
        </span>
      )}
    </div>
  )
}

// "0 tracks accessible" warning. Only shown when this is a playlist /
// album and the body was empty — usually means Spotify's editorial
// access lockout. Tells the user why the card looks bare without
// crashing or hiding the import.
function NoDataNotice({
  kind,
  data,
}: {
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album'
  data: AnySpotifyData
}) {
  if (kind === 'spotify-track') return null
  const trackCount = (data as SpotifyPlaylistData | SpotifyAlbumData).tracks.length
  if (trackCount > 0) return null
  return (
    <div
      className="text-[10px] italic text-[var(--text-faint)]"
      title="Spotify withheld the track list for this playlist. Spotify-curated playlists (Discover Weekly, Daily Mixes, editorial) are inaccessible to apps registered after Nov 2024 — try one of your own playlists for full mood signal."
    >
      Spotify withheld this playlist's tracks — try one of your own.
    </div>
  )
}

// All three audio-feature bars laid out side-by-side rather than stacked.
// Saves two rows of vertical space on the card — energy / valence / tempo
// each get ~1/3 of the row, label above, bar below, numeric to the side.
function AudioFeatureBars({ bars }: { bars: Bar[] }) {
  if (bars.length === 0) return null
  return (
    <div className="flex items-stretch gap-2" style={{ marginTop: 2 }}>
      {bars.map((b) => (
        <div key={b.label} className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span
              className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] truncate"
              style={{ lineHeight: 1 }}
            >
              {b.label}
            </span>
            <span
              className="text-[9px] tabular-nums text-[var(--text-mute)]"
              style={{ lineHeight: 1 }}
            >
              {b.display}
            </span>
          </div>
          <div
            style={{
              marginTop: 3,
              height: 4,
              borderRadius: 2,
              backgroundColor: 'var(--bg-elevated)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.round(b.normalised * 100)}%`,
                backgroundColor: b.colour,
                borderRadius: 2,
                transition: 'width 240ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              }}
            />
          </div>
        </div>
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
      title="Refresh from Spotify"
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

// ---------------------------------------------------------------------------
// Per-kind data accessors. Splitting these out keeps the JSX tidy.
// ---------------------------------------------------------------------------

function subtitleFor(
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  data: AnySpotifyData,
): string {
  if (kind === 'spotify-playlist') {
    const d = data as SpotifyPlaylistData
    return `${d.ownerName} · ${d.trackCount} tracks`
  }
  if (kind === 'spotify-track') {
    const d = data as SpotifyTrackData
    return `${d.artists.join(', ')} · ${d.albumName}`
  }
  const d = data as SpotifyAlbumData
  return `${d.artists.join(', ')} · ${d.releaseDate.slice(0, 4)}`
}

function coverFor(
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  data: AnySpotifyData,
): string | undefined {
  if (kind === 'spotify-track') return (data as SpotifyTrackData).albumCoverUrl
  if (kind === 'spotify-album') return (data as SpotifyAlbumData).coverUrl
  return (data as SpotifyPlaylistData).coverUrl
}

type Bar = { label: string; normalised: number; display: string; colour: string }

function barsFor(
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  data: AnySpotifyData,
): Bar[] {
  // Pull energy/valence/tempo from whichever shape the data has. Track:
  // single audioFeatures. Playlist + album: aggregate.
  if (kind === 'spotify-track') {
    const af = (data as SpotifyTrackData).audioFeatures
    if (!af) return []
    return [
      {
        label: 'Energy',
        normalised: clamp01(af.energy),
        display: af.energy.toFixed(2),
        colour: 'var(--spotify-bar-energy, #FF6B35)',
      },
      {
        label: 'Valence',
        normalised: clamp01(af.valence),
        display: af.valence.toFixed(2),
        colour: 'var(--spotify-bar-valence, #F7B538)',
      },
      {
        label: 'Tempo',
        normalised: clamp01(af.tempo / 220),
        display: `${Math.round(af.tempo)}`,
        colour: 'var(--spotify-bar-tempo, #1ED760)',
      },
    ]
  }
  const af = (data as SpotifyPlaylistData | SpotifyAlbumData).audioFeatures
  if (!af || af.trackCount === 0) return []
  return [
    {
      label: 'Energy',
      normalised: clamp01(af.avgEnergy),
      display: af.avgEnergy.toFixed(2),
      colour: 'var(--spotify-bar-energy, #FF6B35)',
    },
    {
      label: 'Valence',
      normalised: clamp01(af.avgValence),
      display: af.avgValence.toFixed(2),
      colour: 'var(--spotify-bar-valence, #F7B538)',
    },
    {
      label: 'Tempo',
      normalised: clamp01(af.medianTempo / 220),
      display: `${Math.round(af.medianTempo)}`,
      colour: 'var(--spotify-bar-tempo, #1ED760)',
    },
  ]
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function genresFor(
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  data: AnySpotifyData,
): string[] {
  if (kind === 'spotify-playlist') return (data as SpotifyPlaylistData).topGenres
  if (kind === 'spotify-album') return (data as SpotifyAlbumData).topGenres
  return (data as SpotifyTrackData).genres
}

function eraLineFor(
  kind: 'spotify-playlist' | 'spotify-track' | 'spotify-album',
  data: AnySpotifyData,
): string | null {
  if (kind === 'spotify-track') {
    const d = data as SpotifyTrackData
    return d.albumReleaseDate ? `Released ${d.albumReleaseDate.slice(0, 4)}` : null
  }
  if (kind === 'spotify-playlist') {
    const e = (data as SpotifyPlaylistData).era
    if (!e.dominantDecade) return null
    if (e.yearMin && e.yearMax && e.yearMin !== e.yearMax) {
      return `${e.dominantDecade} · ${e.yearMin}–${e.yearMax}`
    }
    return e.dominantDecade
  }
  const d = data as SpotifyAlbumData
  return d.releaseDate ? d.releaseDate.slice(0, 4) : null
}
