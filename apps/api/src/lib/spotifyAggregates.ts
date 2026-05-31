// Pure aggregation helpers for Spotify data — extracted from spotify.ts so
// they can be unit-tested without dragging in the db / env-bound modules
// that the HTTP wrappers depend on. The runtime API in spotify.ts
// re-exports from here so existing import paths keep working.

// /v1/artists?ids= caps at 50.
export const ARTISTS_BATCH = 50

// Top-N genres we surface on a playlist/album card.
export const TOP_GENRES_CAP = 8

// Capped slice of a playlist's tracks stored on the canvas object. The
// aggregate (audio features, genres, era) is computed over the *full*
// track set; this cap only bounds the per-track rows we persist for the
// expandable detail view. 100 covers the vast majority of playlists in
// full; longer ones show the first 100 with a "+N more" note.
export const DISPLAY_TRACK_CAP = 100

export type RawAudioFeatures = {
  id: string
  energy: number
  valence: number
  danceability: number
  acousticness: number
  instrumentalness: number
  speechiness: number
  liveness: number
  tempo: number
}

export type AudioFeaturesAgg = {
  avgEnergy: number
  avgValence: number
  avgDanceability: number
  avgAcousticness: number
  avgInstrumentalness: number
  avgSpeechiness: number
  medianTempo: number
  trackCount: number
}

export type ExtractedTrack = {
  id: string
  name: string
  artists: string[]
  artistIds: string[]
  albumName?: string
  albumReleaseDate?: string
  durationMs: number
  explicit?: boolean
  popularity?: number
  previewUrl?: string
}

export type ArtistInfo = {
  id: string
  name: string
  genres: string[]
  popularity?: number
  imageUrl?: string
}

export type EraAgg = {
  dominantDecade: string | null
  decadeBreakdown: { decade: string; count: number }[]
  yearMin: number | null
  yearMax: number | null
}

/** Compute the aggregate signal we surface to the AD over a track set. */
export function aggregateAudioFeatures(features: RawAudioFeatures[]): AudioFeaturesAgg {
  if (features.length === 0) {
    return {
      avgEnergy: 0,
      avgValence: 0,
      avgDanceability: 0,
      avgAcousticness: 0,
      avgInstrumentalness: 0,
      avgSpeechiness: 0,
      medianTempo: 0,
      trackCount: 0,
    }
  }
  const mean = (key: keyof RawAudioFeatures) => {
    let sum = 0
    let n = 0
    for (const f of features) {
      const v = f[key]
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v
        n += 1
      }
    }
    return n > 0 ? sum / n : 0
  }
  const tempos = features
    .map((f) => f.tempo)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
  const medianTempo =
    tempos.length === 0
      ? 0
      : tempos.length % 2 === 1
        ? tempos[(tempos.length - 1) / 2]!
        : (tempos[tempos.length / 2 - 1]! + tempos[tempos.length / 2]!) / 2
  return {
    avgEnergy: round3(mean('energy')),
    avgValence: round3(mean('valence')),
    avgDanceability: round3(mean('danceability')),
    avgAcousticness: round3(mean('acousticness')),
    avgInstrumentalness: round3(mean('instrumentalness')),
    avgSpeechiness: round3(mean('speechiness')),
    medianTempo: Math.round(medianTempo),
    trackCount: features.length,
  }
}

/**
 * Build a track-weighted genre distribution. Every track contributes its
 * primary artist's genres (and only primary — secondary features would
 * skew toward whoever happens to collab a lot). Returns sorted, capped.
 */
export function aggregateGenres(
  tracks: ExtractedTrack[],
  artists: Map<string, ArtistInfo>,
): string[] {
  const counts = new Map<string, number>()
  for (const t of tracks) {
    const primaryId = t.artistIds[0]
    if (!primaryId) continue
    const a = artists.get(primaryId)
    if (!a) continue
    for (const g of a.genres) {
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_GENRES_CAP)
    .map(([g]) => g)
}

/**
 * Derive the dominant decade + decade distribution from per-track album
 * release dates. ISO `YYYY-MM-DD` or just `YYYY` — slice the first 4
 * chars. Tracks without a date are skipped.
 */
export function aggregateEra(tracks: ExtractedTrack[]): EraAgg {
  const counts = new Map<string, number>()
  let yearMin: number | null = null
  let yearMax: number | null = null
  for (const t of tracks) {
    if (!t.albumReleaseDate) continue
    const y = Number.parseInt(t.albumReleaseDate.slice(0, 4), 10)
    if (!Number.isFinite(y)) continue
    const decade = `${Math.floor(y / 10) * 10}s`
    counts.set(decade, (counts.get(decade) ?? 0) + 1)
    if (yearMin === null || y < yearMin) yearMin = y
    if (yearMax === null || y > yearMax) yearMax = y
  }
  if (counts.size === 0) {
    return { dominantDecade: null, decadeBreakdown: [], yearMin: null, yearMax: null }
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([decade, count]) => ({ decade, count }))
  return {
    dominantDecade: sorted[0]!.decade,
    decadeBreakdown: sorted,
    yearMin,
    yearMax,
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
