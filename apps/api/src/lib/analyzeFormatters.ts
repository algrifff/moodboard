import type {
  SpotifyAlbumData,
  SpotifyPlaylistData,
  SpotifyTrackData,
  VideoClipData,
} from '@moodboard/shared'

// Short label for the Drive excerpt header.
export function driveKindLabel(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'Doc'
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Sheet'
  if (mimeType === 'application/vnd.google-apps.presentation') return 'Slides'
  return 'file'
}

// Cap how many tracks we list in the prompt. Big playlists already
// contribute via the audio-feature aggregate; listing 200 tracks is
// just token-burn for no extra signal. Twelve is enough that the AD
// can read the playlist's character + era from artist names.
const SPOTIFY_TRACK_DISPLAY_LIMIT = 12

// Format the era block as a one-line summary. "1990s-dominant (mix: 1990s ×8,
// 2000s ×3, 2010s ×1)" reads naturally inside the playlist preamble.
function formatEra(e: SpotifyPlaylistData['era']): string | null {
  if (!e.dominantDecade || e.decadeBreakdown.length === 0) return null
  const mix = e.decadeBreakdown
    .slice(0, 4)
    .map(({ decade, count }) => `${decade} ×${count}`)
    .join(', ')
  const range =
    e.yearMin != null && e.yearMax != null && e.yearMin !== e.yearMax
      ? ` (${e.yearMin}–${e.yearMax})`
      : ''
  return `Era: ${e.dominantDecade}-dominant${range} — mix: ${mix}`
}

// Per-track line includes whatever extra signal we have. Compact (one line)
// to keep the playlist block scannable, but the AD now sees popularity,
// explicit flag, and album release date alongside the artist name.
function trackLine(t: SpotifyPlaylistData['tracks'][number]): string {
  const parts = [`- ${t.name} — ${t.artists.join(', ')}`]
  const meta: string[] = []
  if (t.albumName) meta.push(t.albumName)
  if (t.albumReleaseDate) meta.push(t.albumReleaseDate.slice(0, 4))
  if (typeof t.popularity === 'number') meta.push(`pop ${t.popularity}`)
  if (t.explicit) meta.push('explicit')
  if (t.audioFeatures) {
    const af = t.audioFeatures
    meta.push(`E${af.energy.toFixed(2)}/V${af.valence.toFixed(2)}/${Math.round(af.tempo)}BPM`)
  }
  if (meta.length > 0) parts.push(`[${meta.join(' · ')}]`)
  return parts.join(' ')
}

export function formatSpotifyPlaylist(d: SpotifyPlaylistData): string {
  const af = d.audioFeatures
  const head = [`Spotify playlist: "${d.name}" by ${d.ownerName} (${d.trackCount} tracks)`]
  // Description first — this is where the owner literally wrote what the
  // playlist is *for*. It's the highest-signal mood input we have.
  // Strip HTML/entities Spotify allows in playlist descriptions.
  const desc = stripPlaylistHtml(d.description)
  if (desc) head.push(`Owner's description: "${desc}"`)
  // Audio features may be zeroed when Spotify denied the audio-features
  // endpoint (Nov 2024 access lock for newly-registered apps). Suppress
  // the row in that case so the AD doesn't read it as "this playlist has
  // zero energy" — the absence is informational, not a value.
  if (af.trackCount > 0) {
    head.push(
      `Audio-feature aggregate (across ${af.trackCount} tracks): energy ${af.avgEnergy}, valence ${af.avgValence}, danceability ${af.avgDanceability}, acousticness ${af.avgAcousticness}, speechiness ${af.avgSpeechiness}, median tempo ${af.medianTempo} BPM`,
    )
  } else {
    head.push(
      'Audio-feature aggregate: unavailable (Spotify did not return audio features for this playlist — read mood from artist genres + track titles + description).',
    )
  }
  if (d.topGenres.length > 0) {
    head.push(`Top genres (track-weighted, primary artist): ${d.topGenres.join(', ')}`)
  }
  const eraLine = formatEra(d.era)
  if (eraLine) head.push(eraLine)
  // Empty playlist body (editorial / curated playlist on a post-cutoff
  // app) — be explicit so the AD doesn't hallucinate track names.
  if (d.tracks.length === 0) {
    head.push(
      'Track list unavailable: Spotify withheld the playlist body. Read the mood from the description + playlist name alone.',
    )
    return `--- ${head.join('\n')} ---\n--- end Spotify playlist ---`
  }
  const trackLines = d.tracks.slice(0, SPOTIFY_TRACK_DISPLAY_LIMIT).map(trackLine)
  if (d.tracks.length > SPOTIFY_TRACK_DISPLAY_LIMIT) {
    trackLines.push(`(…and ${d.trackCount - SPOTIFY_TRACK_DISPLAY_LIMIT} more)`)
  }
  return `--- ${head.join('\n')} ---\nTrack list:\n${trackLines.join('\n')}\n--- end Spotify playlist ---`
}

// Spotify lets owners include limited HTML + entities in playlist
// descriptions. Strip so the AD reads plain text.
function stripPlaylistHtml(s: string): string {
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

export function formatSpotifyTrack(d: SpotifyTrackData): string {
  const head = [`Spotify track: "${d.name}" by ${d.artists.join(', ')} (${d.albumName})`]
  if (d.albumReleaseDate) head.push(`Released: ${d.albumReleaseDate}`)
  if (d.genres.length > 0) head.push(`Genres: ${d.genres.join(', ')}`)
  if (typeof d.popularity === 'number') head.push(`Popularity (0–100): ${d.popularity}`)
  if (d.explicit) head.push('Explicit content')
  if (d.audioFeatures) {
    const af = d.audioFeatures
    head.push(
      `Audio features: energy ${af.energy}, valence ${af.valence}, danceability ${af.danceability}, acousticness ${af.acousticness}, speechiness ${af.speechiness}, tempo ${Math.round(af.tempo)} BPM`,
    )
  }
  return `--- ${head.join('\n')} ---\n--- end Spotify track ---`
}

export function formatSpotifyAlbum(d: SpotifyAlbumData): string {
  const af = d.audioFeatures
  const head = [
    `Spotify album: "${d.name}" by ${d.artists.join(', ')} (${d.releaseDate}, ${d.trackCount} tracks)`,
    `Audio-feature aggregate: energy ${af.avgEnergy}, valence ${af.avgValence}, danceability ${af.avgDanceability}, acousticness ${af.avgAcousticness}, median tempo ${af.medianTempo} BPM`,
  ]
  if (d.topGenres.length > 0) {
    head.push(`Genres: ${d.topGenres.join(', ')}`)
  }
  const eraLine = formatEra(d.era)
  if (eraLine) head.push(eraLine)
  const trackLines = d.tracks.slice(0, SPOTIFY_TRACK_DISPLAY_LIMIT).map(trackLine)
  if (d.tracks.length > SPOTIFY_TRACK_DISPLAY_LIMIT) {
    trackLines.push(`(…and ${d.tracks.length - SPOTIFY_TRACK_DISPLAY_LIMIT} more)`)
  }
  return `--- ${head.join('\n')} ---\nTrack list:\n${trackLines.join('\n')}\n--- end Spotify album ---`
}

export function formatVideoClip(d: VideoClipData): string {
  // The AD only gets framing here (title / channel / platform / duration).
  // The deep read — hooks, transitions, pacing, sound, dialogue — comes from
  // the Senior Video Editor agent (Gemini), which the synthesizer folds in.
  const dur = d.durationSec > 0 ? ` (${formatVideoDuration(d.durationSec)})` : ''
  const platform = d.platform && d.platform !== 'other' ? ` [${d.platform}]` : ''
  const head = `Video: "${d.title || 'Untitled'}"${d.channel ? ` by ${d.channel}` : ''}${dur}${platform}`
  return `--- ${head} ---\n--- end video ---`
}

export function formatVideoDuration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  return `${m}:${r.toString().padStart(2, '0')}`
}
