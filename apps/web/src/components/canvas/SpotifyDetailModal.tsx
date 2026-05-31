import type {
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  SpotifyTrackSummary,
} from '@moodboard/shared'
import { ArrowSquareOut, MusicNotes, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AI_PANEL_DURATION, EASE_OUT_STANDARD } from '@/lib/motion'
import { SpotifyEmbed } from './SpotifyEmbed'

// Expanded detail view for a Spotify playlist / album / track. Opens from
// the SpotifyNode card's expand button. Centered modal (mirrors
// PdfPreviewModal's overlay pattern) with a header, a Spotify embed player
// (real playback — works regardless of the deprecated preview_url), and the
// data surface beneath: a per-track table for playlists/albums, or the full
// audio-feature breakdown for a single track. This is the "DATA DATA DATA"
// surface — every signal Spotify gave us, laid out so the user can read the
// emotional fingerprint and actually *hear* it.
//
// Portals to document.body so it floats above the canvas + its own scrim.
// The scroll container opts into native scroll via `data-canvas-scrollable`
// (the canvas wheel handler skips those — see MoodBoardCanvas).

type AnyDetailData = SpotifyPlaylistData | SpotifyTrackData | SpotifyAlbumData
type DetailKind = 'spotify-playlist' | 'spotify-track' | 'spotify-album'

export function SpotifyDetailModal({
  kind,
  data,
  onClose,
}: {
  kind: DetailKind
  data: AnyDetailData
  onClose: () => void
}) {
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

  const isTrack = kind === 'spotify-track'
  const subtitle = headerSubtitle(kind, data)
  const cover = coverOf(kind, data)
  const embed = embedResource(kind, data)

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="spotify-detail-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: AI_PANEL_DURATION, ease: EASE_OUT_STANDARD }}
        className="fixed inset-0 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-overlay)', zIndex: 90, padding: 24 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <motion.div
          key="spotify-detail-card"
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 4 }}
          transition={{ duration: AI_PANEL_DURATION, ease: EASE_OUT_STANDARD }}
          className="flex flex-col overflow-hidden"
          style={{
            width: 'min(880px, 96vw)',
            maxHeight: '90vh',
            backgroundColor: 'var(--bg-card)',
            color: 'var(--text)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-modal)',
          }}
        >
          <Header
            title={data.name}
            subtitle={subtitle}
            cover={cover}
            url={data.url}
            onClose={onClose}
          />
          {isTrack ? (
            <TrackBody data={data as SpotifyTrackData} embed={embed} />
          ) : (
            <PlaylistBody
              kind={kind}
              data={data as SpotifyPlaylistData | SpotifyAlbumData}
              embed={embed}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Playlist / album body — aggregate mood band + per-track table.
// ---------------------------------------------------------------------------

function PlaylistBody({
  kind,
  data,
  embed,
}: {
  kind: DetailKind
  data: SpotifyPlaylistData | SpotifyAlbumData
  embed: { type: 'track' | 'playlist' | 'album'; id: string } | null
}) {
  const isPlaylist = kind === 'spotify-playlist'
  const tracks = data.tracks
  const description = isPlaylist ? stripHtml((data as SpotifyPlaylistData).description) : ''
  const genres = data.topGenres
  const era = data.era
  const af = data.audioFeatures
  const hasFeatures = af.trackCount > 0
  const anyTrackFeatures = tracks.some((t) => t.audioFeatures)

  return (
    <>
      <div
        className="px-5 py-3 flex flex-col gap-2.5"
        style={{ borderBottom: '1px solid var(--border-soft)' }}
      >
        {embed && <SpotifyEmbed type={embed.type} id={embed.id} />}
        {description && (
          <div className="text-[12.5px] leading-snug text-[var(--text-mute)]">{description}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {hasFeatures ? (
            <>
              <Stat label="Energy" value={af.avgEnergy} />
              <Stat label="Valence" value={af.avgValence} />
              <Stat label="Dance" value={af.avgDanceability} />
              <Stat label="Acoustic" value={af.avgAcousticness} />
              <Stat label="Tempo" value={`${af.medianTempo} BPM`} raw />
            </>
          ) : (
            <span className="text-[11px] italic text-[var(--text-faint)]">
              Audio features unavailable for this {isPlaylist ? 'playlist' : 'album'} — Spotify
              withheld energy/tempo data. Mood is read from genres + titles below.
            </span>
          )}
        </div>
        {(genres.length > 0 || era.dominantDecade) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {genres.map((g) => (
              <GenrePill key={g} label={g} />
            ))}
            {era.dominantDecade && (
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)] ml-1">
                {era.yearMin && era.yearMax && era.yearMin !== era.yearMax
                  ? `${era.dominantDecade} · ${era.yearMin}–${era.yearMax}`
                  : era.dominantDecade}
              </span>
            )}
          </div>
        )}
      </div>

      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-center px-8">
          <MusicNotes size={28} weight="duotone" style={{ color: 'var(--text-faint)' }} />
          <div className="text-[13px] text-[var(--text-mute)] max-w-[44ch]">
            Spotify withheld this {isPlaylist ? 'playlist' : 'album'}'s track list. Editorial /
            algorithmic playlists (Discover Weekly, Daily Mixes) aren't accessible — try one of your
            own playlists for the full breakdown.
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto" data-canvas-scrollable>
          <TrackTable tracks={tracks} showFeatures={anyTrackFeatures} />
          {data.trackCount > tracks.length && (
            <div className="text-center text-[11px] text-[var(--text-faint)] py-3">
              Showing first {tracks.length} of {data.trackCount} tracks
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Single-track body — embed player + the full audio-feature breakdown.
// ---------------------------------------------------------------------------

function TrackBody({
  data,
  embed,
}: {
  data: SpotifyTrackData
  embed: { type: 'track' | 'playlist' | 'album'; id: string } | null
}) {
  const af = data.audioFeatures
  const year = data.albumReleaseDate ? data.albumReleaseDate.slice(0, 4) : null
  // The six 0..1 perceptual features as labelled bars — the full mood
  // fingerprint of the track (the card only shows three).
  const featureBars: { label: string; value: number; colour: string }[] = af
    ? [
        { label: 'Energy', value: af.energy, colour: 'var(--spotify-bar-energy, #FF6B35)' },
        { label: 'Valence', value: af.valence, colour: 'var(--spotify-bar-valence, #F7B538)' },
        {
          label: 'Danceability',
          value: af.danceability,
          colour: 'var(--spotify-bar-tempo, #1ED760)',
        },
        { label: 'Acousticness', value: af.acousticness, colour: '#8AB4F8' },
        { label: 'Instrumentalness', value: af.instrumentalness, colour: '#C58AF9' },
        { label: 'Speechiness', value: af.speechiness, colour: '#F98AC5' },
      ]
    : []

  return (
    <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4" data-canvas-scrollable>
      {embed && <SpotifyEmbed type={embed.type} id={embed.id} />}

      {/* Headline stats */}
      <div className="flex flex-wrap items-center gap-2">
        {af && <Stat label="Tempo" value={`${Math.round(af.tempo)} BPM`} raw />}
        <Stat label="Duration" value={formatDuration(data.durationMs)} raw />
        {typeof data.popularity === 'number' && (
          <Stat label="Popularity" value={`${data.popularity}/100`} raw />
        )}
        {year && <Stat label="Released" value={year} raw />}
        {data.explicit && <Stat label="Explicit" value="Yes" raw />}
      </div>

      {/* Full feature bars */}
      {featureBars.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Audio features</SectionLabel>
          {featureBars.map((b) => (
            <FeatureBar key={b.label} label={b.label} value={b.value} colour={b.colour} />
          ))}
        </div>
      ) : (
        <div className="text-[12px] italic text-[var(--text-faint)]">
          Audio features (energy, tempo, danceability…) unavailable — Spotify withheld them for this
          track. Genre + popularity below still describe its character.
        </div>
      )}

      {/* Genres */}
      {data.genres.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Genres</SectionLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {data.genres.map((g) => (
              <GenrePill key={g} label={g} />
            ))}
          </div>
        </div>
      )}

      {/* Album line */}
      {data.albumName && (
        <div className="text-[12px] text-[var(--text-mute)]">
          From <span className="text-[var(--text)]">{data.albumName}</span>
          {year ? ` · ${year}` : ''}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] font-semibold">
      {children}
    </div>
  )
}

// A wide labelled feature bar for the single-track view (value 0..1).
function FeatureBar({ label, value, colour }: { label: string; value: number; colour: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-[var(--text-mute)]" style={{ width: 120, flexShrink: 0 }}>
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          backgroundColor: 'var(--bg-elevated)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            backgroundColor: colour,
            borderRadius: 3,
            transition: 'width 240ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        />
      </div>
      <span
        className="text-[11px] tabular-nums text-[var(--text-mute)]"
        style={{ width: 34, textAlign: 'right' }}
      >
        {value.toFixed(2)}
      </span>
    </div>
  )
}

function GenrePill({ label }: { label: string }) {
  return (
    <span
      className="text-[10px] font-medium tracking-wide"
      style={{
        padding: '3px 8px',
        borderRadius: 999,
        color: 'var(--accent-foreground)',
        backgroundColor: 'var(--accent-soft)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Per-kind accessors
// ---------------------------------------------------------------------------

function headerSubtitle(kind: DetailKind, data: AnyDetailData): string {
  if (kind === 'spotify-playlist') {
    const d = data as SpotifyPlaylistData
    return `${d.ownerName} · ${d.trackCount} tracks`
  }
  if (kind === 'spotify-album') {
    const d = data as SpotifyAlbumData
    return `${d.artists.join(', ')} · ${d.trackCount} tracks`
  }
  const d = data as SpotifyTrackData
  return d.artists.join(', ')
}

function coverOf(kind: DetailKind, data: AnyDetailData): string | undefined {
  if (kind === 'spotify-track') return (data as SpotifyTrackData).albumCoverUrl
  return (data as SpotifyPlaylistData | SpotifyAlbumData).coverUrl
}

function embedResource(
  kind: DetailKind,
  data: AnyDetailData,
): { type: 'track' | 'playlist' | 'album'; id: string } | null {
  if (kind === 'spotify-track') {
    const id = (data as SpotifyTrackData).trackId
    return id ? { type: 'track', id } : null
  }
  if (kind === 'spotify-album') {
    const id = (data as SpotifyAlbumData).albumId
    return id ? { type: 'album', id } : null
  }
  const id = (data as SpotifyPlaylistData).playlistId
  return id ? { type: 'playlist', id } : null
}

function Header({
  title,
  subtitle,
  cover,
  url,
  onClose,
}: {
  title: string
  subtitle: string
  cover: string | undefined
  url: string
  onClose: () => void
}) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-3.5"
      style={{ borderBottom: '1px solid var(--border-soft)' }}
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          className="object-cover"
          style={{ width: 48, height: 48, borderRadius: 6, flexShrink: 0 }}
        />
      ) : (
        <div
          className="flex items-center justify-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 6,
            flexShrink: 0,
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          <MusicNotes size={20} weight="duotone" style={{ color: 'var(--text-faint)' }} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold leading-tight truncate" title={title}>
          {title}
        </div>
        <div className="text-[12px] text-[var(--text-mute)] truncate mt-0.5">{subtitle}</div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-[11.5px] font-medium transition-colors hover:text-foreground"
        style={{
          color: 'var(--text-mute)',
          textDecoration: 'none',
          padding: '5px 9px',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        Open in Spotify
        <ArrowSquareOut size={11} weight="bold" />
      </a>
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center justify-center text-[var(--text-mute)] hover:text-foreground transition-colors"
        style={{ width: 30, height: 30, borderRadius: 999 }}
        aria-label="Close"
        title="Close (Esc)"
      >
        <X size={15} weight="bold" />
      </button>
    </div>
  )
}

function Stat({ label, value, raw }: { label: string; value: number | string; raw?: boolean }) {
  const display = raw ? String(value) : typeof value === 'number' ? value.toFixed(2) : value
  return (
    <div
      className="flex items-baseline gap-1.5"
      style={{
        padding: '3px 9px',
        borderRadius: 'var(--radius)',
        backgroundColor: 'var(--bg-elevated)',
      }}
    >
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
        {label}
      </span>
      <span className="text-[12px] font-semibold tabular-nums">{display}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Track table
// ---------------------------------------------------------------------------

function TrackTable({
  tracks,
  showFeatures,
}: {
  tracks: SpotifyTrackSummary[]
  showFeatures: boolean
}) {
  return (
    <table className="w-full border-collapse text-[12px]" style={{ tableLayout: 'auto' }}>
      <thead
        className="sticky top-0 z-10"
        style={{ backgroundColor: 'var(--bg-card)', boxShadow: '0 1px 0 var(--border-soft)' }}
      >
        <tr className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-faint)]">
          <Th align="right" w={36}>
            #
          </Th>
          <Th>Title</Th>
          <Th>Artist</Th>
          <Th>Album</Th>
          <Th align="right" w={48}>
            Year
          </Th>
          <Th>Genres</Th>
          {showFeatures && (
            <>
              <Th align="right" w={54}>
                BPM
              </Th>
              <Th align="right" w={56}>
                Energy
              </Th>
              <Th align="right" w={56}>
                Valence
              </Th>
            </>
          )}
          <Th align="right" w={52}>
            Time
          </Th>
          <Th align="right" w={48}>
            Pop
          </Th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((t, i) => (
          <TrackRow key={t.id || i} track={t} index={i + 1} showFeatures={showFeatures} />
        ))}
      </tbody>
    </table>
  )
}

function Th({
  children,
  align = 'left',
  w,
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  w?: number
}) {
  return (
    <th
      className="font-semibold px-2.5 py-2"
      style={{ textAlign: align, width: w, whiteSpace: 'nowrap' }}
    >
      {children}
    </th>
  )
}

function TrackRow({
  track,
  index,
  showFeatures,
}: {
  track: SpotifyTrackSummary
  index: number
  showFeatures: boolean
}) {
  const af = track.audioFeatures
  const year = track.albumReleaseDate ? track.albumReleaseDate.slice(0, 4) : '—'
  return (
    <tr
      className="transition-colors hover:bg-[var(--bg-elevated)]"
      style={{ borderTop: '1px solid var(--border-soft)' }}
    >
      <Td align="right" mute>
        {index}
      </Td>
      <Td>
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium truncate" style={{ maxWidth: 220 }} title={track.name}>
            {track.name}
          </span>
          {track.explicit && <ExplicitBadge />}
        </span>
      </Td>
      <Td mute>
        <span
          className="truncate inline-block"
          style={{ maxWidth: 160 }}
          title={track.artists.join(', ')}
        >
          {track.artists.join(', ') || '—'}
        </span>
      </Td>
      <Td mute>
        <span className="truncate inline-block" style={{ maxWidth: 160 }} title={track.albumName}>
          {track.albumName || '—'}
        </span>
      </Td>
      <Td align="right" mute>
        {year}
      </Td>
      <Td mute>
        {track.genres && track.genres.length > 0 ? (
          <span
            className="truncate inline-block"
            style={{ maxWidth: 180 }}
            title={track.genres.join(', ')}
          >
            {track.genres.slice(0, 2).join(', ')}
          </span>
        ) : (
          '—'
        )}
      </Td>
      {showFeatures && (
        <>
          <Td align="right">{af ? Math.round(af.tempo) : '—'}</Td>
          <Td align="right">
            {af ? <Bar value={af.energy} colour="var(--spotify-bar-energy, #FF6B35)" /> : '—'}
          </Td>
          <Td align="right">
            {af ? <Bar value={af.valence} colour="var(--spotify-bar-valence, #F7B538)" /> : '—'}
          </Td>
        </>
      )}
      <Td align="right" mute>
        {formatDuration(track.durationMs)}
      </Td>
      <Td align="right" mute>
        {typeof track.popularity === 'number' ? track.popularity : '—'}
      </Td>
    </tr>
  )
}

function Td({
  children,
  align = 'left',
  mute,
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  mute?: boolean
}) {
  return (
    <td
      className="px-2.5 py-2 align-middle tabular-nums"
      style={{
        textAlign: align,
        color: mute ? 'var(--text-mute)' : 'var(--text)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  )
}

// Tiny inline bar + number for energy/valence so the column reads at a glance.
function Bar({ value, colour }: { value: number; colour: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <span className="inline-flex items-center gap-1.5 justify-end">
      <span
        style={{
          width: 28,
          height: 4,
          borderRadius: 2,
          backgroundColor: 'var(--bg-muted)',
          overflow: 'hidden',
          display: 'inline-block',
        }}
      >
        <span
          style={{ display: 'block', height: '100%', width: `${pct}%`, backgroundColor: colour }}
        />
      </span>
      <span className="text-[11px]">{value.toFixed(2)}</span>
    </span>
  )
}

function ExplicitBadge() {
  return (
    <span
      className="inline-flex items-center justify-center text-[8px] font-bold"
      style={{
        width: 13,
        height: 13,
        borderRadius: 3,
        backgroundColor: 'var(--text-faint)',
        color: 'var(--bg-card)',
        flexShrink: 0,
      }}
      title="Explicit"
    >
      E
    </span>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

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
    .trim()
}
