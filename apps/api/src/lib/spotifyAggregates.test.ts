import { describe, expect, it } from 'vitest'
// Imports the pure aggregation helpers from the db-free module so tests run
// without a DATABASE_URL. The runtime wrappers re-export these from spotify.ts.
import {
  aggregateAudioFeatures,
  aggregateEra,
  aggregateGenres,
  type ArtistInfo,
  type ExtractedTrack,
} from './spotifyAggregates'

// Unit tests for the pure deterministic helpers in spotify.ts. The HTTP
// wrappers themselves are covered by integration tests against a recorded
// Spotify response set elsewhere; this file pins the math down.

describe('aggregateAudioFeatures', () => {
  it('returns zeros for empty input', () => {
    const agg = aggregateAudioFeatures([])
    expect(agg.trackCount).toBe(0)
    expect(agg.avgEnergy).toBe(0)
    expect(agg.medianTempo).toBe(0)
  })

  it('rounds means to three decimal places and tempo to nearest BPM', () => {
    const agg = aggregateAudioFeatures([
      {
        id: 'a',
        energy: 0.111111,
        valence: 0.222222,
        danceability: 0.333333,
        acousticness: 0.4,
        instrumentalness: 0,
        speechiness: 0.05,
        liveness: 0.1,
        tempo: 122.6,
      },
      {
        id: 'b',
        energy: 0.222222,
        valence: 0.444444,
        danceability: 0.666666,
        acousticness: 0.6,
        instrumentalness: 0,
        speechiness: 0.05,
        liveness: 0.1,
        tempo: 124.4,
      },
    ])
    expect(agg.avgEnergy).toBeCloseTo(0.167, 3)
    expect(agg.avgValence).toBeCloseTo(0.333, 3)
    // Median of two values is their mean → 123.5 → rounds to 124.
    expect(agg.medianTempo).toBe(124)
    expect(agg.trackCount).toBe(2)
  })

  it('uses the middle element as median tempo on an odd count', () => {
    const agg = aggregateAudioFeatures([
      mkFeature({ tempo: 90 }),
      mkFeature({ tempo: 120 }),
      mkFeature({ tempo: 200 }),
    ])
    expect(agg.medianTempo).toBe(120)
  })
})

describe('aggregateGenres', () => {
  const artistA: ArtistInfo = { id: 'A', name: 'A', genres: ['pop', 'indie pop'] }
  const artistB: ArtistInfo = { id: 'B', name: 'B', genres: ['pop', 'electronic'] }
  const artistC: ArtistInfo = { id: 'C', name: 'C', genres: ['ambient'] }
  const artists = new Map<string, ArtistInfo>([
    ['A', artistA],
    ['B', artistB],
    ['C', artistC],
  ])

  it('returns the empty list when no tracks have a primary artist', () => {
    const out = aggregateGenres([], artists)
    expect(out).toEqual([])
  })

  it('weights genres by track count, not artist count', () => {
    // 3 tracks by A, 1 by B, 1 by C → pop = 4, indie pop = 3, electronic = 1, ambient = 1
    const tracks: ExtractedTrack[] = [
      mkTrack({ id: 't1', artistIds: ['A'] }),
      mkTrack({ id: 't2', artistIds: ['A'] }),
      mkTrack({ id: 't3', artistIds: ['A'] }),
      mkTrack({ id: 't4', artistIds: ['B'] }),
      mkTrack({ id: 't5', artistIds: ['C'] }),
    ]
    expect(aggregateGenres(tracks, artists)).toEqual(['pop', 'indie pop', 'ambient', 'electronic'])
  })

  it('skips tracks whose primary artist is missing from the artist map', () => {
    const tracks: ExtractedTrack[] = [
      mkTrack({ id: 't1', artistIds: ['A'] }),
      mkTrack({ id: 't2', artistIds: ['ZZZ'] }),
    ]
    expect(aggregateGenres(tracks, artists)).toEqual(['indie pop', 'pop'])
  })

  it('caps the result at TOP_GENRES_CAP (8) entries', () => {
    const bigArtist: ArtistInfo = {
      id: 'X',
      name: 'X',
      genres: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'],
    }
    const tracks = [mkTrack({ id: 't1', artistIds: ['X'] })]
    const out = aggregateGenres(tracks, new Map([['X', bigArtist]]))
    expect(out).toHaveLength(8)
    expect(out).toEqual(['g1', 'g10', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'])
  })
})

describe('aggregateEra', () => {
  it('returns nulls when no tracks have release dates', () => {
    const out = aggregateEra([mkTrack({ id: 't1', artistIds: ['A'] })])
    expect(out.dominantDecade).toBeNull()
    expect(out.yearMin).toBeNull()
    expect(out.yearMax).toBeNull()
    expect(out.decadeBreakdown).toEqual([])
  })

  it('groups ISO dates by decade, surfaces the most-common decade first', () => {
    const tracks: ExtractedTrack[] = [
      mkTrack({ id: 't1', artistIds: ['A'], albumReleaseDate: '1995-01-15' }),
      mkTrack({ id: 't2', artistIds: ['A'], albumReleaseDate: '1998-08-20' }),
      mkTrack({ id: 't3', artistIds: ['A'], albumReleaseDate: '1999' }),
      mkTrack({ id: 't4', artistIds: ['A'], albumReleaseDate: '2003-06-10' }),
      mkTrack({ id: 't5', artistIds: ['A'], albumReleaseDate: '2024-11-01' }),
    ]
    const out = aggregateEra(tracks)
    expect(out.dominantDecade).toBe('1990s')
    expect(out.yearMin).toBe(1995)
    expect(out.yearMax).toBe(2024)
    expect(out.decadeBreakdown).toEqual([
      { decade: '1990s', count: 3 },
      { decade: '2000s', count: 1 },
      { decade: '2020s', count: 1 },
    ])
  })

  it('ignores tracks with malformed release dates rather than skewing the result', () => {
    const tracks: ExtractedTrack[] = [
      mkTrack({ id: 't1', artistIds: ['A'], albumReleaseDate: '1995' }),
      mkTrack({ id: 't2', artistIds: ['A'], albumReleaseDate: 'not-a-date' }),
    ]
    const out = aggregateEra(tracks)
    expect(out.dominantDecade).toBe('1990s')
    expect(out.decadeBreakdown).toEqual([{ decade: '1990s', count: 1 }])
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkTrack(o: Partial<ExtractedTrack> & { id: string; artistIds: string[] }): ExtractedTrack {
  // Spread first so explicit fields below override the defaults.
  return {
    name: 'name',
    artists: ['Artist'],
    durationMs: 200_000,
    ...o,
  }
}

function mkFeature(
  overrides: Partial<{
    id: string
    energy: number
    valence: number
    danceability: number
    acousticness: number
    instrumentalness: number
    speechiness: number
    liveness: number
    tempo: number
  }>,
) {
  return {
    id: overrides.id ?? 'x',
    energy: overrides.energy ?? 0.5,
    valence: overrides.valence ?? 0.5,
    danceability: overrides.danceability ?? 0.5,
    acousticness: overrides.acousticness ?? 0.5,
    instrumentalness: overrides.instrumentalness ?? 0,
    speechiness: overrides.speechiness ?? 0,
    liveness: overrides.liveness ?? 0,
    tempo: overrides.tempo ?? 120,
  }
}
